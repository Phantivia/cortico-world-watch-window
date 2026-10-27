/**
 * Win32 access through koffi: the top-level window list, a window's picture, and the white glow
 * drawn around a picked window. Runs only inside the engine child process.
 *
 * A window's picture is its client area through PrintWindow with PW_RENDERFULLCONTENT, which
 * also reads windows that sit behind others and GPU-drawn content on Windows 8.1 and later.
 * Windows that still give back a flat picture (some full-screen games) are read off the screen
 * instead while they are in front. The glow is a layered, click-through, topmost tool window
 * excluded from every capture (WDA_EXCLUDEFROMCAPTURE, Windows 10 2004 and later), so it never
 * shows up in the frames.
 *
 * The process declares itself per-monitor DPI aware (v2) first: every size here is physical
 * pixels. Window handles cross the IPC as hexadecimal strings.
 */
import koffi from 'koffi';
import { FLASH_MS, GLOW_IN, GLOW_OUT, fit, flashAlpha, glowPixels, grayThumb, isFlat, regionPixels, resize, crop, type Box } from './image.ts';
import type { Rect, Unavailable, WindowEntry } from '../engine-ipc.ts';

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');

const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const SIZE = koffi.struct('SIZE', { cx: 'long', cy: 'long' });
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32_t', biWidth: 'int32_t', biHeight: 'int32_t', biPlanes: 'uint16_t', biBitCount: 'uint16_t',
  biCompression: 'uint32_t', biSizeImage: 'uint32_t', biXPelsPerMeter: 'int32_t', biYPelsPerMeter: 'int32_t',
  biClrUsed: 'uint32_t', biClrImportant: 'uint32_t',
});
const BLENDFUNCTION = koffi.struct('BLENDFUNCTION', { BlendOp: 'uint8_t', BlendFlags: 'uint8_t', SourceConstantAlpha: 'uint8_t', AlphaFormat: 'uint8_t' });
const MSG = koffi.struct('MSG', { hwnd: 'intptr_t', message: 'uint32_t', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32_t', pt: POINT, lPrivate: 'uint32_t' });
const EnumWindowsProc = koffi.proto('bool __stdcall WatchEnumWindowsProc(intptr_t hwnd, intptr_t lParam)');

const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(WatchEnumWindowsProc *cb, intptr_t lParam)');
const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hwnd)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hwnd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint16_t *buf, int max)');
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)');
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const GetAncestor = user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32_t flags)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ RECT *rect)');
const GetClientRect = user32.func('bool __stdcall GetClientRect(intptr_t hwnd, _Out_ RECT *rect)');
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(intptr_t hwnd, _Inout_ POINT *p)');
const GetDpiForWindow = user32.func('uint32_t __stdcall GetDpiForWindow(intptr_t hwnd)');
const PrintWindow = user32.func('bool __stdcall PrintWindow(intptr_t hwnd, void *dc, uint32_t flags)');
const GetDC = user32.func('void *__stdcall GetDC(intptr_t hwnd)');
const ReleaseDC = user32.func('int __stdcall ReleaseDC(intptr_t hwnd, void *dc)');
const CreateWindowExW = user32.func('intptr_t __stdcall CreateWindowExW(uint32_t ex, str16 cls, str16 name, uint32_t style, int x, int y, int w, int h, intptr_t parent, intptr_t menu, intptr_t inst, intptr_t param)');
const DestroyWindow = user32.func('bool __stdcall DestroyWindow(intptr_t hwnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)');
const SetWindowDisplayAffinity = user32.func('bool __stdcall SetWindowDisplayAffinity(intptr_t hwnd, uint32_t affinity)');
const UpdateLayeredWindow = user32.func('bool __stdcall UpdateLayeredWindow(intptr_t hwnd, void *dst, POINT *ptDst, SIZE *size, void *src, POINT *ptSrc, uint32_t key, BLENDFUNCTION *blend, uint32_t flags)');
const PeekMessageW = user32.func('bool __stdcall PeekMessageW(_Out_ MSG *msg, intptr_t hwnd, uint32_t min, uint32_t max, uint32_t remove)');
const TranslateMessage = user32.func('bool __stdcall TranslateMessage(MSG *msg)');
const DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(MSG *msg)');
const CreateCompatibleDC = gdi32.func('void *__stdcall CreateCompatibleDC(void *dc)');
const CreateCompatibleBitmap = gdi32.func('void *__stdcall CreateCompatibleBitmap(void *dc, int w, int h)');
const CreateDIBSection = gdi32.func('void *__stdcall CreateDIBSection(void *dc, BITMAPINFOHEADER *bmi, uint32_t usage, _Out_ void **bits, void *section, uint32_t offset)');
const SelectObject = gdi32.func('void *__stdcall SelectObject(void *dc, void *obj)');
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(void *obj)');
const DeleteDC = gdi32.func('bool __stdcall DeleteDC(void *dc)');
const BitBlt = gdi32.func('bool __stdcall BitBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, uint32_t rop)');
const StretchBlt = gdi32.func('bool __stdcall StretchBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, int sw, int sh, uint32_t rop)');
const SetStretchBltMode = gdi32.func('int __stdcall SetStretchBltMode(void *dc, int mode)');
const SetBrushOrgEx = gdi32.func('bool __stdcall SetBrushOrgEx(void *dc, int x, int y, void *prev)');
const GetDIBits = gdi32.func('int __stdcall GetDIBits(void *dc, void *bmp, uint32_t start, uint32_t lines, void *bits, _Inout_ BITMAPINFOHEADER *bmi, uint32_t usage)');
const SetDIBits = gdi32.func('int __stdcall SetDIBits(void *dc, void *bmp, uint32_t start, uint32_t lines, const void *bits, BITMAPINFOHEADER *bmi, uint32_t usage)');
const OpenProcess = kernel32.func('void *__stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)');
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)');
const GetCurrentProcessId = kernel32.func('uint32_t __stdcall GetCurrentProcessId()');
const DwmGetWindowAttributeInt = dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, _Out_ int *value, uint32_t size)');
const DwmGetWindowAttributeRect = dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, _Out_ RECT *value, uint32_t size)');

const SRCCOPY = 0x00CC0020, CAPTUREBLT = 0x40000000, HALFTONE = 4;
const PW_CLIENTONLY = 1, PW_RENDERFULLCONTENT = 2;
const GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_LAYERED = 0x80000, WS_EX_TRANSPARENT = 0x20, WS_EX_TOPMOST = 0x8, WS_POPUP = 0x80000000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;
const GA_ROOTOWNER = 3;
const WDA_EXCLUDEFROMCAPTURE = 0x11;
const SW_SHOWNOACTIVATE = 4;
const ULW_ALPHA = 2, AC_SRC_ALPHA = 1;
const PM_REMOVE = 1;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

SetProcessDpiAwarenessContext(-4);
const ownPid = GetCurrentProcessId();

const hwndOf = (handle: string): bigint => BigInt(`0x${handle}`);
const handleOf = (hwnd: number | bigint): string => BigInt(hwnd).toString(16);

function header(width: number, height: number) {
  return { biSize: koffi.sizeof(BITMAPINFOHEADER), biWidth: width, biHeight: -height, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 };
}

function frameRect(hwnd: bigint): Rect {
  const r = { left: 0, top: 0, right: 0, bottom: 0 };
  if (DwmGetWindowAttributeRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, koffi.sizeof(RECT)) !== 0) GetWindowRect(hwnd, r);
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
}

const appNames = new Map<number, string>();

function appName(pid: number): string {
  const cached = appNames.get(pid);
  if (cached !== undefined) return cached;
  let name = '';
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (h) {
    const buf = new Uint16Array(1024);
    const size = [buf.length];
    if (QueryFullProcessImageNameW(h, 0, buf, size)) name = String.fromCharCode(...buf.subarray(0, size[0])).split('\\').pop()!.replace(/\.exe$/i, '');
    CloseHandle(h);
  }
  appNames.set(pid, name);
  return name;
}

function entry(hwnd: bigint, fg: bigint, buf: Uint16Array): WindowEntry | null {
  if (!IsWindowVisible(hwnd)) return null;
  if (Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) return null;
  const cloaked = [0];
  if (DwmGetWindowAttributeInt(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0] !== 0) return null;
  const n = GetWindowTextW(hwnd, buf, buf.length);
  if (n <= 0) return null;
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  if (pid[0] === ownPid) return null;
  const rect = frameRect(hwnd);
  const minimized = IsIconic(hwnd);
  if (!minimized && (rect.width < 32 || rect.height < 32)) return null;
  return { handle: handleOf(hwnd), title: String.fromCharCode(...buf.subarray(0, n)), app: appName(pid[0]), rect, minimized, foreground: hwnd === fg };
}

/** Visible, titled, uncloaked top-level windows in z-order (topmost first). */
export function windows(): WindowEntry[] {
  const fg = BigInt(GetForegroundWindow());
  const out: WindowEntry[] = [];
  const buf = new Uint16Array(512);
  const cb = koffi.register((hwnd: number | bigint) => {
    const e = entry(BigInt(hwnd), fg, buf);
    if (e) out.push(e);
    return true;
  }, koffi.pointer(EnumWindowsProc));
  try { EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  return out;
}

/** The window in front, when it is one `windows()` would list. */
export function foreground(): WindowEntry | null {
  const fg = BigInt(GetForegroundWindow());
  if (!fg) return null;
  const root = BigInt(GetAncestor(fg, GA_ROOTOWNER)) || fg;
  return entry(root, root, new Uint16Array(512)) ?? entry(fg, fg, new Uint16Array(512));
}

export function info(handle: string): WindowEntry | null {
  const hwnd = hwndOf(handle);
  if (!IsWindow(hwnd)) return null;
  return entry(hwnd, BigInt(GetForegroundWindow()), new Uint16Array(512));
}

export type Grab = { ok: true; rgba: Uint8Array; width: number; height: number; gray: Uint8Array } | { ok: false; reason: Unavailable; detail?: string };

/** Top-down BGRA of `bmp` (selected into `dc`), with the alpha byte forced opaque. */
function readBits(dc: unknown, bmp: unknown, width: number, height: number): Uint8Array {
  const bgra = new Uint8Array(width * height * 4);
  const lines = GetDIBits(dc, bmp, 0, height, bgra, header(width, height), 0);
  if (lines !== height) throw new Error(`GetDIBits 只取到 ${lines}/${height} 行`);
  return bgra;
}

function toRgba(bgra: Uint8Array): Uint8Array {
  for (let i = 0; i < bgra.length; i += 4) { const b = bgra[i]; bgra[i] = bgra[i + 2]; bgra[i + 2] = b; bgra[i + 3] = 255; }
  return bgra;
}

/**
 * The window's client area fitted into `maxWidth`×`maxHeight`; `region` (0–1 of the client area)
 * crops first. A minimized or closed window gives no picture.
 */
export function grab(handle: string, maxWidth: number, maxHeight: number, region?: Box): Grab {
  const hwnd = hwndOf(handle);
  if (!IsWindow(hwnd)) return { ok: false, reason: 'gone' };
  if (IsIconic(hwnd)) return { ok: false, reason: 'minimized' };
  const rc = { left: 0, top: 0, right: 0, bottom: 0 };
  GetClientRect(hwnd, rc);
  const w = rc.right - rc.left, h = rc.bottom - rc.top;
  if (w <= 0 || h <= 0) return { ok: false, reason: 'blank' };

  const screen = GetDC(0);
  const full = CreateCompatibleDC(screen);
  const fullBmp = CreateCompatibleBitmap(screen, w, h);
  const oldFull = SelectObject(full, fullBmp);
  try {
    const read = (): { rgba: Uint8Array; width: number; height: number } => {
      if (region) {
        const box = regionPixels(region, w, h);
        const c = crop(readBits(full, fullBmp, w, h), w, h, box);
        const size = fit(c.width, c.height, maxWidth, maxHeight);
        return { rgba: resize(c.pixels, c.width, c.height, size, 'bgra'), ...size };
      }
      const size = fit(w, h, maxWidth, maxHeight);
      if (size.width === w && size.height === h) return { rgba: toRgba(readBits(full, fullBmp, w, h)), width: w, height: h };
      const small = CreateCompatibleDC(screen);
      const smallBmp = CreateCompatibleBitmap(screen, size.width, size.height);
      const oldSmall = SelectObject(small, smallBmp);
      try {
        SetStretchBltMode(small, HALFTONE);
        SetBrushOrgEx(small, 0, 0, null);
        StretchBlt(small, 0, 0, size.width, size.height, full, 0, 0, w, h, SRCCOPY);
        return { rgba: toRgba(readBits(small, smallBmp, size.width, size.height)), ...size };
      } finally {
        SelectObject(small, oldSmall);
        DeleteObject(smallBmp);
        DeleteDC(small);
      }
    };
    let pic = PrintWindow(hwnd, full, PW_CLIENTONLY | PW_RENDERFULLCONTENT) ? read() : null;
    let gray = pic ? grayThumb(pic.rgba, pic.width, pic.height) : null;
    if (!pic || isFlat(gray!)) {
      // some full-screen games draw nothing for PrintWindow: read the screen while the window is in front
      const fg = BigInt(GetForegroundWindow());
      if (fg !== hwnd && BigInt(GetAncestor(fg, GA_ROOTOWNER)) !== hwnd) return { ok: false, reason: 'blank' };
      const p = { x: 0, y: 0 };
      ClientToScreen(hwnd, p);
      if (!BitBlt(full, 0, 0, w, h, screen, p.x, p.y, SRCCOPY | CAPTUREBLT)) return { ok: false, reason: 'blank' };
      pic = read();
      gray = grayThumb(pic.rgba, pic.width, pic.height);
      if (isFlat(gray)) return { ok: false, reason: 'blank' };
    }
    return { ok: true, ...pic, gray: gray! };
  } finally {
    SelectObject(full, oldFull);
    DeleteObject(fullBmp);
    DeleteDC(full);
    ReleaseDC(0, screen);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The glow around the window's visible frame, two pulses over about a second and a half. */
export async function flash(handle: string): Promise<void> {
  const hwnd = hwndOf(handle);
  if (!IsWindow(hwnd) || IsIconic(hwnd)) return;
  const rect = frameRect(hwnd);
  const scale = (GetDpiForWindow(hwnd) || 96) / 96;
  const pad = Math.round(GLOW_OUT * scale), inner = Math.round(GLOW_IN * scale);
  const glow = glowPixels(rect.width, rect.height, pad, inner);
  const overlay = BigInt(CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, 'Static', '', WS_POPUP, rect.x - pad, rect.y - pad, glow.width, glow.height, 0, 0, 0, 0));
  if (!overlay) throw new Error('边框窗口没建起来');
  SetWindowDisplayAffinity(overlay, WDA_EXCLUDEFROMCAPTURE);
  const screen = GetDC(0);
  const mem = CreateCompatibleDC(screen);
  const bits = [null];
  const bmp = CreateDIBSection(mem, header(glow.width, glow.height), 0, bits, null, 0);
  const old = SelectObject(mem, bmp);
  const msg = {};
  try {
    SetDIBits(mem, bmp, 0, glow.height, glow.bgra, header(glow.width, glow.height), 0);
    const dst = { x: rect.x - pad, y: rect.y - pad }, size = { cx: glow.width, cy: glow.height }, src = { x: 0, y: 0 };
    const start = Date.now();
    let shown = false;
    for (let t = 0; t <= FLASH_MS; t = Date.now() - start) {
      const a = Math.round(flashAlpha(t) * 255);
      UpdateLayeredWindow(overlay, screen, dst, size, mem, src, 0, { BlendOp: 0, BlendFlags: 0, SourceConstantAlpha: a, AlphaFormat: AC_SRC_ALPHA }, ULW_ALPHA);
      if (!shown) { ShowWindow(overlay, SW_SHOWNOACTIVATE); shown = true; }
      while (PeekMessageW(msg, 0, 0, 0, PM_REMOVE)) { TranslateMessage(msg); DispatchMessageW(msg); }
      await sleep(16);
    }
  } finally {
    DestroyWindow(overlay);
    SelectObject(mem, old);
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(0, screen);
  }
}
