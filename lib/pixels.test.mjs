import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diff, PIXELS, readPng } from './pixels.mjs';
import { fakePixels as pixels, fakePng as png, testPng } from './test-pixels.mjs';

describe('diff', () => {
  it('gives the share of pixels that differ', () => {
    expect(diff(png(), png(), pixels)).toEqual({ ratio: 0 });
    expect(diff(png(), png(10, 10, 25), pixels)).toEqual({ ratio: 0.25 });
  });

  it('counts a different size, or an empty image, as wholly changed', () => {
    const resized = { ratio: 1, resized: true };
    expect(diff(png(10, 10), png(10, 20), pixels, { withImage: true })).toEqual(resized);
    expect(diff(png(10, 10), png(20, 10), pixels)).toEqual(resized);
    expect(diff(png(0, 0), png(0, 0), pixels)).toEqual(resized);
  });

  it('tells a wholly changed image of the same size from a resized one', () => {
    expect(diff(png(2, 1), png(2, 1, 2), pixels)).toEqual({ ratio: 1 });
  });

  it('paints the diff when asked', () => {
    const { ratio, image } = diff(png(2, 1), png(2, 1, 1), pixels, { withImage: true });
    expect(ratio).toBe(0.5);
    const painted = JSON.parse(String(image));
    expect([painted.w, painted.h, painted.px.length]).toEqual([2, 1, 8]);
    expect(painted.px[0]).toBe(1);
  });
});

describe('PIXELS', () => {
  it('compares real PNGs with pixelmatch and pngjs', () => {
    const real = PIXELS;
    expect(diff(testPng(), testPng(10, 10, 10), real).ratio).toBe(0.1);
    const { image } = diff(testPng(2, 1), testPng(2, 1, 1), real, { withImage: true });
    expect(real.read(/** @type {Buffer} */ (image))).toMatchObject({ width: 2, height: 1 });
  });
});

describe('readPng', () => {
  it('decodes a PNG, and names a file pngjs cannot read', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pixels-'));
    writeFileSync(path.join(dir, 'a.png'), testPng(3, 2));
    writeFileSync(path.join(dir, 'b.png'), 'not a png');
    expect(readPng(path.join(dir, 'a.png'))).toMatchObject({ width: 3, height: 2 });
    expect(() => readPng(path.join(dir, 'b.png'))).toThrow(
      `${path.join(dir, 'b.png')} is not a PNG pngjs reads: `,
    );
  });
});
