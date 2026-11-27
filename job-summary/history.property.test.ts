import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseRecord } from './history.ts';

describe('parseRecord', () => {
  it('never throws for any text', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        parseRecord(text);
      }),
    );
  });

  it('never throws for any JSON, and keeps only valid times', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.jsonValue(),
          fc.record({
            version: fc.constant(3),
            seconds: fc.jsonValue(),
            measurements: fc.jsonValue(),
          }),
        ),
        (value) => {
          const kept = parseRecord(JSON.stringify(value));
          if (kept === null) return;
          expect(kept.seconds === null || kept.seconds >= 0).toBe(true);
          for (const v of kept.measurements?.values ?? [])
            expect(Number.isFinite(v.ms) && v.ms >= 0).toBe(true);
        },
      ),
    );
  });
});
