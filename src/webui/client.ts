/**
 * WebUI panel `watch`: what is watched now, the window list to pick from, a delayed pick of the
 * front window, and the latest observation grid. Server response shapes are declared here; the
 * browser side imports no Node module.
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { uiText } from '../strings.ts';
import type { Unavailable, WindowEntry } from '../engine-ipc.ts';

interface WatchState {
  target: { handle: string; title: string; app: string } | null;
  unavailable: Unavailable | null;
  noImage: boolean;
  engineError: string | null;
  scenes: number;
  samples: number;
  intervalSec: number;
  lastMontageAt: string | null;
  lastMontageCells: number;
}

const FRONT_DELAY_S = 3;

const watchPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;
    const t = uiText(ctx.language);

    const card = ui.sheet({ title: t.panelTitle, desc: t.panelDesc });
    root.appendChild(card.el);

    const bar = ui.rowbar();
    const status = ui.h('span');
    const frontBtn = ui.button(t.pickFront, { variant: 'primary', onClick: () => void pickFront() });
    const stopBtn = ui.button(t.stop, { variant: 'danger', onClick: () => void act(() => ctx.invoke('stop')) });
    bar.append(status, ui.h('span', 'grow'), frontBtn, stopBtn);
    const note = ui.msgline();
    const err = ui.msgline();
    card.body.append(bar, note, err);

    const listBar = ui.rowbar();
    listBar.append(ui.h('span', 'grow'), ui.button(t.refresh, { size: 'sm', onClick: () => void loadWindows() }));
    const table = ui.table({ head: [t.colWindow, t.colApp, t.colSize, ''], maxHeight: '360px' });
    card.body.append(listBar, table.el);

    const shotTitle = ui.h('div', null, t.lastScene);
    shotTitle.style.marginTop = '16px';
    const shotNote = ui.msgline(t.noScene);
    const img = ui.h('img');
    img.alt = t.lastScene;
    img.style.maxWidth = '100%';
    img.style.marginTop = '8px';
    img.hidden = true;
    card.body.append(shotTitle, shotNote, img);

    let state: WatchState | null = null;
    let shownAt: string | null = null;
    let url: string | null = null;
    let windows: WindowEntry[] = [];
    let counting = false;
    ctx.own({ dispose: () => { if (url) URL.revokeObjectURL(url); } });

    const act = async (fn: () => Promise<unknown>) => {
      err.textContent = '';
      const hold = ui.disable(frontBtn, stopBtn);
      try {
        await fn();
        await load();
        await loadWindows();
      } catch (e) {
        err.textContent = String(e);
      } finally {
        hold.dispose();
      }
    };

    const pickFront = async () => {
      err.textContent = '';
      const hold = ui.disable(frontBtn);
      counting = true;
      try {
        for (let n = FRONT_DELAY_S; n > 0; n--) {
          note.textContent = t.countdown.replace('{n}', String(n));
          await new Promise((r) => setTimeout(r, 1000));
          if (ctx.signal.aborted) return;
        }
        counting = false;
        note.textContent = '';
        const r = await ctx.invoke<{ ok: boolean; title?: string }>('pick-front');
        if (r.ok && r.title) ui.toast(`${t.current}: ${r.title}`, 'ok');
        else err.textContent = t.empty;
        await load();
        await loadWindows();
      } catch (e) {
        err.textContent = String(e);
      } finally {
        counting = false;
        hold.dispose();
      }
    };

    const renderWindows = () => {
      if (!windows.length) { table.clear(t.empty); return; }
      table.clear();
      for (const w of windows) {
        const name = ui.h('span');
        name.append(ui.h('span', null, w.title));
        const tags: Array<[string, 'on' | 'off' | 'plain']> = [];
        if (state?.target?.handle === w.handle) tags.push([t.tagWatching, 'on']);
        if (w.foreground) tags.push([t.tagFront, 'plain']);
        if (w.minimized) tags.push([t.tagMinimized, 'off']);
        for (const [text, tone] of tags) { const p = ui.pill(text, tone); p.style.marginLeft = '6px'; name.append(p); }
        const btn = ui.button(t.pick, { size: 'sm', onClick: () => void act(() => ctx.invoke('pick', [w.handle])) });
        btn.disabled = state?.target?.handle === w.handle;
        btn.style.whiteSpace = 'nowrap';
        table.addRow([name, w.app, { text: `${w.rect.width}×${w.rect.height}`, cls: 'mono' }, btn]);
      }
    };

    const loadWindows = async () => {
      const r = await ctx.invoke<{ windows: WindowEntry[]; permission: boolean }>('windows');
      if (ctx.signal.aborted) return;
      windows = r.windows;
      if (!r.permission) err.textContent = t.permission;
      renderWindows();
    };

    const load = async () => {
      const s = await ctx.invoke<WatchState>('state');
      if (ctx.signal.aborted) return;
      const changed = s.target?.handle !== state?.target?.handle;
      state = s;
      status.replaceChildren();
      if (s.target) {
        status.append(ui.pill(t.current, 'on'), ui.h('span', null, ` ${s.target.title}`));
      } else {
        status.append(ui.pill(t.nothing, 'off'));
      }
      stopBtn.disabled = !s.target;
      const notes = [s.engineError ?? '', s.unavailable ? t[s.unavailable] : '', s.target && s.noImage ? t.noImage : ''].filter(Boolean);
      if (!counting) note.textContent = notes.join(' · ');
      if (changed) renderWindows();
      if (s.lastMontageAt && s.lastMontageAt !== shownAt) {
        shownAt = s.lastMontageAt;
        const blob = await ctx.invokeBinary('montage');
        if (ctx.signal.aborted) return;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(blob);
        img.src = url;
        img.hidden = false;
        shotNote.textContent = `${new Date(s.lastMontageAt).toLocaleTimeString()} · ${s.lastMontageCells}`;
      }
    };

    ctx.interval(() => { void load().catch((e: unknown) => { err.textContent = String(e); }); }, 2000);
    void load().then(loadWindows).catch((e: unknown) => { err.textContent = String(e); });
  },
};

const bundle: WebUiClientBundle = { panels: { watch: watchPanel } };

export default bundle;
