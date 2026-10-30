import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseLoad, parseNotes } from './summary.mjs';
import {
  busyPercent,
  loadRow,
  mergeNotes,
  parseLoadavg,
  parseNoteLines,
  parseProcStat,
} from './telemetry.mjs';

describe('parseNoteLines and mergeNotes, for any notes input', () => {
  it('never throws, accounts for every line with text, and writes notes summary.mjs reads back', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (text) => {
        const { notes, skipped } = parseNoteLines(text);
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        expect(notes.length + skipped.length).toBe(lines.length);
        for (const [label, value] of notes) {
          expect(label).toBe(label.trim());
          expect(label).not.toBe('');
          expect(label).not.toContain(':');
          expect(value).toBe(value.trim());
        }
        // The last value given for a label wins.
        expect(parseNotes(mergeNotes(null, notes))).toEqual(
          Object.entries(Object.fromEntries(notes)),
        );
      }),
    );
  });

  it('reads back the labels and values it was given', () => {
    const label = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => !/[:\r\n]/.test(s) && s.trim() === s && s !== '');
    const value = fc.string({ maxLength: 30 }).filter((s) => !/[\r\n]/.test(s) && s.trim() === s);
    fc.assert(
      fc.property(fc.array(fc.tuple(label, value), { maxLength: 6 }), (pairs) => {
        const text = pairs.map(([l, v]) => `${l}: ${v}`).join('\n');
        expect(parseNoteLines(text)).toEqual({ notes: pairs, skipped: [] });
      }),
    );
  });
});

describe('the CPU maths, for any input', () => {
  it('never throws on what /proc might hold, and reads only sound times', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (text) => {
        const cpu = parseProcStat(text);
        if (cpu) {
          expect(cpu.idle).toBeGreaterThanOrEqual(0);
          expect(cpu.total).toBeGreaterThanOrEqual(cpu.idle);
        }
        const load = parseLoadavg(text);
        if (load !== null) expect(load).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('reads back the ticks of a cpu line, and busy stays within 0 and 100', () => {
    const ticks = fc.array(fc.nat({ max: 1e9 }), { minLength: 10, maxLength: 10 });
    fc.assert(
      fc.property(ticks, ticks, (a, b) => {
        const before = parseProcStat(`cpu  ${a.join(' ')}\ncpu0 1 2 3 4`);
        const after = parseProcStat(`cpu  ${b.join(' ')}`);
        expect(before).toEqual({
          idle: a[3] + a[4],
          total: a.slice(0, 8).reduce((x, y) => x + y, 0),
        });
        if (!before || !after) return;
        const busy = busyPercent(before, after);
        if (after.total > before.total) {
          expect(busy).toBeGreaterThanOrEqual(0);
          expect(busy).toBeLessThanOrEqual(100);
        } else {
          expect(busy).toBeNull();
        }
      }),
    );
  });

  it('writes rows parseLoad reads back', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 600 }),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        (t, load, busy) => {
          const start = 1_761_800_000_000;
          const [sample] = parseLoad(loadRow(start + t * 1000, load, busy), start, 600);
          expect(sample.t).toBe(t);
          expect(sample.load).toBeCloseTo(load, 2);
          expect(Math.abs(sample.busy - busy)).toBeLessThanOrEqual(0.05 + 1e-9);
        },
      ),
    );
  });
});
