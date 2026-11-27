import { describe, expect, it } from 'vitest';
import {
  BROWSER_FLOOR_MS,
  MEASURE_FLOOR_MS,
  MEASURE_RATIO,
  measureSlower,
  measureTrend,
  parseRecorded,
  rawEntry,
  recorded,
  requests,
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

describe('requests', () => {
  it('lists each request, its parts in the order things happen', () => {
    const [games, session] = requests(example);
    expect(games.name).toBe('games');
    expect(games.parts.map((p) => [p.key, p.title, p.label, p.path, p.kind, p.depth])).toEqual([
      ['browser', 'Browser', 'browser', '', 'browser', 0],
      ['loaded', 'Loading the code', 'loaded', '', 'cold', 1],
      ['total', 'Server', 'total', '', 'server', 1],
      ['deps', 'Building services', 'deps', '', 'cold', 2],
      ['db-open', 'Opening the database', 'db-open', '', 'cold', 2],
      ['field.games', 'Query.games', 'Query.games', 'games', 'field', 2],
      ['field.games.bgg', 'Games.bgg', 'Games.bgg', 'games.bgg', 'field', 3],
    ]);
    expect(session.parts.map((p) => p.key)).toEqual(['total']);
  });

  it('places the server to end when the browser saw its headers, and loading the code before it', () => {
    const [games] = requests(example);
    const at = (key: string, start: 'cold' | 'warm') =>
      games.parts.find((p) => p.key === key)?.[start]?.at;
    expect(at('browser', 'cold')).toBe(0);
    expect(at('total', 'cold')).toBe(210);
    // Loading the code took longer than the browser waited before the server: from 0.
    expect(at('loaded', 'cold')).toBe(0);
    expect(at('total', 'warm')).toBeCloseTo(146 - 34.1);
    // At the server's start plus their own start.
    expect(at('field.games', 'warm')).toBeCloseTo(146 - 34.1 + 1.4);
    expect(at('field.games.bgg', 'warm')).toBeCloseTo(146 - 34.1 + 22.2);
  });

  it('titles a phase by its own name when it has none of its own, even one an object inherits', () => {
    const [a] = requests([
      { name: 'a', phase: 'total', start: 'warm', ms: 10 },
      { name: 'a', phase: 'constructor', start: 'warm', ms: 2 },
      { name: 'a', phase: 'toString', start: 'warm', ms: 1 },
    ]);
    expect(a.parts.map((p) => p.title)).toEqual(['Server', 'constructor', 'toString']);
  });

  it("counts the browser's times from its request's start", () => {
    const [a] = requests([
      {
        name: 'a',
        phase: 'browser',
        start: 'warm',
        ms: 200,
        requestStartMs: 150,
        responseStartMs: 300,
      },
      { name: 'a', phase: 'total', start: 'warm', ms: 100 },
    ]);
    const server = a.parts.find((p) => p.key === 'total')?.warm;
    expect([server?.at, (server?.at ?? 0) + (server?.ms ?? 0)]).toEqual([50, 150]);
  });

  it("gives a server with no total its parts' span, ending when its headers arrived", () => {
    const [a] = requests([
      { name: 'a', phase: 'browser', start: 'warm', ms: 200, responseStartMs: 150 },
      { name: 'a', phase: 'deps', start: 'warm', ms: 10 },
      { name: 'a', phase: 'field.x', start: 'warm', ms: 30, atMs: 20 },
    ]);
    expect(a.parts.map((p) => [p.key, p.warm?.at])).toEqual([
      ['browser', 0],
      ['deps', 100],
      ['field.x', 120],
    ]);
    // Without a browser row, from 0.
    const [b] = requests([{ name: 'b', phase: 'deps', start: 'cold', ms: 10, atMs: 4 }]);
    expect(b.parts[0].cold?.at).toBe(4);
  });

  it('places parts one after another in header order when the app sends no start', () => {
    const [a] = requests([
      { name: 'a', phase: 'browser', start: 'cold', ms: 500, responseStartMs: 400 },
      { name: 'a', phase: 'loaded', start: 'cold', ms: 100 },
      { name: 'a', phase: 'deps', start: 'cold', ms: 2 },
      { name: 'a', phase: 'db-open', start: 'cold', ms: 40 },
      { name: 'a', phase: 'total', start: 'cold', ms: 200 },
    ]);
    expect(a.parts.map((p) => [p.key, p.cold?.at])).toEqual([
      ['browser', 0],
      ['loaded', 100],
      ['total', 200],
      ['deps', 200],
      ['db-open', 202],
    ]);
  });

  it('nests fields by path, siblings in the order first seen, whatever the header order', () => {
    const field = (path: string): Measurement => ({
      name: 'a',
      phase: `field.${path}`,
      start: 'warm',
      ms: 1,
    });
    const [a] = requests(['b.x', 'a', 'b', 'a.y', 'a.y.z', 'c.q'].map(field));
    expect(a.parts.map((p) => [p.path, p.depth])).toEqual([
      ['b', 2],
      ['b.x', 3],
      ['a', 2],
      ['a.y', 3],
      ['a.y.z', 4],
      // Its parent wasn't timed: it sits where a top field would.
      ['c.q', 2],
    ]);
  });

  it('names a phase it has no words for by its code, and calls a warm one a phase', () => {
    const [a] = requests([
      { name: 'a', phase: 'auth', start: 'warm', ms: 3 },
      { name: 'a', phase: 'auth-init', start: 'cold', ms: 3 },
    ]);
    expect(a.parts.map((p) => [p.title, p.kind])).toEqual([
      ['auth', 'phase'],
      ['Setting up sign-in', 'cold'],
    ]);
  });
});

describe('rawEntry', () => {
  it("writes a part's Server-Timing entry, none for the browser's own time", () => {
    const [games] = requests(example);
    const raw = (key: string) => {
      const part = games.parts.find((p) => p.key === key);
      return rawEntry(part?.warm ?? part?.cold ?? example[0]);
    };
    expect(raw('field.games.bgg')).toBe(
      'field.games.bgg;dur=8.9;desc="Games.bgg";calls=1;start=22.2',
    );
    expect(raw('db-open')).toBe('db-open;dur=40');
    expect(raw('browser')).toBe('');
    expect(rawEntry({ name: 'a', phase: 'total', start: 'warm', ms: 1 / 3 })).toBe(
      'total;dur=0.33',
    );
  });
});
