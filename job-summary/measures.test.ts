import { describe, expect, it } from 'vitest';
import {
  BROWSER_FLOOR_MS,
  MEASURE_FLOOR_MS,
  MEASURE_RATIO,
  measureSlower,
  measureTrend,
  parseRecorded,
  recorded,
  summarize,
} from './measures.ts';
import type { Measurement, Results } from '../probe/results.ts';

/** A games row, as the probe writes one. */
const games = (
  phase: string,
  start: 'cold' | 'warm',
  ms: number,
  more: Partial<Measurement> = {},
): Measurement => ({ name: 'games', phase, start, ms, ...more });

/** The plan's example results file (ci#151): a cold load, then warm ones. */
const example: Measurement[] = [
  games('loaded', 'cold', 812.3),
  games('deps', 'cold', 1.3),
  games('db-open', 'cold', 40),
  games('total', 'cold', 3400),
  games('browser', 'cold', 3620, { requestStartMs: 0, responseStartMs: 3610 }),
  games('total', 'warm', 34.1),
  games('field.games', 'warm', 20.6, { label: 'Query.games', calls: 1, atMs: 1.4 }),
  games('field.games.bgg', 'warm', 8.9, { label: 'Games.bgg', calls: 1, atMs: 22.2 }),
  games('browser', 'warm', 248, { requestStartMs: 0, responseStartMs: 146 }),
  games('total', 'warm', 40),
  games('total', 'warm', 30),
  { name: 'session', phase: 'total', start: 'warm', ms: 14 },
];

const results = (measurements: Measurement[], environment = 'preview'): Results => ({
  version: 1,
  driver: 'web',
  target: 'https://x.vercel.app',
  environment,
  measurements,
  notes: [],
});

describe('measureSlower', () => {
  it('is 1.25 times usual and at least 5 ms more', () => {
    expect(MEASURE_RATIO).toBe(1.25);
    expect(MEASURE_FLOOR_MS).toBe(5);
    expect(measureSlower(25, 20, 'total')).toBe(true);
    expect(measureSlower(24.9, 20, 'total')).toBe(false);
    // The ratio alone isn't enough: a 0.8 ms field doubling isn't news.
    expect(measureSlower(1.6, 0.8, 'field.games')).toBe(false);
    expect(measureSlower(14.9, 10, 'db-open')).toBe(false);
    expect(measureSlower(15, 10, 'db-open')).toBe(true);
  });

  it("asks 20 ms more of the browser's own time", () => {
    expect(BROWSER_FLOOR_MS).toBe(20);
    expect(measureSlower(99, 80, 'browser')).toBe(false);
    expect(measureSlower(100, 80, 'browser')).toBe(true);
    expect(measureSlower(10, 4, 'browser')).toBe(false);
  });

  it('is never slower without a usual', () => {
    expect(measureSlower(1e6, null, 'total')).toBe(false);
  });
});

describe('measureTrend', () => {
  it('needs 3 earlier values for a usual', () => {
    expect(measureTrend(100, [10, null, 10], 'total')).toEqual({ usual: null, slower: false });
    expect(measureTrend(100, [10, null, 10, 12], 'total')).toEqual({ usual: 10, slower: true });
  });
});

describe('summarize', () => {
  it("keeps the first cold row and the warm rows' medians, in the order first seen", () => {
    const rows = summarize(example);
    expect(rows.map((r) => [r.name, r.phase, r.start, r.ms])).toEqual([
      ['games', 'loaded', 'cold', 812.3],
      ['games', 'deps', 'cold', 1.3],
      ['games', 'db-open', 'cold', 40],
      ['games', 'total', 'cold', 3400],
      ['games', 'browser', 'cold', 3620],
      ['games', 'total', 'warm', 34.1],
      ['games', 'field.games', 'warm', 20.6],
      ['games', 'field.games.bgg', 'warm', 8.9],
      ['games', 'browser', 'warm', 248],
      ['session', 'total', 'warm', 14],
    ]);
    expect(rows[6]).toEqual({
      name: 'games',
      phase: 'field.games',
      start: 'warm',
      ms: 20.6,
      label: 'Query.games',
      calls: 1,
      atMs: 1.4,
    });
  });

  it('takes the median of each number of the warm rows', () => {
    const [row] = summarize([
      { name: 'a', phase: 'browser', start: 'warm', ms: 10, responseStartMs: 4 },
      { name: 'a', phase: 'browser', start: 'warm', ms: 30, responseStartMs: 8 },
      { name: 'a', phase: 'browser', start: 'warm', ms: 20 },
    ]);
    expect(row).toEqual({ name: 'a', phase: 'browser', start: 'warm', ms: 20, responseStartMs: 6 });
  });

  it('keeps only the first cold row', () => {
    expect(
      summarize([
        { name: 'a', phase: 'total', start: 'cold', ms: 10 },
        { name: 'a', phase: 'total', start: 'cold', ms: 99 },
      ]).map((r) => r.ms),
    ).toEqual([10]);
  });
});

describe('recorded', () => {
  it('keeps one value per request, phase and start, and the environment', () => {
    const kept = recorded(results(example));
    expect(kept.environment).toBe('preview');
    expect(kept.values).toContainEqual({ name: 'games', phase: 'total', start: 'warm', ms: 34.1 });
    expect(kept.values).toContainEqual({ name: 'games', phase: 'total', start: 'cold', ms: 3400 });
    expect(kept.values).toHaveLength(10);
  });
});

describe('parseRecorded', () => {
  it('reads what recorded wrote', () => {
    const kept = recorded(results(example));
    expect(parseRecorded(JSON.parse(JSON.stringify(kept)))).toEqual(kept);
  });

  it('leaves out values that are not valid, and is null without a list', () => {
    expect(
      parseRecorded({
        values: [
          { name: 'a', phase: 'total', start: 'warm', ms: 1 },
          { name: 'a', phase: 'total', start: 'hot', ms: 1 },
          { name: '', phase: 'total', start: 'warm', ms: 1 },
          { name: 'a', phase: 'total', start: 'warm', ms: -1 },
          null,
        ],
      }),
    ).toEqual({ environment: '', values: [{ name: 'a', phase: 'total', start: 'warm', ms: 1 }] });
    expect(parseRecorded(null)).toBeNull();
    expect(parseRecorded([])).toBeNull();
    expect(parseRecorded({ values: 'no' })).toBeNull();
  });
});
