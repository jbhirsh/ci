import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appPixels, diff } from './pixels.mjs';

/**
 * Fake pixels: a "PNG" is JSON `{w, h, px}`; `match` counts the positions
 * where the lists differ and marks them in `out`.
 *
 * @type {import('./pixels.mjs').Pixels}
 */
const pixels = {
  read: (png) => {
    const { w, h, px } = JSON.parse(png.toString());
    return { width: w, height: h, data: Uint8Array.from(px) };
  },
  write: (image) =>
    Buffer.from(JSON.stringify({ w: image.width, h: image.height, px: [...image.data] })),
  match: (a, b, out) =>
    a.reduce((n, v, i) => {
      if (v === b[i]) return n;
      if (out) out[i] = 1;
      return n + 1;
    }, 0),
};

/** A fake PNG, its first `marked` pixels set. */
const png = (width = 10, height = 10, marked = 0) =>
  Buffer.from(
    JSON.stringify({
      w: width,
      h: height,
      px: Array.from({ length: width * height }, (_, i) => (i < marked ? 1 : 0)),
    }),
  );

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

describe('appPixels', () => {
  it("loads pixelmatch and pngjs from the app's node_modules", async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pixels-app-'));
    writeFileSync(path.join(root, 'package.json'), '{}');
    for (const [name, code] of Object.entries({
      pngjs:
        'export const PNG = { sync: { read: (b) => { const { w, h, px } = JSON.parse(b.toString()); return { width: w, height: h, data: Uint8Array.from(px) }; }, write: (i) => Buffer.from(JSON.stringify({ w: i.width, h: i.height, px: [...i.data] })) } };',
      pixelmatch: 'export default (a, b) => a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0);',
    })) {
      mkdirSync(path.join(root, 'node_modules', name), { recursive: true });
      writeFileSync(
        path.join(root, 'node_modules', name, 'package.json'),
        JSON.stringify({ name, type: 'module', main: 'index.js' }),
      );
      writeFileSync(path.join(root, 'node_modules', name, 'index.js'), code);
    }
    const real = await appPixels(root);
    expect(diff(png(), png(10, 10, 10), real).ratio).toBe(0.1);
    expect(JSON.parse(String(real.write({ width: 1, height: 1, data: Uint8Array.of(5) })))).toEqual(
      {
        w: 1,
        h: 1,
        px: [5],
      },
    );
  });
});
