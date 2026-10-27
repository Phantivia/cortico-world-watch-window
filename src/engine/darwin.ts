/**
 * macOS access, the same surface as `win32.ts`: the on-screen window list from
 * CGWindowListCopyWindowInfo, a window's picture through the system's `screencapture -l`, and the
 * glow around a picked window drawn by a short JXA script (`osascript -l JavaScript`). Runs only
 * inside the engine child process.
 *
 * macOS shows other apps' window titles and pictures only to an app allowed under Privacy &
 * Security → Screen Recording. That permission belongs to the app that runs Cortico (Coopanion,
 * or the terminal); until it is given, sampling reports `permission`. Coordinates are points of
 * the global display space, top-left origin.
 */
import koffi from 'koffi';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FLASH_MS, GLOW_IN, GLOW_OUT, crop, decodeJpeg, fit, grayThumb, isFlat, regionPixels, resize, type Box } from './image.ts';
import type { Rect, Unavailable, WindowEntry } from '../engine-ipc.ts';

const run = promisify(execFile);

const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');

const CGRect = koffi.struct('CGRect', { x: 'double', y: 'double', width: 'double', height: 'double' });

const CGPreflightScreenCaptureAccess = cg.func('bool CGPreflightScreenCaptureAccess()');
const CGRequestScreenCaptureAccess = cg.func('bool CGRequestScreenCaptureAccess()');
const CGWindowListCopyWindowInfo = cg.func('void *CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)');
const CGRectMakeWithDictionaryRepresentation = cg.func('bool CGRectMakeWithDictionaryRepresentation(void *dict, _Out_ CGRect *rect)');
const CFRelease = cf.func('void CFRelease(void *ref)');
const CFArrayGetCount = cf.func('long CFArrayGetCount(void *array)');
const CFArrayGetValueAtIndex = cf.func('void *CFArrayGetValueAtIndex(void *array, long index)');
const CFDictionaryGetValue = cf.func('void *CFDictionaryGetValue(void *dict, void *key)');
const CFStringCreateWithCString = cf.func('void *CFStringCreateWithCString(void *alloc, const char *s, uint32_t encoding)');
const CFStringGetCString = cf.func('bool CFStringGetCString(void *s, uint8_t *buf, long size, uint32_t encoding)');
const CFNumberGetValue = cf.func('bool CFNumberGetValue(void *n, long type, _Out_ int64_t *value)');

const UTF8 = 0x08000100;
const kCFNumberSInt64Type = 4;
/** kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements */
const ON_SCREEN = 1 | 16;
/** kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements: also windows minimized to the Dock. */
const ALL = 0 | 16;

const keys = new Map<string, unknown>();
function key(name: string): unknown {
  let k = keys.get(name);
  if (!k) { k = CFStringCreateWithCString(null, name, UTF8); keys.set(name, k); }
  return k;
}

function str(dict: unknown, name: string): string {
  const v = CFDictionaryGetValue(dict, key(name));
  if (!v) return '';
  const buf = new Uint8Array(2048);
  return CFStringGetCString(v, buf, buf.length, UTF8) ? Buffer.from(buf.subarray(0, buf.indexOf(0))).toString('utf8') : '';
}

function num(dict: unknown, name: string): number | null {
  const v = CFDictionaryGetValue(dict, key(name));
  if (!v) return null;
  const out = [0n];
  return CFNumberGetValue(v, kCFNumberSInt64Type, out) ? Number(out[0]) : null;
}

export function permitted(): boolean {
  return CGPreflightScreenCaptureAccess();
}

/** Asks once for Screen Recording; the system shows its prompt the first time. */
export function requestPermission(): boolean {
  return CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess();
}

interface Raw { id: number; pid: number; app: string; title: string; rect: Rect; layer: number; onScreen: boolean }

function list(option: number): Raw[] {
  const arr = CGWindowListCopyWindowInfo(option, 0);
  if (!arr) return [];
  const out: Raw[] = [];
  try {
    const n = Number(CFArrayGetCount(arr));
    for (let i = 0; i < n; i++) {
      const d = CFArrayGetValueAtIndex(arr, i);
      const r = { x: 0, y: 0, width: 0, height: 0 };
      const b = CFDictionaryGetValue(d, key('kCGWindowBounds'));
      if (b) CGRectMakeWithDictionaryRepresentation(b, r);
      out.push({
        id: num(d, 'kCGWindowNumber') ?? 0,
        pid: num(d, 'kCGWindowOwnerPID') ?? 0,
        app: str(d, 'kCGWindowOwnerName'),
        title: str(d, 'kCGWindowName'),
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        layer: num(d, 'kCGWindowLayer') ?? 0,
        onScreen: (num(d, 'kCGWindowIsOnscreen') ?? 0) !== 0,
      });
    }
  } finally {
    CFRelease(arr);
  }
  return out;
}

/** Normal windows (layer 0) of other apps, front to back. Without Screen Recording titles come back empty. */
function normal(option: number): Raw[] {
  return list(option).filter((w) => w.layer === 0 && w.pid !== process.pid && w.rect.width >= 32 && w.rect.height >= 32);
}

function toEntry(w: Raw, front: number | undefined): WindowEntry {
  return { handle: String(w.id), title: w.title || w.app, app: w.app, rect: w.rect, minimized: !w.onScreen, foreground: w.id === front };
}

export function windows(): WindowEntry[] {
  const shown = normal(ON_SCREEN);
  return shown.map((w) => toEntry(w, shown[0]?.id));
}

export function foreground(): WindowEntry | null {
  const front = normal(ON_SCREEN)[0];
  return front ? toEntry(front, front.id) : null;
}

export function info(handle: string): WindowEntry | null {
  const all = normal(ALL);
  const w = all.find((x) => String(x.id) === handle);
  return w ? toEntry(w, normal(ON_SCREEN)[0]?.id) : null;
}

export type Grab = { ok: true; rgba: Uint8Array; width: number; height: number; gray: Uint8Array } | { ok: false; reason: Unavailable; detail?: string };

export async function grab(handle: string, maxWidth: number, maxHeight: number, region?: Box): Promise<Grab> {
  if (!permitted()) return { ok: false, reason: 'permission' };
  const w = info(handle);
  if (!w) return { ok: false, reason: 'gone' };
  if (w.minimized) return { ok: false, reason: 'minimized' };
  const dir = mkdtempSync(join(tmpdir(), 'watch-window-'));
  const file = join(dir, 'w.jpg');
  try {
    // -l: that window only, even behind others; -o: no shadow; -x: no sound
    await run('/usr/sbin/screencapture', ['-x', '-o', `-l${handle}`, '-t', 'jpg', file], { timeout: 10_000 });
    const img = decodeJpeg(readFileSync(file));
    let px = img.rgba, width = img.width, height = img.height;
    if (region) {
      const c = crop(px, width, height, regionPixels(region, width, height));
      px = c.pixels; width = c.width; height = c.height;
    }
    const size = fit(width, height, maxWidth, maxHeight);
    const rgba = size.width === width && size.height === height ? px : resize(px, width, height, size, 'rgba');
    const gray = grayThumb(rgba, size.width, size.height);
    if (isFlat(gray)) return { ok: false, reason: 'blank' };
    return { ok: true, rgba, ...size, gray };
  } catch (err) {
    return { ok: false, reason: 'blank', detail: (err as Error).message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Draws the glow in a borderless, click-through window above everything (including full-screen
 * spaces) and hidden from screen capture; NSWindow's origin is the main screen's bottom-left.
 */
const FLASH_SCRIPT = String.raw`
ObjC.import('Cocoa');
function run(argv) {
  const [x, y, w, h, pad, inner, ms] = argv.map(Number);
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1);
  const H = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
  const W2 = w + 2 * pad, H2 = h + 2 * pad;
  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(x - pad, H - (y + h) - pad, W2, H2), 0, 2, false);
  win.setOpaque(false);
  win.setBackgroundColor($.NSColor.clearColor);
  win.setHasShadow(false);
  win.setIgnoresMouseEvents(true);
  win.setLevel(1000);
  win.setSharingType(0);
  win.setCollectionBehavior(1 | 16 | 256);
  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(W2, H2));
  img.lockFocus;
  for (let d = pad; d >= 1; d -= 1) {
    const a = Math.pow(1 - d / pad, 2) * 0.5;
    $.NSColor.colorWithCalibratedWhiteAlpha(1, a).setStroke;
    const p = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(pad - d, pad - d, w + 2 * d, h + 2 * d), 10 + d, 10 + d);
    p.setLineWidth(1.5);
    p.stroke;
  }
  for (let d = 0; d < inner; d += 1) {
    const a = Math.pow(1 - d / inner, 2) * 0.35;
    $.NSColor.colorWithCalibratedWhiteAlpha(1, a).setStroke;
    const p = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(pad + d, pad + d, w - 2 * d, h - 2 * d), 10, 10);
    p.setLineWidth(1.5);
    p.stroke;
  }
  img.unlockFocus;
  const view = $.NSImageView.alloc.initWithFrame($.NSMakeRect(0, 0, W2, H2));
  view.setImage(img);
  win.setContentView(view);
  win.setAlphaValue(0);
  win.orderFrontRegardless;
  const pulse = (u, t0, rise, hold, fall) => { u -= t0; if (u < 0 || u > rise + hold + fall) return 0; if (u < rise) return u / rise; if (u < rise + hold) return 1; return 1 - (u - rise - hold) / fall; };
  const start = Date.now();
  for (let t = 0; t <= ms; t = Date.now() - start) {
    win.setAlphaValue(Math.max(pulse(t, 0, 120, 120, 260), pulse(t, 520, 120, 200, 620)));
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.016));
  }
  win.orderOut(null);
}
`;

export async function flash(handle: string): Promise<void> {
  const w = info(handle);
  if (!w || w.minimized) return;
  const r = w.rect;
  await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', FLASH_SCRIPT, String(r.x), String(r.y), String(r.width), String(r.height), String(GLOW_OUT), String(GLOW_IN), String(FLASH_MS)], { timeout: 10_000 });
}
