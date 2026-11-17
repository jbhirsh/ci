import { describe, expect, it } from 'vitest';
import {
  crop,
  enlarge,
  lookAt,
  outlined,
  padded,
  places,
  scaleFor,
  sideBySide,
  zoomWidth,
} from './zoom.mjs';

/**
 * A mask `w`×`h` with these pixels set.
 *
 * @param {number} w
 * @param {number} h
 * @param {[number, number][]} set
 */
function mask(w, h, set) {
  const m = new Uint8Array(w * h);
  for (const [x, y] of set) m[y * w + x] = 1;
  return m;
}

describe('places', () => {
  it('finds none in an empty mask', () => {
    expect(places(new Uint8Array(100), 10, 10)).toEqual([]);
  });

  it('joins pixels near each other and splits those far apart, largest first', () => {
    const m = mask(200, 100, [
      [10, 10],
      [13, 12],
      [14, 14],
      [150, 80],
    ]);
    expect(places(m, 200, 100)).toEqual([
      { x: 10, y: 10, w: 5, h: 5 },
      { x: 150, y: 80, w: 1, h: 1 },
    ]);
  });

  it('outlines at most five places', () => {
    const set = /** @type {[number, number][]} */ (
      Array.from({ length: 9 }, (_, i) => [i * 30, 5])
    );
    expect(places(mask(300, 20, set), 300, 20)).toHaveLength(5);
  });
});

describe('padded and scaleFor', () => {
  it('pads a place, grows it to the least side and keeps it inside the shot', () => {
    expect(padded({ x: 50, y: 50, w: 4, h: 4 }, 400, 400)).toEqual({ x: 37, y: 37, w: 30, h: 30 });
    expect(padded({ x: 0, y: 0, w: 4, h: 4 }, 400, 400)).toEqual({ x: 0, y: 0, w: 30, h: 30 });
    expect(padded({ x: 396, y: 396, w: 4, h: 4 }, 400, 400)).toEqual({
      x: 370,
      y: 370,
      w: 30,
      h: 30,
    });
    expect(padded({ x: 1, y: 1, w: 3, h: 3 }, 20, 10)).toEqual({ x: 0, y: 0, w: 20, h: 10 });
  });

  it('scales by a whole number that fits 220 pixels', () => {
    expect(scaleFor({ x: 0, y: 0, w: 30, h: 30 })).toBe(7);
    expect(scaleFor({ x: 0, y: 0, w: 100, h: 20 })).toBe(2);
    expect(scaleFor({ x: 0, y: 0, w: 400, h: 20 })).toBe(1);
  });
});

describe('lookAt', () => {
  it('plans the zoom of the largest place, and calls a place over 64 pixels large', () => {
    const small = lookAt(mask(200, 100, [[10, 10]]), 200, 100);
    expect(small).toMatchObject({ large: false, scale: 7, width: 200, height: 100 });
    const wide = lookAt(
      mask(
        200,
        100,
        [
          [10, 10],
          [80, 10],
        ].flatMap(([x, y]) => Array.from({ length: 70 }, (_, i) => [x + i, y])),
      ),
      200,
      100,
    );
    expect(wide?.large).toBe(true);
    expect(lookAt(new Uint8Array(10), 5, 2)).toBeNull();
  });
});

describe('pictures', () => {
  /** A 4×2 image whose pixel i is [i, 0, 0, 255]. */
  const image = {
    width: 4,
    height: 2,
    data: Uint8Array.from(Array.from({ length: 8 }, (_, i) => [i, 0, 0, 255]).flat()),
  };

  it('crops a box and enlarges by whole pixels', () => {
    const c = crop(image, { x: 1, y: 1, w: 2, h: 1 });
    expect([c.width, c.height, [...c.data]]).toEqual([2, 1, [5, 0, 0, 255, 6, 0, 0, 255]]);
    const e = enlarge(c, 2);
    expect([e.width, e.height]).toEqual([4, 2]);
    expect([...e.data.subarray(0, 8)]).toEqual([5, 0, 0, 255, 5, 0, 0, 255]);
  });

  it('shrinks a wide screen to the thumbnail and draws red around a place', () => {
    const wide = { width: 400, height: 40, data: new Uint8Array(400 * 40 * 4).fill(255) };
    const out = outlined(wide, [{ x: 100, y: 10, w: 20, h: 10 }]);
    expect([out.width, out.height]).toEqual([160, 16]);
    const reds = [...Array(out.width * out.height).keys()].filter((i) => out.data[i * 4] === 220);
    expect(reds.length).toBeGreaterThan(10);
    expect(outlined(image, []).width).toBe(4);
  });
});

describe('the zoom picture', () => {
  it('puts the three patches side by side, 6 pixels apart, and says its width', () => {
    const patch = { width: 2, height: 1, data: Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]) };
    const out = sideBySide([patch, patch, patch]);
    expect([out.width, out.height]).toEqual([6 + 12, 1]);
    expect([...out.data.subarray(0, 4)]).toEqual([1, 2, 3, 255]);
    expect([...out.data.subarray(8, 12)]).toEqual([255, 255, 255, 255]);
    const look = /** @type {NonNullable<ReturnType<typeof lookAt>>} */ (
      lookAt(mask(200, 100, [[10, 10]]), 200, 100)
    );
    expect(zoomWidth(look)).toBe(3 * 30 * 7 + 12);
    expect(look.zoom.w * look.scale).toBeLessThanOrEqual(220);
  });
});
