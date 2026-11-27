import { describe, expect, it } from 'vitest';
import { ms, table } from './table.ts';
import type { Measurement, Results } from './results.ts';

const results = (measurements: Measurement[], notes: string[] = []): Results => ({
  version: 1,
  driver: 'web',
  target: 'https://board-games-abc.vercel.app/',
  environment: 'preview',
  measurements,
  notes,
});

const warm5 = (
  name: string,
  phase: string,
  value: number,
  extra: Partial<Measurement> = {},
): Measurement[] =>
  [value, value * 2, value / 2, value, value * 3].map((m) => ({
    name,
    phase,
    start: 'warm',
    ms: m,
    ...extra,
  }));

describe('ms', () => {
  it("writes ms in job-summary's duration() format", () => {
    expect([812, 3400, 12, 0.2, 0].map(ms)).toEqual(['812ms', '3.4s', '12ms', '1ms', '0s']);
  });
});

describe('table', () => {
  it("writes the issue's example: cold beside the warm median, none for a cold-only phase", () => {
    const md = table(
      results(
        [
          { name: 'games', phase: 'loaded', start: 'cold', ms: 812 },
          { name: 'games', phase: 'db-open', start: 'cold', ms: 40 },
          { name: 'games', phase: 'total', start: 'cold', ms: 3400 },
          { name: 'games', phase: 'browser', start: 'cold', ms: 3600 },
          ...warm5('games', 'total', 12),
          ...warm5('games', 'browser', 410),
        ],
        ['cold carried by: games', '6 requests not sent: POST /_vercel/insights/view, not a read'],
      ),
      { repeats: 5 },
    );
    expect(md).toBe(
      [
        '### Performance probe',
        '',
        'https://board-games-abc.vercel.app/, preview',
        '',
        '| Request | Phase | Cold | Warm (median of 5) |',
        '|---|---|---:|---:|',
        '| games | loaded | 812ms | none |',
        '| games | db-open | 40ms | none |',
        '| games | total | 3.4s | 12ms |',
        '| games | browser | 3.6s | 410ms |',
        '',
        '- cold carried by: games',
        '- 6 requests not sent: POST /\\_vercel/insights/view, not a read',
        '',
      ].join('\n'),
    );
  });

  it("says none for a request that ran warm while another carried cold, and keeps a field's label", () => {
    const md = table(
      results([
        { name: 'games', phase: 'total', start: 'cold', ms: 3400 },
        ...warm5('games', 'field.games', 20, { label: 'Query.games' }),
        ...warm5('session', 'total', 8),
      ]),
    );
    expect(md).toContain('| games | field.games (Query.games) | none | 20ms |');
    expect(md).toContain('| session | total | none | 8ms |');
  });

  it('says not seen this run in every cold cell when no response carried cold', () => {
    const md = table(results([...warm5('games', 'total', 12), ...warm5('session', 'total', 8)]));
    expect(md).toContain('| games | total | not seen this run | 12ms |');
    expect(md).toContain('| session | total | not seen this run | 8ms |');
  });

  it('names the repeats setting in the Warm heading, whatever the rows hold', () => {
    // Two pages each expecting games (10 warm rows), or every warm one cached (none).
    const twice = table(results([...warm5('games', 'total', 12), ...warm5('games', 'total', 12)]), {
      repeats: 5,
    });
    expect(twice).toContain('| Request | Phase | Cold | Warm (median of 5) |');
    const cachedAll = table(results([{ name: 'games', phase: 'total', start: 'cold', ms: 9 }]), {
      repeats: 5,
    });
    expect(cachedAll).toContain('| Warm (median of 5) |');
    expect(cachedAll).toContain('| games | total | 9ms | none |');
    expect(table(results(warm5('games', 'total', 12)))).toContain('| Warm (median) |');
  });

  it('says when there are no measurements, and escapes what came from outside', () => {
    expect(table({ ...results([], ['measuring broke: games: answered 401']), target: '' })).toBe(
      [
        '### Performance probe',
        '',
        'preview',
        '',
        'No measurements this run.',
        '',
        '- measuring broke: games: answered 401',
        '',
      ].join('\n'),
    );
    expect(
      table(results([{ name: 'a|b', phase: '<x>', start: 'warm', ms: 1 }]), { title: 'Probe' }),
    ).toContain('| a\\|b | &lt;x&gt; | not seen this run | 1ms |');
  });
});
