/**
 * Linux (X11) access through koffi on libX11 and libXext, the same surface as `win32.ts`: the
 * top-level window list, a window's picture, and the glow drawn inside a picked window's edge.
 * Runs only inside the engine child process. Wayland sessions are refused before the World
 * starts (`definition.ts`): a Wayland client cannot see other applications' windows.
 *
 * The window list comes from the window manager (`_NET_CLIENT_LIST_STACKING`), or, when the
 * window manager publishes none, from the root window's children that carry `WM_STATE`. A
 * window's picture is `XGetImage` on the window itself; under a compositing manager that is the
 * window's own buffer even behind other windows, without one only what is on screen.
 *
 * The glow is an override-redirect window that takes no input. With a compositing manager it is
 * a 32-bit ARGB window faded through `_NET_WM_WINDOW_OPACITY`; without one, X11 has no
 * translucency and it is a thin white band shaped to the edge, shown at each pulse. X11 cannot
 * keep a window out of other captures, so sampling waits while the glow is up (`engine-child.ts`).
 */
import koffi from 'koffi';
import { readFileSync } from 'node:fs';
import { FLASH_MS, GLOW_IN, crop, fit, flashAlpha, glowPixels, grayThumb, isFlat, regionPixels, resize, type Box } from './image.ts';
import type { Rect, Unavailable, WindowEntry } from '../engine-ipc.ts';

const x11 = koffi.load('libX11.so.6');
const xext = koffi.load('libXext.so.6');

const XWindowAttributes = koffi.struct('XWindowAttributes', {
  x: 'int', y: 'int', width: 'int', height: 'int', border_width: 'int', depth: 'int', visual: 'void *', root: 'unsigned long',
  class: 'int', bit_gravity: 'int', win_gravity: 'int', backing_store: 'int', backing_planes: 'unsigned long', backing_pixel: 'unsigned long',
  save_under: 'int', colormap: 'unsigned long', map_installed: 'int', map_state: 'int', all_event_masks: 'long', your_event_mask: 'long',
  do_not_propagate_mask: 'long', override_redirect: 'int', screen: 'void *',
});
const XImage = koffi.struct('XImage', {
  width: 'int', height: 'int', xoffset: 'int', format: 'int', data: 'void *', byte_order: 'int', bitmap_unit: 'int', bitmap_bit_order: 'int',
  bitmap_pad: 'int', depth: 'int', bytes_per_line: 'int', bits_per_pixel: 'int', red_mask: 'unsigned long', green_mask: 'unsigned long',
  blue_mask: 'unsigned long', obdata: 'void *', f: koffi.array('void *', 6),
});
const XVisualInfo = koffi.struct('XVisualInfo', {
  visual: 'void *', visualid: 'unsigned long', screen: 'int', depth: 'int', class: 'int', red_mask: 'unsigned long', green_mask: 'unsigned long',
  blue_mask: 'unsigned long', colormap_size: 'int', bits_per_rgb: 'int',
});
const XSetWindowAttributes = koffi.struct('XSetWindowAttributes', {
  background_pixmap: 'unsigned long', background_pixel: 'unsigned long', border_pixmap: 'unsigned long', border_pixel: 'unsigned long',
  bit_gravity: 'int', win_gravity: 'int', backing_store: 'int', backing_planes: 'unsigned long', backing_pixel: 'unsigned long', save_under: 'int',
  event_mask: 'long', do_not_propagate_mask: 'long', override_redirect: 'int', colormap: 'unsigned long', cursor: 'unsigned long',
});
const XRectangle = koffi.struct('XRectangle', { x: 'short', y: 'short', width: 'unsigned short', height: 'unsigned short' });
const XErrorHandler = koffi.proto('int WatchXErrorHandler(void *dpy, void *event)');

const XOpenDisplay = x11.func('void *XOpenDisplay(const char *name)');
const XDefaultScreen = x11.func('int XDefaultScreen(void *dpy)');
const XRootWindow = x11.func('unsigned long XRootWindow(void *dpy, int screen)');
const XDefaultVisual = x11.func('void *XDefaultVisual(void *dpy, int screen)');
const XDefaultDepth = x11.func('int XDefaultDepth(void *dpy, int screen)');
const XInternAtom = x11.func('unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)');
const XGetWindowProperty = x11.func('int XGetWindowProperty(void *dpy, unsigned long w, unsigned long prop, long offset, long length, int del, unsigned long type, _Out_ unsigned long *actualType, _Out_ int *actualFormat, _Out_ unsigned long *nitems, _Out_ unsigned long *bytesAfter, _Out_ void **data)');
const XChangeProperty = x11.func('int XChangeProperty(void *dpy, unsigned long w, unsigned long prop, unsigned long type, int format, int mode, const void *data, int n)');
const XGetWindowAttributes = x11.func('int XGetWindowAttributes(void *dpy, unsigned long w, _Out_ XWindowAttributes *attrs)');
const XTranslateCoordinates = x11.func('int XTranslateCoordinates(void *dpy, unsigned long src, unsigned long dst, int x, int y, _Out_ int *dx, _Out_ int *dy, _Out_ unsigned long *child)');
const XQueryTree = x11.func('int XQueryTree(void *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *parent, _Out_ void **children, _Out_ unsigned int *n)');
const XGetImage = x11.func('XImage *XGetImage(void *dpy, unsigned long drawable, int x, int y, unsigned int w, unsigned int h, unsigned long planes, int format)');
const XGetSelectionOwner = x11.func('unsigned long XGetSelectionOwner(void *dpy, unsigned long selection)');
const XMatchVisualInfo = x11.func('int XMatchVisualInfo(void *dpy, int screen, int depth, int cls, _Out_ XVisualInfo *info)');
const XCreateColormap = x11.func('unsigned long XCreateColormap(void *dpy, unsigned long w, void *visual, int alloc)');
const XFreeColormap = x11.func('int XFreeColormap(void *dpy, unsigned long cmap)');
const XCreateWindow = x11.func('unsigned long XCreateWindow(void *dpy, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int border, int depth, unsigned int cls, void *visual, unsigned long mask, XSetWindowAttributes *attrs)');
const XDestroyWindow = x11.func('int XDestroyWindow(void *dpy, unsigned long w)');
const XMapRaised = x11.func('int XMapRaised(void *dpy, unsigned long w)');
const XUnmapWindow = x11.func('int XUnmapWindow(void *dpy, unsigned long w)');
const XCreateGC = x11.func('void *XCreateGC(void *dpy, unsigned long d, unsigned long mask, void *values)');
const XFreeGC = x11.func('int XFreeGC(void *dpy, void *gc)');
const XCreateImage = x11.func('XImage *XCreateImage(void *dpy, void *visual, unsigned int depth, int format, int offset, void *data, unsigned int w, unsigned int h, int pad, int bytesPerLine)');
const XPutImage = x11.func('int XPutImage(void *dpy, unsigned long d, void *gc, XImage *image, int sx, int sy, int dx, int dy, unsigned int w, unsigned int h)');
const XFree = x11.func('int XFree(void *data)');
const XFlush = x11.func('int XFlush(void *dpy)');
const XSync = x11.func('int XSync(void *dpy, int discard)');
const XSetErrorHandler = x11.func('void *XSetErrorHandler(WatchXErrorHandler *handler)');
const XShapeCombineRectangles = xext.func('void XShapeCombineRectangles(void *dpy, unsigned long dest, int kind, int x, int y, XRectangle *rects, int n, int op, int ordering)');

const ZPixmap = 2, AllPlanes = 0xffffffffffffffffn, AnyPropertyType = 0n;
const IsViewable = 2, InputOutput = 1, TrueColor = 4, AllocNone = 0, PropModeReplace = 0;
const CWBackPixel = 1 << 1, CWBorderPixel = 1 << 3, CWOverrideRedirect = 1 << 9, CWColormap = 1 << 13;
const ShapeBounding = 0, ShapeInput = 2, ShapeSet = 0, Unsorted = 0;
/** Width of the solid band shown when no compositing manager can blend the glow. */
const BAND = 5;

// a window that disappears between two calls raises BadWindow, which Xlib's default handler turns into exit()
const onError = koffi.register(() => 0, koffi.pointer(XErrorHandler));
XSetErrorHandler(onError);

const dpy = XOpenDisplay(null);
if (!dpy) throw new Error(`连不上 X 显示服务(DISPLAY=${process.env.DISPLAY ?? ''})`);
const screen = XDefaultScreen(dpy);
const root = BigInt(XRootWindow(dpy, screen));

const atoms = new Map<string, bigint>();
function atom(name: string): bigint {
  let a = atoms.get(name);
  if (a === undefined) { a = BigInt(XInternAtom(dpy, name, 0)); atoms.set(name, a); }
  return a;
}

/** A property as raw bytes plus its format (8, 16 or 32); format-32 items are C longs, 8 bytes here. */
function prop(w: bigint, name: string, type: bigint = AnyPropertyType): { bytes: Uint8Array; format: number; n: number } | null {
  const actualType = [0n], format = [0], n = [0n], after = [0n], data = [null];
  if (XGetWindowProperty(dpy, w, atom(name), 0, 1 << 20, 0, type, actualType, format, n, after, data) !== 0 || !data[0]) return null;
  try {
    const count = Number(n[0]);
    if (!count || !format[0]) return null;
    const size = format[0] === 8 ? count : format[0] === 16 ? count * 2 : count * 8;
    return { bytes: new Uint8Array(koffi.view(data[0], size)).slice(), format: format[0], n: count };
  } finally {
    XFree(data[0]);
  }
}

function longs(w: bigint, name: string): bigint[] {
  const p = prop(w, name);
  if (!p || p.format !== 32) return [];
  const view = new DataView(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength);
  return Array.from({ length: p.n }, (_, i) => view.getBigUint64(i * 8, true));
}

function text(w: bigint): string {
  const utf8 = prop(w, '_NET_WM_NAME');
  if (utf8 && utf8.format === 8) return Buffer.from(utf8.bytes).toString('utf8');
  const legacy = prop(w, 'WM_NAME');
  return legacy && legacy.format === 8 ? Buffer.from(legacy.bytes).toString('latin1') : '';
}

function geometry(w: bigint): { rect: Rect; viewable: boolean } | null {
  const a: Record<string, unknown> = {};
  if (!XGetWindowAttributes(dpy, w, a)) return null;
  const x = [0], y = [0], child = [0n];
  XTranslateCoordinates(dpy, w, root, 0, 0, x, y, child);
  return { rect: { x: x[0], y: y[0], width: a.width as number, height: a.height as number }, viewable: a.map_state === IsViewable };
}

/** The process name, or the window's WM_CLASS class when the client does not say its pid. */
function appName(w: bigint, pid: number): string {
  if (pid) try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { /* another host's client */ }
  const cls = prop(w, 'WM_CLASS');
  return cls && cls.format === 8 ? (Buffer.from(cls.bytes).toString('latin1').split('\0').filter(Boolean).pop() ?? '') : '';
}

function children(w: bigint): bigint[] {
  const r = [0n], parent = [0n], list = [null], n = [0];
  if (!XQueryTree(dpy, w, r, parent, list, n) || !list[0]) return [];
  try {
    const view = new DataView(koffi.view(list[0], n[0] * 8));
    return Array.from({ length: n[0] }, (_, i) => view.getBigUint64(i * 8, true));
  } finally {
    XFree(list[0]);
  }
}

/** The client window inside a frame: the first descendant (two levels down) with WM_STATE. */
function clientOf(w: bigint): bigint | null {
  if (prop(w, 'WM_STATE')) return w;
  for (const c of children(w)) {
    if (prop(c, 'WM_STATE')) return c;
    for (const cc of children(c)) if (prop(cc, 'WM_STATE')) return cc;
  }
  return null;
}

/** Top-level client windows, topmost first. */
function stacking(): bigint[] {
  const managed = longs(root, '_NET_CLIENT_LIST_STACKING');
  if (managed.length) return managed.reverse();
  const listed = longs(root, '_NET_CLIENT_LIST');
  if (listed.length) return listed.reverse();
  return children(root).reverse().map(clientOf).filter((c): c is bigint => c !== null);
}

const SKIP_TYPES = ['_NET_WM_WINDOW_TYPE_DOCK', '_NET_WM_WINDOW_TYPE_DESKTOP', '_NET_WM_WINDOW_TYPE_TOOLBAR', '_NET_WM_WINDOW_TYPE_MENU', '_NET_WM_WINDOW_TYPE_SPLASH', '_NET_WM_WINDOW_TYPE_NOTIFICATION', '_NET_WM_WINDOW_TYPE_TOOLTIP'];

function entry(w: bigint, fg: bigint): WindowEntry | null {
  const g = geometry(w);
  if (!g) return null;
  const types = longs(w, '_NET_WM_WINDOW_TYPE');
  if (types.some((t) => SKIP_TYPES.some((s) => atom(s) === t))) return null;
  const pid = Number(longs(w, '_NET_WM_PID')[0] ?? 0n);
  if (pid === process.pid) return null;
  const title = text(w);
  if (!title) return null;
  const hidden = longs(w, '_NET_WM_STATE').includes(atom('_NET_WM_STATE_HIDDEN'));
  const minimized = hidden || !g.viewable;
  if (!minimized && (g.rect.width < 32 || g.rect.height < 32)) return null;
  return { handle: w.toString(16), title, app: appName(w, pid), rect: g.rect, minimized, foreground: w === fg };
}

function active(): bigint {
  return longs(root, '_NET_ACTIVE_WINDOW')[0] ?? 0n;
}

export function windows(): WindowEntry[] {
  const fg = active();
  return stacking().map((w) => entry(w, fg)).filter((e): e is WindowEntry => e !== null);
}

export function foreground(): WindowEntry | null {
  const fg = active();
  return fg ? entry(fg, fg) : null;
}

export function info(handle: string): WindowEntry | null {
  return entry(BigInt(`0x${handle}`), active());
}

export type Grab = { ok: true; rgba: Uint8Array; width: number; height: number; gray: Uint8Array } | { ok: false; reason: Unavailable; detail?: string };

export function grab(handle: string, maxWidth: number, maxHeight: number, region?: Box): Grab {
  const w = BigInt(`0x${handle}`);
  const g = geometry(w);
  if (!g) return { ok: false, reason: 'gone' };
  if (!g.viewable || longs(w, '_NET_WM_STATE').includes(atom('_NET_WM_STATE_HIDDEN'))) return { ok: false, reason: 'minimized' };
  const { width, height } = g.rect;
  if (width <= 0 || height <= 0) return { ok: false, reason: 'blank' };
  const ptr = XGetImage(dpy, w, 0, 0, width, height, AllPlanes, ZPixmap);
  if (!ptr) return { ok: false, reason: 'blank' };
  let bgra: Uint8Array;
  try {
    const img = koffi.decode(ptr, XImage) as { data: unknown; bytes_per_line: number; bits_per_pixel: number; height: number; width: number };
    if (img.bits_per_pixel !== 32) return { ok: false, reason: 'blank', detail: `${img.bits_per_pixel} 位像素` };
    const src = new Uint8Array(koffi.view(img.data, img.bytes_per_line * img.height));
    bgra = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) bgra.set(src.subarray(y * img.bytes_per_line, y * img.bytes_per_line + width * 4), y * width * 4);
    XFree(img.data);
  } finally {
    XFree(ptr);
  }
  let px = bgra, w2 = width, h2 = height;
  if (region) {
    const c = crop(px, width, height, regionPixels(region, width, height));
    px = c.pixels; w2 = c.width; h2 = c.height;
  }
  const size = fit(w2, h2, maxWidth, maxHeight);
  const rgba = resize(px, w2, h2, size, 'bgra');
  const gray = grayThumb(rgba, size.width, size.height);
  if (isFlat(gray)) return { ok: false, reason: 'blank' };
  return { ok: true, rgba, ...size, gray };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function composited(): boolean {
  return BigInt(XGetSelectionOwner(dpy, atom(`_NET_WM_CM_S${screen}`))) !== 0n;
}

/** An override-redirect window over `rect` that lets every click through. */
function overlay(rect: Rect, visual: unknown, depth: number, colormap: bigint, background: bigint): bigint {
  const mask = CWOverrideRedirect | CWBorderPixel | CWBackPixel | (colormap ? CWColormap : 0);
  const attrs = { background_pixmap: 0n, background_pixel: background, border_pixmap: 0n, border_pixel: 0n, bit_gravity: 0, win_gravity: 0, backing_store: 0, backing_planes: 0n, backing_pixel: 0n, save_under: 0, event_mask: 0, do_not_propagate_mask: 0, override_redirect: 1, colormap, cursor: 0n };
  const win = BigInt(XCreateWindow(dpy, root, rect.x, rect.y, rect.width, rect.height, 0, depth, InputOutput, visual, BigInt(mask), attrs));
  XShapeCombineRectangles(dpy, win, ShapeInput, 0, 0, null, 0, ShapeSet, Unsorted);
  return win;
}

function setOpacity(win: bigint, a: number): void {
  const v = new BigUint64Array([BigInt(Math.round(Math.max(0, Math.min(1, a)) * 0xffffffff))]);
  XChangeProperty(dpy, win, atom('_NET_WM_WINDOW_OPACITY'), atom('CARDINAL'), 32, PropModeReplace, v, 1);
}

export async function flash(handle: string): Promise<void> {
  const g = geometry(BigInt(`0x${handle}`));
  if (!g || !g.viewable) return;
  const rect = g.rect;
  const vi: Record<string, unknown> = {};
  const start = Date.now();
  if (composited() && XMatchVisualInfo(dpy, screen, 32, TrueColor, vi)) {
    const colormap = BigInt(XCreateColormap(dpy, root, vi.visual, AllocNone));
    const win = overlay(rect, vi.visual, 32, colormap, 0n);
    const gc = XCreateGC(dpy, win, 0n, null);
    const glow = glowPixels(rect.width, rect.height, 0, GLOW_IN);
    const image = XCreateImage(dpy, vi.visual, 32, ZPixmap, 0, glow.bgra, glow.width, glow.height, 32, glow.width * 4);
    try {
      setOpacity(win, 0);
      XMapRaised(dpy, win);
      XPutImage(dpy, win, gc, image, 0, 0, 0, 0, glow.width, glow.height);
      for (let t = 0; t <= FLASH_MS; t = Date.now() - start) {
        setOpacity(win, flashAlpha(t));
        XFlush(dpy);
        await sleep(16);
      }
    } finally {
      XFree(image);
      XFreeGC(dpy, gc);
      XDestroyWindow(dpy, win);
      XFreeColormap(dpy, colormap);
      XSync(dpy, 0);
    }
    return;
  }
  // no compositing manager: a solid white band along the inside of the edge, shown while a pulse is high
  const win = overlay(rect, XDefaultVisual(dpy, screen), XDefaultDepth(dpy, screen), 0n, 0xffffffn);
  const b = Math.min(BAND, Math.floor(rect.width / 2), Math.floor(rect.height / 2));
  const bands = [
    { x: 0, y: 0, width: rect.width, height: b },
    { x: 0, y: rect.height - b, width: rect.width, height: b },
    { x: 0, y: 0, width: b, height: rect.height },
    { x: rect.width - b, y: 0, width: b, height: rect.height },
  ];
  XShapeCombineRectangles(dpy, win, ShapeBounding, 0, 0, bands, bands.length, ShapeSet, Unsorted);
  let shown = false;
  try {
    for (let t = 0; t <= FLASH_MS; t = Date.now() - start) {
      const on = flashAlpha(t) > 0.5;
      if (on !== shown) { if (on) XMapRaised(dpy, win); else XUnmapWindow(dpy, win); shown = on; XFlush(dpy); }
      await sleep(16);
    }
  } finally {
    XDestroyWindow(dpy, win);
    XSync(dpy, 0);
  }
}
