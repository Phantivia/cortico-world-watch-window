import { describe, expect, it } from 'vitest';
import { montage } from '../src/engine/image.ts';

/** A solid RGBA image whose red channel is `v`. */
function solid(v: number, width: number, height: number) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = v; rgba[i + 3] = 255; }
  return { rgba, width, height };
}

describe('montage', () => {
  it('lays cells out left to right, top to bottom, as the observation text numbers them', () => {
    const cells = [10, 20, 30, 40].map((v) => solid(v, 16, 9));
    const m = montage(cells, 2, 2, 16, 9);
    const red = (x: number, y: number) => m.rgba[(y * m.width + x) * 4];
    const gap = 4;
    expect([red(8, 4), red(16 + gap + 8, 4), red(8, 9 + gap + 4), red(16 + gap + 8, 9 + gap + 4)]).toEqual([10, 20, 30, 40]);
  });

  it('fits a cell of another shape inside its slot without spilling into the next', () => {
    const m = montage([solid(200, 9, 16), solid(50, 16, 9)], 2, 1, 16, 9);
    const red = (x: number, y: number) => m.rgba[(y * m.width + x) * 4];
    // the portrait cell is centred in the first slot; the slot's sides stay background
    expect(red(0, 4)).toBe(24);
    expect(red(8, 4)).toBe(200);
    expect(red(16 + 4 + 8, 4)).toBe(50);
  });
});
