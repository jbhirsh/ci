import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { aggregate, formatResults, median, parseResults, writeResults } from './results.ts';
import type { Results } from './results.ts';

const EXAMPLE: Results = {
  version: 1,
  driver: 'web',
  target: 'https://board-games-b7b2zhx7g-jbhirshs-projects.vercel.app',
  environment: 'preview',
  measurements: [
    { name: 'games', phase: 'loaded', start: 'cold', ms: 812.3 },
    { name: 'games', phase: 'deps', start: 'cold', ms: 1.3 },
    { name: 'games', phase: 'db-open', start: 'cold', ms: 40 },
    { name: 'games', phase: 'total', start: 'cold', ms: 3400 },
    {
      name: 'games',
      phase: 'browser',
      start: 'cold',
      ms: 3620,
      requestStartMs: 0,
      responseStartMs: 3610,
    },
    { name: 'games', phase: 'total', start: 'warm', ms: 34.1 },
    {
      name: 'games',
      phase: 'field.games',
      label: 'Query.games',
      start: 'warm',
      ms: 20.6,
      calls: 1,
      atMs: 1.4,
    },
    {
      name: 'games',
      phase: 'field.games.bgg',
      label: 'Games.bgg',
      start: 'warm',
      ms: 8.9,
      calls: 1,
      atMs: 22.2,
    },
    {
      name: 'games',
      phase: 'field.games.wishlist.votes',
      label: 'Game.votes',
      start: 'warm',
      ms: 60,
      calls: 30,
      slowestMs: 2.4,
      atMs: 21,
      spanMs: 3.1,
    },
    {
      name: 'games',
      phase: 'browser',
      start: 'warm',
      ms: 248,
      requestStartMs: 0,
      responseStartMs: 146,
    },
  ],
  notes: ['cold carried by: games', '1 request not sent: POST /_vercel/insights/view, not a read'],
};

describe('parseResults', () => {
  it("reads the plan's example file as written", () => {
    expect(parseResults(JSON.parse(formatResults(EXAMPLE)))).toEqual(EXAMPLE);
  });

  it('keeps only valid rows, and drops a valid row’s invalid extras', () => {
    const parsed = parseResults({
      driver: 'app',
      measurements: [
        { name: 'a', phase: 'total', start: 'warm', ms: 1 },
        { name: '', phase: 'total', start: 'warm', ms: 1 },
        { name: 'a', phase: 'total', start: 'hot', ms: 1 },
        { name: 'a', phase: 'total', start: 'cold', ms: -1 },
        { name: 'a', phase: 'total', start: 'cold', ms: null },
        { name: 'a', phase: 7, start: 'cold', ms: 1 },
        'row',
        [1],
        {
          name: 'b',
          phase: 'f',
          start: 'cold',
          ms: 0,
          calls: -2,
          atMs: 3,
          spanMs: -1,
          label: 4,
          extra: true,
        },
      ],
      notes: ['one', 2],
    });
    expect(parsed).toEqual({
      version: 1,
      driver: 'app',
      target: '',
      environment: '',
      measurements: [
        { name: 'a', phase: 'total', start: 'warm', ms: 1 },
        { name: 'b', phase: 'f', start: 'cold', ms: 0, atMs: 3 },
      ],
      notes: ['one'],
    });
  });

  it('reads anything else as empty results', () => {
    for (const value of [null, 3, 'x', [], { measurements: 'no' }]) {
      expect(parseResults(value).measurements).toEqual([]);
    }
  });
});

describe('writeResults', () => {
  it('writes the file, making its folder', () => {
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), 'probe-results-')),
      'probe',
      'results.json',
    );
    writeResults(file, EXAMPLE);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(EXAMPLE);
  });
});

describe('median', () => {
  it('is the middle value, or the mean of the middle two', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
  });
});

describe('aggregate', () => {
  it('pairs each phase’s cold row with its warm median, in the order first seen', () => {
    const warm = (phase: string, ms: number) => ({
      name: 'games',
      phase,
      start: 'warm' as const,
      ms,
    });
    expect(
      aggregate([
        ...EXAMPLE.measurements.slice(0, 5),
        warm('total', 30),
        warm('total', 50),
        warm('total', 10),
        { ...warm('field.games', 20), label: 'Query.games' },
        { name: 'session', phase: 'total', start: 'warm', ms: 5 },
        { name: 'games', phase: 'total', start: 'cold', ms: 1 },
      ]),
    ).toEqual([
      { name: 'games', phase: 'loaded', label: undefined, cold: 812.3, warm: null, warmCount: 0 },
      { name: 'games', phase: 'deps', label: undefined, cold: 1.3, warm: null, warmCount: 0 },
      { name: 'games', phase: 'db-open', label: undefined, cold: 40, warm: null, warmCount: 0 },
      { name: 'games', phase: 'total', label: undefined, cold: 3400, warm: 30, warmCount: 3 },
      { name: 'games', phase: 'browser', label: undefined, cold: 3620, warm: null, warmCount: 0 },
      {
        name: 'games',
        phase: 'field.games',
        label: 'Query.games',
        cold: null,
        warm: 20,
        warmCount: 1,
      },
      { name: 'session', phase: 'total', label: undefined, cold: null, warm: 5, warmCount: 1 },
    ]);
  });
});
