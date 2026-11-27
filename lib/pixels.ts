// Comparing two screenshots, for the tools that do: readme-screenshots (which
// shots replace the README's) and visual-review (which shots changed). PNGs are decoded with pngjs and compared with
// pixelmatch, this repo's own `dependencies`: no app code uses either, so
// the compare actions install them from this repo's lockfile into the
// action's checkout (their action.yml), and an app lists neither.

import { readFileSync } from 'node:fs';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export type Image = { width: number; height: number; data: Uint8Array };

export type Pixels = {
  /** decodes a PNG */
  read: (png: Buffer) => Image;
  /** encodes one */
  write: (image: Image) => Buffer;
  /**
   * counts the pixels that differ, painting them into `out` when it's given (with `diffMask`, only
   * the differing ones, so a pixel with alpha 0 matches)
   */
  match: (
    a: Uint8Array,
    b: Uint8Array,
    out: Uint8Array | null,
    width: number,
    height: number,
    options: { threshold: number; diffMask?: boolean },
  ) => number;
};

/**
 * pixelmatch and pngjs.
 */
export const PIXELS: Pixels = Object.freeze({
  read: (png) => PNG.sync.read(png),
  write: (image) => PNG.sync.write(image as PNG),
  match: pixelmatch,
});

/**
 * Decodes the PNG at `file`, naming it when pngjs can't.
 */
export function readPng(file: string): Image {
  try {
    return PIXELS.read(readFileSync(file));
  } catch (error) {
    throw new Error(`${file} is not a PNG pngjs reads: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/**
 * How far two PNGs differ: the share of pixels pixelmatch counts (its colour
 * threshold 0.1, anti-aliasing aside), or 1 when their sizes differ, as a
 * different framing is a change however it looks (`resized`). With `withImage`, also
 * the diff image pixelmatch paints (none when the sizes differ), and with
 * `maskBelow` (when fewer than that share differs) which pixels differ (`mask`, one byte a pixel, 1 where they do)
 * and the size.
 */
export function diff(
  a: Buffer,
  b: Buffer,
  pixels: Pixels,
  { withImage = false, maskBelow = 0 }: { withImage?: boolean; maskBelow?: number } = {},
): {
  ratio: number;
  resized?: true;
  image?: Buffer;
  mask?: Uint8Array;
  width?: number;
  height?: number;
} {
  const before = pixels.read(a);
  const after = pixels.read(b);
  const { width, height } = before;
  if (width !== after.width || height !== after.height || width * height === 0) {
    return { ratio: 1, resized: true };
  }
  const out = withImage ? new Uint8Array(width * height * 4) : null;
  const differing = pixels.match(before.data, after.data, out, width, height, { threshold: 0.1 });
  const ratio = differing / (width * height);
  const result: {
    ratio: number;
    image?: Buffer;
    mask?: Uint8Array;
    width?: number;
    height?: number;
  } = { ratio };
  if (out) result.image = pixels.write({ width, height, data: out });
  if (ratio > 0 && ratio < maskBelow) {
    const painted = new Uint8Array(width * height * 4);
    pixels.match(before.data, after.data, painted, width, height, {
      threshold: 0.1,
      diffMask: true,
    });
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) if (painted[i * 4 + 3] > 0) mask[i] = 1;
    result.mask = mask;
    result.width = width;
    result.height = height;
  }
  return result;
}
