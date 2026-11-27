import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatServerTiming, hasEntry, parseServerTiming } from './server-timing.ts';

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const tokenChar = fc.constantFrom(..."!#$%&'*+.^_`|~0123456789abcXYZ-".split(''));
const token = fc.string({ unit: tokenChar, minLength: 1, maxLength: 12 });
const ms = fc.double({ min: 0, max: 1e7, noNaN: true, noDefaultInfinity: true });
const entry = fc.record(
  {
    name: token,
    dur: ms,
    desc: fc.string(),
    calls: fc.nat(),
    slowest: ms,
    start: ms,
    span: ms,
  },
  { requiredKeys: ['name'] },
);
// Header-like text: entries, separators, quotes and junk, in any order.
const headerish = fc.oneof(
  fc.string(),
  fc
    .array(
      fc.oneof(
        token,
        fc.constantFrom(
          ',',
          ';',
          '=',
          '"',
          '\\',
          ' ',
          'dur',
          'desc',
          'span',
          'cold',
          '-1',
          '1.5',
          'NaN',
        ),
      ),
    )
    .map((parts) => parts.join('')),
);

describe('parseServerTiming, for any input', () => {
  it('never throws; each name is a token and each number finite and at least 0', () => {
    fc.assert(
      fc.property(headerish, (text) => {
        for (const e of parseServerTiming(text)) {
          expect(e.name).toMatch(TOKEN);
          for (const n of [e.dur, e.calls, e.slowest, e.start, e.span]) {
            if (n !== undefined) {
              expect(Number.isFinite(n)).toBe(true);
              expect(n).toBeGreaterThanOrEqual(0);
            }
          }
        }
      }),
    );
  });

  it('reads back any list of entries written as a header', () => {
    fc.assert(
      fc.property(fc.array(entry), (entries) => {
        // -0 is written as "0", and reads back as 0.
        const plain = entries.map((e) =>
          Object.fromEntries(Object.entries(e).map(([k, v]) => [k, Object.is(v, -0) ? 0 : v])),
        );
        expect(parseServerTiming(formatServerTiming(entries))).toEqual(plain);
      }),
    );
  });

  it('finds the cold flag wherever it sits among other entries', () => {
    fc.assert(
      fc.property(fc.array(entry), fc.array(entry), (before, after) => {
        const header = formatServerTiming([...before, { name: 'cold' }, ...after]);
        expect(hasEntry(parseServerTiming(header), 'cold')).toBe(true);
      }),
    );
  });
});
