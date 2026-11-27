import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { narrow, staysPut } from './narrow.ts';

// The incremental file is stored data a cache hands back, and the file now
// is whatever the PR holds. Few distinct lines, so repeats are common.
const lines = fc.array(fc.constantFrom('a', 'b', '', '  c', '/**'), { maxLength: 8 });

describe('staysPut, for any two texts', () => {
  it('takes no end line past the first difference, or whose start repeats later', () => {
    fc.assert(
      fc.property(lines, lines, fc.integer({ min: -1, max: 10 }), (a, b, end) => {
        const now = b.join('\r\n');
        if (!staysPut(a.join('\n'), now)(end)) return;
        const start = a.slice(0, end);
        expect(end).toBeGreaterThanOrEqual(1);
        expect(b.slice(0, end)).toEqual(start);
        expect(b.join('\n').indexOf(start.join('\n'), 1)).toBe(-1);
      }),
    );
  });
});

describe('narrow, for any report value', () => {
  it('never throws, and keeps only in-range mutants that stay put', () => {
    const position = fc.record({ line: fc.integer({ min: -1, max: 10 }) }, { requiredKeys: [] });
    const mutant = fc.record(
      {
        id: fc.string(),
        location: fc.record({ start: position, end: position }, { requiredKeys: [] }),
      },
      { requiredKeys: [] },
    );
    const file = fc.record(
      {
        source: fc.oneof(
          lines.map((l) => l.join('\n')),
          fc.anything(),
        ),
        mutants: fc.array(mutant),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom('src/a.ts', 'src/b.ts'), file),
        lines,
        fc.integer({ min: 1, max: 6 }),
        fc.nat(4),
        (files, now, first, span) => {
          const last = first + span;
          const text = now.join('\n');
          const out = narrow({ files }, [`src/a.ts:${first}-${last}`], '/repo', () => text);
          const source = files['src/a.ts']?.source;
          for (const m of out.files?.['src/a.ts']?.mutants ?? []) {
            const start = Number(m.location?.start?.line);
            const end = Number(m.location?.end?.line);
            expect(start >= first && end <= last).toBe(true);
            expect(typeof source).toBe('string');
            expect(staysPut(String(source), text)(end)).toBe(true);
          }
          expect(out.files?.['src/b.ts']).toBeUndefined();
        },
      ),
    );
  });
});
