import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lookAt, outlined, padded, places } from './zoom.mjs';

const size = fc.integer({ min: 1, max: 120 });
/** A mask of a random size with random pixels set. */
const masks = fc.tuple(size, size).chain(([w, h]) =>
  fc
    .array(fc.tuple(fc.integer({ min: 0, max: w - 1 }), fc.integer({ min: 0, max: h - 1 })), {
      maxLength: 60,
    })
    .map((set) => {
      const m = new Uint8Array(w * h);
      for (const [x, y] of set) m[y * w + x] = 1;
      return { w, h, m };
    }),
);

describe('places, for any mask', () => {
  it('stays inside the shot, outlines at most five, and is inside the shot', () => {
    fc.assert(
      fc.property(masks, ({ w, h, m }) => {
        const found = places(m, w, h);
        expect(found.length).toBeLessThanOrEqual(5);
        for (const b of found) {
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.y).toBeGreaterThanOrEqual(0);
          expect(b.x + b.w).toBeLessThanOrEqual(w);
          expect(b.y + b.h).toBeLessThanOrEqual(h);
          expect(b.w * b.h).toBeGreaterThan(0);
        }
        expect(found.length === 0).toBe(m.every((v) => v === 0));
      }),
    );
  });

  it('finds the same places however many times it is asked', () => {
    fc.assert(
      fc.property(masks, ({ w, h, m }) => {
        expect(places(m, w, h)).toEqual(places(m, w, h));
      }),
    );
  });
});

describe('padded, for any place', () => {
  it('stays inside the shot and is at least 30 pixels a side where the shot allows', () => {
    fc.assert(
      fc.property(masks, ({ w, h, m }) => {
        const look = lookAt(m, w, h);
        if (!look) return;
        const z = look.zoom;
        expect(z.x).toBeGreaterThanOrEqual(0);
        expect(z.y).toBeGreaterThanOrEqual(0);
        expect(z.x + z.w).toBeLessThanOrEqual(w);
        expect(z.y + z.h).toBeLessThanOrEqual(h);
        expect(z.w).toBeGreaterThanOrEqual(Math.min(30, w));
        expect(z.h).toBeGreaterThanOrEqual(Math.min(30, h));
        expect(look.scale).toBeGreaterThanOrEqual(1);
        expect(z.w * look.scale).toBeLessThanOrEqual(Math.max(220, z.w));
        expect(z.h * look.scale).toBeLessThanOrEqual(Math.max(220, z.h));
        expect(padded(look.places[0], w, h)).toEqual(z);
      }),
    );
  });
});

describe('outlined, for any shot and places', () => {
  it('is at most 160 pixels wide and never throws', () => {
    fc.assert(
      fc.property(masks, ({ w, h, m }) => {
        const image = { width: w, height: h, data: new Uint8Array(w * h * 4) };
        const out = outlined(image, places(m, w, h));
        expect(out.width).toBeLessThanOrEqual(Math.max(160, Math.min(w, 160)));
        expect(out.width).toBeGreaterThan(0);
        expect(out.height).toBeGreaterThan(0);
        expect(out.data).toHaveLength(out.width * out.height * 4);
      }),
    );
  });
});
