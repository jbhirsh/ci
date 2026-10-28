// Comparing two screenshots, for the tools that do: readme-screenshots (which
// shots replace the README's) and visual-baselines (which no longer match
// their baselines). PNGs are decoded with pngjs and compared with
// pixelmatch, both from the app's node_modules (importFromApp), so an app
// using either tool lists both among its devDependencies.

import { importFromApp } from './app.mjs';

/**
 * @typedef {{ width: number, height: number, data: Uint8Array }} Image
 * @typedef {object} Pixels
 * @property {(png: Buffer) => Image} read decodes a PNG
 * @property {(image: Image) => Buffer} write encodes one
 * @property {(a: Uint8Array, b: Uint8Array, out: Uint8Array | null, width: number,
 *   height: number, options: { threshold: number }) => number} match counts the
 *   pixels that differ, painting them into `out` when it's given
 */

/**
 * pixelmatch and pngjs, from the app.
 *
 * @param {string} root
 * @returns {Promise<Pixels>}
 */
export async function appPixels(root) {
  const pixelmatch = /** @type {{ default: Pixels['match'] }} */ (
    await importFromApp('pixelmatch', root)
  );
  const pngjs = /** @type {{ PNG: { sync: { read: Pixels['read'], write: Pixels['write'] } } }} */ (
    await importFromApp('pngjs', root)
  );
  return {
    read: (png) => pngjs.PNG.sync.read(png),
    write: (image) => pngjs.PNG.sync.write(image),
    match: pixelmatch.default,
  };
}

/**
 * How far two PNGs differ: the share of pixels pixelmatch counts (its colour
 * threshold 0.1, anti-aliasing aside), or 1 when their sizes differ, as a
 * different framing is a change however it looks (`resized`). With `withImage`, also
 * the diff image pixelmatch paints (none when the sizes differ).
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @param {Pixels} pixels
 * @param {{ withImage?: boolean }} [options]
 * @returns {{ ratio: number, resized?: true, image?: Buffer }}
 */
export function diff(a, b, pixels, { withImage = false } = {}) {
  const before = pixels.read(a);
  const after = pixels.read(b);
  const { width, height } = before;
  if (width !== after.width || height !== after.height || width * height === 0) {
    return { ratio: 1, resized: true };
  }
  const out = withImage ? new Uint8Array(width * height * 4) : null;
  const differing = pixels.match(before.data, after.data, out, width, height, { threshold: 0.1 });
  const ratio = differing / (width * height);
  return out ? { ratio, image: pixels.write({ width, height, data: out }) } : { ratio };
}
