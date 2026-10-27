/**
 * Pixel work shared by both platforms: area-average resize, the gray thumbnail used for cut
 * detection and dHash, JPEG coding, cropping, grid montages, and the glow drawn around a picked
 * window. Pure functions over byte arrays.
 */
import jpeg from 'jpeg-js';

export interface Size { width: number; height: number }
export interface Box { x: number; y: number; width: number; height: number }

/** Width and height of the gray thumbnail. */
export const GRAY_W = 64, GRAY_H = 36;

/** Output size that fits `maxWidth`×`maxHeight` without enlarging. */
export function fit(width: number, height: number, maxWidth: number, maxHeight: number): Size {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Area-average resize to RGBA. `order` is the source's channel order; alpha is set opaque. */
export function resize(src: Uint8Array, width: number, height: number, out: Size, order: 'bgra' | 'rgba' = 'bgra'): Uint8Array {
  const rgba = new Uint8Array(out.width * out.height * 4);
  const fx = width / out.width, fy = height / out.height;
  const ri = order === 'bgra' ? 2 : 0, bi = order === 'bgra' ? 0 : 2;
  for (let oy = 0; oy < out.height; oy++) {
    const y0 = Math.floor(oy * fy), y1 = Math.min(height, Math.max(y0 + 1, Math.floor((oy + 1) * fy)));
    for (let ox = 0; ox < out.width; ox++) {
      const x0 = Math.floor(ox * fx), x1 = Math.min(width, Math.max(x0 + 1, Math.floor((ox + 1) * fx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) { r += src[i + ri]; g += src[i + 1]; b += src[i + bi]; n++; }
      }
      const o = (oy * out.width + ox) * 4;
      rgba[o] = r / n; rgba[o + 1] = g / n; rgba[o + 2] = b / n; rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/** `GRAY_W`×`GRAY_H` luma thumbnail of an RGBA image. */
export function grayThumb(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const small = resize(rgba, width, height, { width: GRAY_W, height: GRAY_H }, 'rgba');
  const gray = new Uint8Array(GRAY_W * GRAY_H);
  for (let i = 0, o = 0; o < gray.length; i += 4, o++) gray[o] = (small[i] * 299 + small[i + 1] * 587 + small[i + 2] * 114) / 1000;
  return gray;
}

/** Mean of a gray thumbnail, 0–255. */
export function meanLuma(gray: Uint8Array): number {
  let s = 0;
  for (const v of gray) s += v;
  return gray.length ? s / gray.length : 0;
}

/** True when every pixel is the same within a few levels: a window that drew nothing (black or white). */
export function isFlat(gray: Uint8Array): boolean {
  let lo = 255, hi = 0;
  for (const v of gray) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return hi - lo <= 3;
}

export function encodeJpeg(rgba: Uint8Array, width: number, height: number, quality: number): Uint8Array {
  const q = Math.round(Math.max(0.3, Math.min(1, quality)) * 100);
  return new Uint8Array(jpeg.encode({ data: rgba, width, height }, q).data);
}

export function decodeJpeg(bytes: Uint8Array): { rgba: Uint8Array; width: number; height: number } {
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  return { rgba: img.data, width: img.width, height: img.height };
}

/** `rect` cut out of a 4-byte-per-pixel image, clamped to the source. */
export function crop(src: Uint8Array, width: number, height: number, rect: Box): { pixels: Uint8Array; width: number; height: number } {
  const x0 = Math.max(0, Math.min(width - 1, Math.round(rect.x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.round(rect.y)));
  const w = Math.max(1, Math.min(width - x0, Math.round(rect.width)));
  const h = Math.max(1, Math.min(height - y0, Math.round(rect.height)));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(src.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4), y * w * 4);
  return { pixels: out, width: w, height: h };
}

/** A 0–1 region of a `width`×`height` image in pixels. */
export function regionPixels(region: Box, width: number, height: number): Box {
  return { x: region.x * width, y: region.y * height, width: region.width * width, height: region.height * height };
}

/**
 * Cells laid out row-major on a dark grid; each cell is scaled to fit its slot and centred, so a
 * window that changed shape mid-way still fits. Returns RGBA.
 */
export function montage(cells: readonly { rgba: Uint8Array; width: number; height: number }[], cols: number, rows: number, cellWidth: number, cellHeight: number): { rgba: Uint8Array; width: number; height: number } {
  const gap = cols * rows > 1 ? 4 : 0;
  const width = cols * cellWidth + (cols - 1) * gap, height = rows * cellHeight + (rows - 1) * gap;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = 24; out[i + 1] = 24; out[i + 2] = 24; out[i + 3] = 255; }
  cells.forEach((c, k) => {
    const size = fit(c.width, c.height, cellWidth, cellHeight);
    const px = c.width === size.width && c.height === size.height ? c.rgba : resize(c.rgba, c.width, c.height, size, 'rgba');
    const ox = (k % cols) * (cellWidth + gap) + Math.floor((cellWidth - size.width) / 2);
    const oy = Math.floor(k / cols) * (cellHeight + gap) + Math.floor((cellHeight - size.height) / 2);
    for (let y = 0; y < size.height; y++) out.set(px.subarray(y * size.width * 4, (y + 1) * size.width * 4), ((oy + y) * width + ox) * 4);
  });
  return { rgba: out, width, height };
}

/** Glow reach outside the window's edge and inside it, in pixels at 1× scale; the glow lies inside the window. */
export const GLOW_OUT = 0, GLOW_IN = 36;

/**
 * Premultiplied white BGRA for a glow around an inner `w`×`h` rectangle that sits `pad` pixels in
 * from every side of the returned `(w + 2·pad)`×`(h + 2·pad)` image. Strongest on the edge, fading
 * to nothing `pad` pixels out and `inner` pixels in. Inside, the four edges' glows are layered over
 * each other, so corners blend instead of meeting on a diagonal seam.
 */
export function glowPixels(w: number, h: number, pad: number, inner: number): { bgra: Uint8Array; width: number; height: number } {
  const W = w + 2 * pad, H = h + 2 * pad;
  const bgra = new Uint8Array(W * H * 4);
  const x0 = pad, y0 = pad, x1 = pad + w, y1 = pad + h;
  const edge = (d: number) => (d < inner ? (1 - d / inner) ** 2 : 0);
  for (let y = 0; y < H; y++) {
    const dyOut = y < y0 ? y0 - y : y >= y1 ? y - y1 + 1 : 0;
    const clearY = (1 - edge(y - y0)) * (1 - edge(y1 - 1 - y));
    for (let x = 0; x < W; x++) {
      const dxOut = x < x0 ? x0 - x : x >= x1 ? x - x1 + 1 : 0;
      let a = 0;
      if (dxOut || dyOut) {
        const d = Math.hypot(dxOut, dyOut);
        if (d < pad) a = (1 - d / pad) ** 2;
      } else {
        a = 1 - clearY * (1 - edge(x - x0)) * (1 - edge(x1 - 1 - x));
      }
      if (a <= 0) continue;
      const v = Math.round(a * 255), i = (y * W + x) * 4;
      bgra[i] = v; bgra[i + 1] = v; bgra[i + 2] = v; bgra[i + 3] = v;
    }
  }
  return { bgra, width: W, height: H };
}

/** Opacity 0–1 of the flash at `t` ms: two pulses, the second fading out slowly. */
export function flashAlpha(t: number): number {
  const pulse = (t0: number, rise: number, hold: number, fall: number, peak: number) => {
    const u = t - t0;
    if (u < 0 || u > rise + hold + fall) return 0;
    if (u < rise) return peak * (u / rise);
    if (u < rise + hold) return peak;
    return peak * (1 - (u - rise - hold) / fall);
  };
  return Math.max(pulse(0, 120, 120, 260, 1), pulse(520, 120, 200, 620, 1));
}

/** Total length of the flash in ms. */
export const FLASH_MS = 1460;
