/**
 * WatchWindowWorld: one desktop window as a video stream. While a window is watched, the engine
 * child samples it at `observe.captureFps` into a pool; an observation event built at delivery
 * time (`pushDeferred`) lays the frames picked since the previous one out as a grid
 * (`capture.ts`), and the main conversation decides whether to say anything. Nothing is sent
 * while the main model does not take images.
 *
 * The window is picked from the WebUI tab or by the bot's tool; the window's edge flashes white
 * when it is picked. Picking, stopping and losing the window from the WebUI or the desktop are
 * reported as `watch-window.state` events; the bot's own picks are answered in the receipt.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childExecArgv } from 'cortico/extensions/runtime.ts';
import type { Logger, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso } from 'cortico/core/util.ts';
import { WATCH_WINDOW_ID, watchWindowConfigGroup, type WatchWindowConfigSection } from './config.ts';
import { WATCH_WINDOW_TOOL_DECLS } from './tools.ts';
import { describeEvents, dhash, gridFor, hamming, meanAbsDiff, selectFrames, type FrameMeta } from './capture.ts';
import { uiText } from './strings.ts';
import type { ChildToMain, EngineRequest, Rect, SampleResult, Unavailable, WindowEntry } from './engine-ipc.ts';

const ENGINE_FILE = fileURLToPath(new URL('./engine-child.ts', import.meta.url));
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const ENGINE_TIMEOUT_MS = 20_000;
/** Samples kept beyond the last observation, so a long model round still has material. */
const SAMPLE_CAP = 600;
/** A window that draws nothing for this many samples in a row is reported. */
const BLANK_REPORT_AFTER = 5;
const IMAGE_MIME = 'image/jpeg';

type Args = Record<string, unknown>;
type By = 'operator' | 'bot';

interface StoredSample extends FrameMeta {
  jpeg: Uint8Array;
  w: number;
  h: number;
}

interface Target {
  handle: string;
  title: string;
  app: string;
}

export interface WatchWindowWorldOptions {
  cfg: WatchWindowConfigSection;
  timezone: string;
}

/** Model-facing words for why a window gives no picture. */
const UNAVAILABLE_TEXT: Record<Unavailable, string> = {
  gone: '窗口已经关掉了',
  minimized: '窗口最小化了,恢复后接着看',
  blank: '窗口没有画出画面(有的游戏切到后台或独占全屏时抓不到,改成无边框窗口、放在前台可以)',
  permission: '没有 macOS 的「屏幕录制」权限,看不到窗口画面;要用户在系统设置里允许运行 Cortico 的应用后重启它',
};

export class WatchWindowWorld implements World {
  readonly id = WATCH_WINDOW_ID;
  private readonly cfg: WatchWindowConfigSection;
  private host: WorldHost | null = null;
  private log: Logger | null = null;

  private engine: ChildProcess | null = null;
  private engineError: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { done: (v: unknown) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  private target: Target | null = null;
  private startedAt = 0;
  private unavailable: Unavailable | null = null;
  private unavailableReported = false;
  private blankRun = 0;
  private sampling = false;
  private samples: StoredSample[] = [];
  private prevGray: Uint8Array | null = null;
  private prevMafd = 0;
  private lastObservedT = 0;
  private lastObservedAt = 0;
  private lastDeliveredHash: string | null = null;
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  private observeTimer: ReturnType<typeof setTimeout> | null = null;
  private observeQueued = false;
  private noImage = false;
  private lastMontage: { jpeg: Uint8Array; at: string; cells: number } | null = null;
  private sceneCount = 0;
  private lastList: WindowEntry[] = [];

  constructor(private readonly opts: WatchWindowWorldOptions) {
    this.cfg = opts.cfg;
  }

  /* ---------- lifecycle ---------- */

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.log = host.log;
    this.noImage = !this.acceptsImages();
  }

  async stop(): Promise<void> {
    this.stopWatching();
    this.host = null;
    const child = this.engine;
    this.engine = null;
    if (child) { child.disconnect?.(); child.kill(); }
  }

  /* ---------- engine ---------- */

  private spawn(): ChildProcess {
    const child = fork(ENGINE_FILE, [], { execArgv: childExecArgv(), serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const log = this.log?.child('engine');
    const forward = (d: Buffer) => { for (const line of d.toString().split(/\r?\n/)) if (line.trim()) log?.warn(line); };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.on('message', (msg: ChildToMain) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.done(msg.value);
      else p.fail(new Error(msg.error));
    });
    child.on('exit', (code) => {
      if (this.engine === child) this.engine = null;
      this.engineError = code === 0 || code === null ? null : `抓图进程退出(退出码 ${code})`;
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.fail(new Error(this.engineError ?? '抓图进程已退出')); this.pending.delete(id); }
    });
    return child;
  }

  private call<T>(req: EngineRequest): Promise<T> {
    if (!this.engine) { this.engine = this.spawn(); this.engineError = null; }
    const child = this.engine;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`抓图进程 ${ENGINE_TIMEOUT_MS / 1000} 秒没有回应`)); }, ENGINE_TIMEOUT_MS);
      this.pending.set(id, { done: resolve as (v: unknown) => void, fail: reject, timer });
      child.send({ id, req });
    });
  }

  private acceptsImages(): boolean {
    try { return this.host?.modelFacts.accepts(IMAGE_MIME) ?? false; } catch { return false; }
  }

  /* ---------- watching ---------- */

  private async listWindows(): Promise<{ windows: WindowEntry[]; permission: boolean }> {
    const r = await this.call<{ windows: WindowEntry[]; permission: boolean }>({ op: 'windows' });
    return r;
  }

  private async watch(w: WindowEntry, by: By): Promise<string> {
    this.stopWatching();
    this.target = { handle: w.handle, title: w.title, app: w.app };
    this.startedAt = Date.now();
    this.lastObservedAt = Date.now();
    this.lastObservedT = 0;
    this.lastDeliveredHash = null;
    this.unavailable = null;
    this.unavailableReported = false;
    this.blankRun = 0;
    const period = Math.max(250, Math.round(1000 / Math.max(0.2, this.cfg.observe.captureFps)));
    this.captureTimer = setInterval(() => { void this.capture(); }, period);
    this.captureTimer.unref?.();
    void this.capture();
    this.armObservation();
    if (this.cfg.flash) this.call({ op: 'flash', handle: w.handle }).catch((err: Error) => this.log?.warn('watch-window flash failed', { err: err.message }));
    const name = `「${w.title}」${w.app && w.app !== w.title ? `(${w.app})` : ''}`;
    if (by === 'operator') this.pushState(`[盯盯窗口] 界面上选了窗口${name},开始盯着看。`);
    const notes = [w.minimized ? '它现在是最小化的,恢复后才有画面。' : '', this.noImage ? '当前主模型不收图片,观察帧先不送。' : ''].filter(Boolean).join('');
    return `开始盯${name},大约每 ${this.cfg.observe.minIntervalSec} 秒收到一张观察帧。${notes}`;
  }

  private stopWatching(): void {
    if (this.captureTimer) clearInterval(this.captureTimer);
    this.captureTimer = null;
    if (this.observeTimer) clearTimeout(this.observeTimer);
    this.observeTimer = null;
    this.observeQueued = false;
    this.target = null;
    this.samples = [];
    this.prevGray = null;
    this.prevMafd = 0;
    this.unavailable = null;
  }

  private now(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  private async capture(): Promise<void> {
    const target = this.target;
    if (!target || this.sampling) return;
    this.sampling = true;
    try {
      const o = this.cfg.observe;
      const t = this.now();
      const r = await this.call<SampleResult>({ op: 'sample', handle: target.handle, maxWidth: o.cellWidth, maxHeight: o.cellHeight, quality: o.jpegQuality });
      if (this.target !== target) return;
      if (!r.ok) return this.onUnavailable(target, r.reason);
      if (this.unavailable) {
        if (this.unavailableReported && this.unavailable !== 'blank') this.pushState(`[盯盯窗口] 「${target.title}」又有画面了。`);
        this.unavailable = null;
        this.unavailableReported = false;
      }
      this.blankRun = 0;
      const s = r.sample;
      const luma = s.gray.reduce((a, b) => a + b, 0) / s.gray.length;
      const mafd = this.prevGray ? meanAbsDiff(this.prevGray, s.gray) : 0;
      // a cut is a jump in frame difference, not a large difference: steady motion keeps mafd level
      const diff = Math.min(mafd, Math.abs(mafd - this.prevMafd));
      this.prevMafd = mafd;
      this.prevGray = s.gray;
      this.samples.push({ t, jpeg: s.jpeg, w: s.width, h: s.height, hash: dhash(s.gray, 64, 36), luma, diff });
      if (this.samples.length > SAMPLE_CAP) this.samples.splice(0, this.samples.length - SAMPLE_CAP);
    } catch (err) {
      this.log?.warn('watch-window sample failed', { err: (err as Error).message });
    } finally {
      this.sampling = false;
    }
  }

  private onUnavailable(target: Target, reason: Unavailable): void {
    if (reason === 'gone') {
      this.stopWatching();
      this.pushState(`[盯盯窗口] 盯着的窗口「${target.title}」关掉了,不再盯看。`);
      return;
    }
    if (reason === 'blank' && ++this.blankRun < BLANK_REPORT_AFTER) return;
    if (this.unavailable === reason && this.unavailableReported) return;
    this.unavailable = reason;
    this.unavailableReported = true;
    this.pushState(`[盯盯窗口] 「${target.title}」:${UNAVAILABLE_TEXT[reason]}。`);
  }

  private pushState(text: string): void {
    if (!this.host) return;
    void this.host.pushEvent({ type: 'watch-window.state', source: this.id, ts: nowIso(this.opts.timezone), text, senderKey: this.id }, { trigger: 'flush' });
  }

  private armObservation(): void {
    if (this.observeTimer || this.observeQueued || !this.target) return;
    const wait = Math.max(0, this.cfg.observe.minIntervalSec * 1000 - (Date.now() - this.lastObservedAt));
    this.observeTimer = setTimeout(() => {
      this.observeTimer = null;
      if (!this.target || !this.host) return;
      this.noImage = !this.acceptsImages();
      if (this.noImage) {
        // nothing goes out until the model takes images; look again after another interval
        this.lastObservedAt = Date.now();
        this.armObservation();
        return;
      }
      this.observeQueued = true;
      this.host.pushDeferred({ type: 'watch-window.scene', senderKey: this.id, render: () => this.renderScene() }, { trigger: 'debounce' });
    }, wait);
    this.observeTimer.unref?.();
  }

  /** Builds the observation at delivery time, then arms the next one. */
  private async renderScene(): Promise<{ text: string; blobs: Array<{ bytes: Uint8Array; mime: string; name: string; fallbackText: string }> } | null> {
    this.observeQueued = false;
    const target = this.target;
    try {
      if (!target) return null;
      const o = this.cfg.observe;
      const t0 = this.lastObservedT;
      const pool = this.samples.filter((s) => s.t > t0);
      if (!pool.length) return null;
      const t1 = pool[pool.length - 1].t;
      const advance = () => {
        this.lastObservedT = t1;
        this.lastObservedAt = Date.now();
        this.samples = this.samples.filter((s) => s.t > t1 - 1);
      };
      const last = this.lastDeliveredHash;
      if (o.skipStill && last && pool.every((s) => hamming(s.hash, last) < o.dedupeHamming)) {
        advance();
        return null;
      }
      const gap = Math.max(0.5, t1 - t0);
      const chosen = selectFrames(pool, gap, o).map((i) => pool[i]);
      const grid = gridFor(chosen.length);
      const m = await this.call<{ jpeg: Uint8Array; width: number; height: number }>({ op: 'montage', jpegs: chosen.map((c) => c.jpeg), cols: grid.cols, rows: grid.rows, cellWidth: o.cellWidth, cellHeight: o.cellHeight, quality: o.jpegQuality });
      if (this.target !== target) return null;
      advance();
      this.lastDeliveredHash = chosen[chosen.length - 1].hash;
      this.sceneCount++;
      this.lastMontage = { jpeg: m.jpeg, at: new Date().toISOString(), cells: chosen.length };

      const info = await this.call<WindowEntry | null>({ op: 'info', handle: target.handle }).catch(() => null);
      const lines: string[] = [];
      lines.push(`[盯盯窗口] 「${target.title}」${target.app && target.app !== target.title ? `(${target.app})` : ''} ${this.clock(t0 || pool[0].t)}–${this.clock(t1)}`);
      if (info && info.title !== target.title) {
        lines.push(`窗口标题现在是「${info.title}」`);
        target.title = info.title;
      }
      const times = chosen.map((c, i) => `${this.clock(c.t)}${i === chosen.length - 1 ? '(最新)' : ''}`).join('、');
      lines.push(chosen.length === 1 ? `画面 1 格:${times}` : `画面 ${chosen.length} 格(${grid.cols}×${grid.rows},左→右、上→下):${times}`);
      const events = describeEvents(pool, o, (t) => this.clock(t));
      if (events.length) lines.push(`检测:${events.join(';')}`);
      return { text: lines.join('\n'), blobs: [{ bytes: m.jpeg, mime: IMAGE_MIME, name: `scene-${this.sceneCount}.jpg`, fallbackText: `窗口画面拼图 ${chosen.length} 格` }] };
    } catch (err) {
      this.log?.warn('watch-window scene render failed', { err: (err as Error).message });
      return null;
    } finally {
      this.armObservation();
    }
  }

  /** Wall-clock time of a sample, HH:MM:SS in the deployment's time zone. */
  private clock(t: number): string {
    return new Date(this.startedAt + t * 1000).toLocaleTimeString('zh-CN', { timeZone: this.opts.timezone, hour12: false });
  }

  /* ---------- tools ---------- */

  tools(): ToolDef[] {
    const handlers: Record<string, (args: Args) => Promise<ToolOutcome>> = {
      watch_window_pick: (a) => this.pickTool(a),
      watch_window_stop: async () => {
        if (!this.target) return { text: '本来就没在盯窗口。' };
        const title = this.target.title;
        this.stopWatching();
        return { text: `不再盯「${title}」。` };
      },
      watch_window_look: (a) => this.look(a),
    };
    return WATCH_WINDOW_TOOL_DECLS.map((decl) => ({
      ...decl,
      handler: async (args: Args) => {
        try {
          return await handlers[decl.name](args);
        } catch (err) {
          return { text: `[${decl.name} 失败] ${(err as Error).message}`, failed: true };
        }
      },
    }));
  }

  private listText(list: readonly WindowEntry[]): string {
    if (!list.length) return '现在没有能看的窗口。';
    return list.map((w, i) => {
      const marks = [w.foreground ? '前台' : '', w.minimized ? '最小化' : '', this.target?.handle === w.handle ? '正在盯' : ''].filter(Boolean);
      return `${i + 1}. 「${w.title}」 ${w.app} ${w.rect.width}×${w.rect.height}${marks.length ? ` [${marks.join('、')}]` : ''}`;
    }).join('\n');
  }

  private async pickTool(args: Args): Promise<ToolOutcome> {
    const target = typeof args.target === 'string' ? args.target.trim() : '';
    if (!target) {
      const r = await this.listWindows();
      this.lastList = r.windows;
      if (!r.permission) return { text: UNAVAILABLE_TEXT.permission, failed: true };
      return { text: `能看的窗口(前面的在上层):\n${this.listText(r.windows)}` };
    }
    let w: WindowEntry | null | undefined;
    if (/^front$/i.test(target)) {
      w = await this.call<WindowEntry | null>({ op: 'foreground' });
      if (!w) return { text: '前台现在不是一个能看的窗口。', failed: true };
    } else if (/^\d+$/.test(target)) {
      if (!this.lastList.length) this.lastList = (await this.listWindows()).windows;
      w = this.lastList[Number(target) - 1];
      if (!w) return { text: `列表里没有第 ${target} 个窗口:\n${this.listText(this.lastList)}`, failed: true };
      const fresh = await this.call<WindowEntry | null>({ op: 'info', handle: w.handle });
      if (!fresh) return { text: `第 ${target} 个窗口已经关掉了。`, failed: true };
      w = fresh;
    } else {
      const r = await this.listWindows();
      this.lastList = r.windows;
      const q = target.toLowerCase();
      const hits = r.windows.filter((x) => x.title.toLowerCase().includes(q) || x.app.toLowerCase().includes(q));
      const exact = hits.filter((x) => x.title.toLowerCase() === q || x.app.toLowerCase() === q);
      if (hits.length === 1) w = hits[0];
      else if (exact.length === 1) w = exact[0];
      else if (!hits.length) return { text: `没有标题或程序名含「${target}」的窗口:\n${this.listText(r.windows)}`, failed: true };
      else return { text: `含「${target}」的窗口有 ${hits.length} 个,用编号选:\n${this.listText(r.windows)}`, failed: true };
    }
    return { text: await this.watch(w, 'bot') };
  }

  private async look(args: Args): Promise<ToolOutcome> {
    const target = this.target;
    if (!target) return { text: '没在盯窗口;先选一个窗口。', failed: true };
    const nums = [args.x, args.y, args.width, args.height];
    const region: Rect | undefined = nums.every((n) => typeof n === 'number')
      ? { x: clamp01(args.x as number), y: clamp01(args.y as number), width: clamp01(args.width as number), height: clamp01(args.height as number) }
      : undefined;
    const l = this.cfg.look;
    const r = await this.call<SampleResult>({ op: 'sample', handle: target.handle, maxWidth: l.maxWidth, maxHeight: l.maxHeight, quality: Math.max(this.cfg.observe.jpegQuality, 0.85), region });
    if (!r.ok) return { text: `看不到「${target.title}」:${UNAVAILABLE_TEXT[r.reason]}。`, failed: true };
    const where = region ? `区域 (${region.x.toFixed(2)}, ${region.y.toFixed(2)}) ${region.width.toFixed(2)}×${region.height.toFixed(2)}` : '整个窗口';
    return {
      text: `「${target.title}」现在的画面,${where},${r.sample.width}×${r.sample.height}。`,
      blobs: [{ bytes: r.sample.jpeg, mime: IMAGE_MIME, name: 'look.jpg', fallbackText: `窗口画面 ${r.sample.width}×${r.sample.height}` }],
    };
  }

  /* ---------- prompt & WebUI ---------- */

  private stateLine(): string {
    const t = this.target;
    if (!t) return '没在盯窗口';
    const name = `「${t.title}」${t.app && t.app !== t.title ? `(${t.app})` : ''}`;
    if (this.unavailable) return `盯着${name},但${UNAVAILABLE_TEXT[this.unavailable]}`;
    return `正在盯${name}`;
  }

  envPromptVars(): Record<string, string> {
    return {
      'watchWindow.state': this.stateLine(),
      'watchWindow.intervalSec': String(this.cfg.observe.minIntervalSec),
    };
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = uiText(language);
    const reason = this.unavailable ? t[this.unavailable] : null;
    return {
      label: t.label,
      lamps: [
        {
          label: t.lampWindow,
          state: !this.target ? 'offline' : this.unavailable === 'minimized' ? 'loading' : this.unavailable || this.engineError ? 'error' : 'online',
          hint: this.engineError ?? (this.target ? `${this.target.title}${reason ? ` · ${reason}` : ''}` : t.nothing),
        },
        { label: t.lampImage, state: this.noImage ? 'error' : 'online', hint: this.noImage ? t.noImage : t.imageOk },
      ],
      badges: [
        { label: t.stateLabel, value: this.target ? t.watching : t.idle, tone: this.target ? 'on' : 'plain' },
        { label: t.scenes, value: this.sceneCount, tone: 'plain' },
      ],
      panels: [{ id: 'watch', title: t.panelTitle, description: t.panelDesc, getMethods: ['montage'] }],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      config: [watchWindowConfigGroup(language)],
      promptDocs: [{
        key: `worlds.${WATCH_WINDOW_ID}.envPrompt`,
        title: '盯盯窗口环境',
        description: '能盯一个窗口、观察帧的读法、说话的分寸。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'watchWindow.state', description: '在盯哪个窗口,或没在盯' },
          { name: 'watchWindow.intervalSec', description: '观察帧最短间隔(秒)' },
        ],
      }],
    };
  }

  private async invoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel !== 'watch') throw new Error(`unknown panel ${panel}`);
    switch (method) {
      case 'state': {
        this.noImage = !this.acceptsImages();
        return {
          target: this.target,
          unavailable: this.unavailable,
          noImage: this.noImage,
          engineError: this.engineError,
          scenes: this.sceneCount,
          samples: this.samples.length,
          intervalSec: this.cfg.observe.minIntervalSec,
          lastMontageAt: this.lastMontage?.at ?? null,
          lastMontageCells: this.lastMontage?.cells ?? 0,
        };
      }
      case 'windows': return this.listWindows();
      case 'pick': {
        const handle = String(args[0] ?? '');
        const w = await this.call<WindowEntry | null>({ op: 'info', handle });
        if (!w) throw new Error(uiText('zh').gone);
        await this.watch(w, 'operator');
        return { ok: true, title: w.title };
      }
      case 'pick-front': {
        const w = await this.call<WindowEntry | null>({ op: 'foreground' });
        if (!w) return { ok: false };
        await this.watch(w, 'operator');
        return { ok: true, title: w.title };
      }
      case 'stop': {
        const title = this.target?.title;
        this.stopWatching();
        if (title) this.pushState(`[盯盯窗口] 界面上停止了盯看「${title}」。`);
        return { ok: true };
      }
      case 'montage': {
        if (!this.lastMontage) throw new Error('no observation yet');
        return { $binary: { mime: IMAGE_MIME, base64: Buffer.from(this.lastMontage.jpeg).toString('base64') } };
      }
    }
    throw new Error(`unknown method ${panel}/${method}`);
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
