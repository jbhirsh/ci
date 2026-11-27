// Where a small difference is, and pictures that show it (ci#87): for a shot
// that differs in under `minor` of its pixels, the table shows the screen
// with the changed places outlined (`where`) and the largest one zoomed in
// before, after and as a diff, rather than a whole screen that looks the
// same. Pure: pixel lists in, boxes and pixel lists out. compare.ts plans a
// shot's look from its mask, review.ts draws it.
//
// The rules, so a reader can predict a picture:
//   - changed pixels within GAP of each other (about: a grid of GAP-pixel
//     cells, neighbours joined) are one place; the MAX_PLACES largest are
//     outlined, the largest is zoomed;
//   - the zoom is that place with PAD pixels around it, at least MIN_SIDE
//     wide and high, scaled by a whole number so it fits MAX_ZOOM pixels;
//   - a place wider or taller than LARGE isn't zoomed, as a zoom would be
//     no clearer than the diff: the table shows the diff picture itself.

import type { Image } from '../lib/pixels.ts';

/** Changed pixels this close (about) are one place. */
const GAP = 8;
/** The most places outlined. */
const MAX_PLACES = 5;
/** Space kept around the zoomed place. */
const PAD = 8;
/** The smallest zoom, so one stray pixel isn't a speck. */
const MIN_SIDE = 30;
/** The widest or tallest a zoom picture gets, in pixels. */
const MAX_ZOOM = 220;
/** A place over this wide or high shows the diff instead of a zoom. */
const LARGE = 64;
/** The width of the outlined thumbnail, in pixels. */
export const WHERE_WIDTH = 160;

/** A rectangle of pixels. */
export type Box = { x: number; y: number; w: number; h: number };

/** What a small change looks like, planned from its mask. */
export type Look = {
  /** the outlined places, largest first */
  places: Box[];
  /** the zoomed place, padded and clamped to the shot */
  zoom: Box;
  /** the zoom's whole-number scale */
  scale: number;
  /** whether the largest place is over LARGE: no zoom */
  large: boolean;
  /** the shot's width */
  width: number;
  /** the shot's height */
  height: number;
};

/**
 * The places where the mask is set, largest first, at most MAX_PLACES.
 *
 * @param mask one byte a pixel, 1 where it differs
 * @param width
 * @param height
 */
export function places(mask: Uint8Array, width: number, height: number): Box[] {
  const cols = Math.ceil(width / GAP);
  const rows = Math.ceil(height / GAP);
  const cells: Map<number, { x0: number; y0: number; x1: number; y1: number; n: number }> =
    new Map();
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % width;
    const y = Math.floor(i / width);
    const key = Math.floor(y / GAP) * cols + Math.floor(x / GAP);
    const c = cells.get(key);
    if (c) {
      c.x0 = Math.min(c.x0, x);
      c.y0 = Math.min(c.y0, y);
      c.x1 = Math.max(c.x1, x);
      c.y1 = Math.max(c.y1, y);
      c.n++;
    } else cells.set(key, { x0: x, y0: y, x1: x, y1: y, n: 1 });
  }
  // Join cells that touch, by flood fill.
  const groups: { x0: number; y0: number; x1: number; y1: number; n: number }[] = [];
  const seen = new Set();
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    const group = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, n: 0 };
    const todo = [start];
    seen.add(start);
    while (todo.length > 0) {
      const key = todo.pop() as number;
      const c = cells.get(key) as NonNullable<ReturnType<typeof cells.get>>;
      group.x0 = Math.min(group.x0, c.x0);
      group.y0 = Math.min(group.y0, c.y0);
      group.x1 = Math.max(group.x1, c.x1);
      group.y1 = Math.max(group.y1, c.y1);
      group.n += c.n;
      const cx = key % cols;
      const cy = Math.floor(key / cols);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const next = ny * cols + nx;
          if (cells.has(next) && !seen.has(next)) {
            seen.add(next);
            todo.push(next);
          }
        }
      }
    }
    groups.push(group);
  }
  return groups
    .sort((a, b) => b.n - a.n || a.y0 - b.y0 || a.x0 - b.x0)
    .slice(0, MAX_PLACES)
    .map((g) => ({ x: g.x0, y: g.y0, w: g.x1 - g.x0 + 1, h: g.y1 - g.y0 + 1 }));
}

/**
 * A box grown by PAD on every side, to at least MIN_SIDE, kept inside the shot.
 */
export function padded(box: Box, width: number, height: number): Box {
  const axis = (at: number, size: number, limit: number) => {
    const want = Math.min(limit, Math.max(MIN_SIDE, size + 2 * PAD));
    const start = Math.min(Math.max(0, Math.round(at + size / 2 - want / 2)), limit - want);
    return [start, want];
  };
  const [x, w] = axis(box.x, box.w, width);
  const [y, h] = axis(box.y, box.h, height);
  return { x, y, w, h };
}

/**
 * The whole-number scale that fits a box in MAX_ZOOM pixels (at least 1).
 */
export const scaleFor = (box: Box) => Math.max(1, Math.floor(MAX_ZOOM / Math.max(box.w, box.h)));

/**
 * The look of a small change, or null when the mask is empty.
 */
export function lookAt(mask: Uint8Array, width: number, height: number): Look | null {
  const found = places(mask, width, height);
  if (found.length === 0) return null;
  const zoom = padded(found[0], width, height);
  return {
    places: found,
    zoom,
    scale: scaleFor(zoom),
    large: found[0].w > LARGE || found[0].h > LARGE,
    width,
    height,
  };
}

/**
 * The part of an image in a box, as a new image.
 */
export function crop(image: Image, box: Box): Image {
  const data = new Uint8Array(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    const from = ((box.y + y) * image.width + box.x) * 4;
    data.set(image.data.subarray(from, from + box.w * 4), y * box.w * 4);
  }
  return { width: box.w, height: box.h, data };
}

/**
 * An image enlarged by a whole number, each pixel a square.
 */
export function enlarge(image: Image, k: number): Image {
  const width = image.width * k;
  const data = new Uint8Array(width * image.height * k * 4);
  for (let y = 0; y < image.height * k; y++) {
    for (let x = 0; x < width; x++) {
      const from = (Math.floor(y / k) * image.width + Math.floor(x / k)) * 4;
      data.set(image.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { width, height: image.height * k, data };
}

/**
 * The screen at `maxWidth` pixels wide (never larger), with each place
 * outlined in red: the picture that says where in the screen it changed.
 */
export function outlined(image: Image, boxes: Box[], maxWidth: number = WHERE_WIDTH): Image {
  const k = Math.min(1, maxWidth / image.width);
  const width = Math.max(1, Math.round(image.width * k));
  const height = Math.max(1, Math.round(image.height * k));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor(x / k));
      const sy = Math.min(image.height - 1, Math.floor(y / k));
      data.set(
        image.data.subarray((sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4),
        (y * width + x) * 4,
      );
    }
  }
  const red = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    data.set([220, 38, 38, 255], (y * width + x) * 4);
  };
  for (const b of boxes) {
    // A box one pixel out from the place, so the place itself stays visible.
    const x0 = Math.floor((b.x - 2) * k);
    const y0 = Math.floor((b.y - 2) * k);
    const x1 = Math.ceil((b.x + b.w + 1) * k);
    const y1 = Math.ceil((b.y + b.h + 1) * k);
    for (let x = x0; x <= x1; x++) {
      red(x, y0);
      red(x, y1);
    }
    for (let y = y0; y <= y1; y++) {
      red(x0, y);
      red(x1, y);
    }
  }
  return { width, height, data };
}

/** The space between the patches of a zoom picture, in pixels. */
const PATCH_GAP = 6;

/**
 * Pictures in a row, top-aligned, with a white gap between: the zoom
 * picture's before, after and diff, one upload instead of three.
 */
export function sideBySide(images: Image[]): Image {
  const width = images.reduce((n, i) => n + i.width, 0) + PATCH_GAP * (images.length - 1);
  const height = Math.max(...images.map((i) => i.height));
  const data = new Uint8Array(width * height * 4).fill(255);
  let left = 0;
  for (const image of images) {
    for (let y = 0; y < image.height; y++) {
      data.set(
        image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
        (y * width + left) * 4,
      );
    }
    left += image.width + PATCH_GAP;
  }
  return { width, height, data };
}

/**
 * The width of a zoom picture for a look, so the table can say it.
 */
export const zoomWidth = (look: Look) => 3 * look.zoom.w * look.scale + 2 * PATCH_GAP;
