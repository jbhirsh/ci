// PNGs for the tests that compare screenshots (lib/pixels.mjs's users):
// real ones for pixelmatch and pngjs, and stand-ins that keep a test's
// numbers readable. Not part of any tool.

import { PIXELS } from './pixels.mjs';

/**
 * A real PNG `width`×`height`, white with its first `marked` pixels black.
 *
 * @returns {Buffer}
 */
export function testPng(width = 10, height = 10, marked = 0) {
  const data = new Uint8Array(width * height * 4).fill(255);
  for (let i = 0; i < marked; i++) data.fill(0, i * 4, i * 4 + 3);
  return PIXELS.write({ width, height, data });
}

/**
 * Stand-in pixels: a "PNG" is JSON `{w, h, px}` (fakePng), and `match`
 * counts the positions where the lists differ, marking them in `out`.
 *
 * @type {import('./pixels.mjs').Pixels}
 */
export const fakePixels = {
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

/** A stand-in PNG for fakePixels, `width`×`height`, its first `marked` pixels set. */
export function fakePng(width = 10, height = 10, marked = 0) {
  return Buffer.from(
    JSON.stringify({
      w: width,
      h: height,
      px: Array.from({ length: width * height }, (_, i) => (i < marked ? 1 : 0)),
    }),
  );
}
