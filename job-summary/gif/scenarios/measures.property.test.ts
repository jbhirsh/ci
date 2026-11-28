import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { wheelStop } from './measures.ts';

/** A length the browser reports, in CSS pixels: fractional on a dense screen. */
const px = fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true });
/** A turn of the wheel, either way, in whole pixels as the scenario turns it. */
const turn = fc.integer({ min: -1e6, max: 1e6 });

describe('wheelStop', () => {
  it('stops on a whole pixel, between the top and the furthest the page scrolls', () => {
    fc.assert(
      fc.property(px, turn, px, px, (scrollY, dy, scrollHeight, innerHeight) => {
        const stop = wheelStop(scrollY, dy, scrollHeight, innerHeight);
        expect(Number.isInteger(stop)).toBe(true);
        expect(stop).toBeGreaterThanOrEqual(0);
        expect(stop).toBeLessThanOrEqual(Math.max(0, Math.round(scrollHeight - innerHeight)));
      }),
      { numRuns: 500 },
    );
  });

  it('moves by the whole turn when the page has room for it', () => {
    fc.assert(
      fc.property(px, turn, px, (scrollY, dy, innerHeight) => {
        // A page long enough for the turn, and a turn that stays below the top.
        fc.pre(scrollY + dy >= 0);
        const scrollHeight = scrollY + Math.abs(dy) + innerHeight + 1;
        expect(wheelStop(scrollY, dy, scrollHeight, innerHeight)).toBe(Math.round(scrollY + dy));
      }),
      { numRuns: 500 },
    );
  });
});
