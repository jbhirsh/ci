import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { measureSlower, measureTrend, parseRecorded, recorded } from './measures.ts';
import { parseResults } from '../probe/results.ts';

const ms = fc
  .double({ min: 0, max: 1e7, noNaN: true, noDefaultInfinity: true })
  .map((n) => (Object.is(n, -0) ? 0 : n));
const phase = fc.oneof(
  fc.constantFrom('browser', 'total', 'loaded', 'db-open', 'field.games', 'field.games.bgg'),
  fc.string({ minLength: 1 }),
);
/** A row as a driver writes it. */
const row = fc.record(
  {
    name: fc.constantFrom('games', 'session'),
    phase,
    start: fc.constantFrom('cold', 'warm'),
    ms,
    label: fc.string(),
    calls: fc.nat(),
    atMs: ms,
    requestStartMs: ms,
    responseStartMs: ms,
  },
  { requiredKeys: ['name', 'phase', 'start', 'ms'] },
);

describe('the ms rule', () => {
  it('is never slower at or under usual', () => {
    fc.assert(
      fc.property(ms, ms, phase, (a, b, p) => {
        const [value, typical] = a <= b ? [a, b] : [b, a];
        expect(measureSlower(value, typical, p)).toBe(false);
      }),
    );
  });

  it('puts usual between the earlier values’ least and greatest', () => {
    fc.assert(
      fc.property(ms, fc.array(fc.option(ms, { nil: null })), phase, (value, past, p) => {
        const { usual } = measureTrend(value, past, p);
        const got = past.filter((v) => v !== null);
        if (got.length < 3) expect(usual).toBeNull();
        else {
          expect(usual).toBeGreaterThanOrEqual(Math.min(...got));
          expect(usual).toBeLessThanOrEqual(Math.max(...got));
        }
      }),
    );
  });
});

describe('a record’s measurements', () => {
  it('never throw for any JSON, and keep only valid values', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const kept = parseRecorded(value);
        for (const v of kept?.values ?? []) {
          expect(Number.isFinite(v.ms) && v.ms >= 0).toBe(true);
          expect(['cold', 'warm']).toContain(v.start);
        }
      }),
    );
  });

  it('read back what any results file recorded, a value per request, phase and start', () => {
    fc.assert(
      fc.property(fc.array(row), fc.string(), (rows, environment) => {
        const results = parseResults({ version: 1, environment, measurements: rows });
        const kept = recorded(results);
        expect(parseRecorded(JSON.parse(JSON.stringify(kept)))).toEqual(kept);
        const keys = new Set(rows.map((r) => JSON.stringify([r.name, r.phase, r.start])));
        expect(kept.values).toHaveLength(keys.size);
        expect(kept.environment).toBe(environment);
      }),
    );
  });
});
