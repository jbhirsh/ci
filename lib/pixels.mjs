// Comparing two screenshots, for the tools that do: readme-screenshots (which
// shots replace the README's) and visual-baselines (which no longer match
// their baselines). PNGs are decoded with pngjs and compared with
// pixelmatch, this repo's own `dependencies`: no app code uses either, so
// the compare actions install them from this repo's lockfile into the
// action's checkout (their action.yml), and an app lists neither.

import { readFileSync } from 'node:fs';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

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
 * pixelmatch and pngjs.
 *
 * @type {Pixels}
 */
export const PIXELS = Object.freeze({
  read: (png) => PNG.sync.read(png),
  write: (image) => PNG.sync.write(/** @type {import('pngjs').PNG} */ (image)),
  match: pixelmatch,
});

/**
 * Decodes the PNG at `file`, naming it when pngjs can't.
 *
 * @param {string} file
 * @returns {Image}
 */
export function readPng(file) {
  try {
    return PIXELS.read(readFileSync(file));
  } catch (error) {
    throw new Error(`${file} is not a PNG pngjs reads: ${/** @type {Error} */ (error).message}`, {
      cause: error,
    });
  }
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
