import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cell, duration } from './render.mjs';

describe('cell, for any text', () => {
  it('is one line with no unescaped bar', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        const out = cell(text);
        expect(out).not.toMatch(/[\n\r]/);
        expect(out).not.toMatch(/(^|[^\\])\|/);
      }),
    );
  });
});

describe('duration, for any time', () => {
  it('reads as milliseconds, seconds, minutes or hours', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e6, noNaN: true }), (s) => {
        expect(duration(s)).toMatch(/^(\d+ms|\d+(\.\d)?s|\d+m \d\ds|\d+h \d\dm)$/);
      }),
    );
  });
});
