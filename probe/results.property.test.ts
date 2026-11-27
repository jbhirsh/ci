import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatResults, parseResults } from './results.ts';

const ms = fc
  .double({ min: 0, max: 1e7, noNaN: true, noDefaultInfinity: true })
  .map((n) => (Object.is(n, -0) ? 0 : n));
const measurement = fc.record(
  {
    name: fc.string({ minLength: 1 }),
    phase: fc.string({ minLength: 1 }),
    start: fc.constantFrom('cold' as const, 'warm' as const),
    ms,
    label: fc.string(),
    calls: fc.nat(),
    slowestMs: ms,
    atMs: ms,
    spanMs: ms,
    requestStartMs: ms,
    responseStartMs: ms,
  },
  { requiredKeys: ['name', 'phase', 'start', 'ms'] },
);
const results = fc.record({
  version: fc.constant(1 as const),
  driver: fc.string(),
  target: fc.string(),
  environment: fc.string(),
  measurements: fc.array(measurement),
  notes: fc.array(fc.string()),
});

describe('the results format', () => {
  it('reads back any results written', () => {
    fc.assert(
      fc.property(results, (r) => {
        expect(parseResults(JSON.parse(formatResults(r)))).toEqual(r);
      }),
    );
  });

  it('never throws for any JSON, and keeps only valid rows', () => {
    const rowish = fc.oneof(
      fc.jsonValue(),
      fc.record({
        name: fc.oneof(fc.string(), fc.jsonValue()),
        phase: fc.oneof(fc.string(), fc.jsonValue()),
        start: fc.oneof(fc.constantFrom('cold', 'warm'), fc.jsonValue()),
        ms: fc.oneof(fc.double(), fc.jsonValue()),
        calls: fc.oneof(fc.double(), fc.jsonValue()),
        spanMs: fc.oneof(fc.double(), fc.jsonValue()),
      }),
    );
    const doc = fc.oneof(
      fc.jsonValue(),
      fc.record({ measurements: fc.array(rowish), notes: fc.array(fc.jsonValue()) }),
    );
    fc.assert(
      fc.property(doc, (value) => {
        const parsed = parseResults(value);
        for (const row of parsed.measurements) {
          expect(row.name).not.toBe('');
          expect(['cold', 'warm']).toContain(row.start);
          for (const n of [row.ms, row.calls, row.slowestMs, row.atMs, row.spanMs]) {
            if (n !== undefined) {
              expect(Number.isFinite(n)).toBe(true);
              expect(n).toBeGreaterThanOrEqual(0);
            }
          }
        }
        for (const note of parsed.notes) expect(typeof note).toBe('string');
      }),
    );
  });
});
