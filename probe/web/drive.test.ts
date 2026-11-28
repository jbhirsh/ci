import { describe, expect, it } from 'vitest';
import { parseSettings } from '../settings.ts';
import { BYPASS_HEADER, drive, SET_COOKIE_HEADER } from './drive.ts';
import { testBrowser } from './test-browser.ts';
import type { DriveOptions } from './drive.ts';
import type { Answer, Bypass, Sent } from './test-browser.ts';

const TARGET = 'https://board-games-abc.vercel.app/';
const API = `${TARGET}api/graphql`;
const GAMES = `${API}?operationName=Games&query=${encodeURIComponent('query Games { games }')}`;
const SESSION = { url: API, method: 'POST', body: JSON.stringify({ operationName: 'Session' }) };
const COLD =
  'cold, loaded;dur=812.3, db-open;dur=40, field.games;dur=20.6;desc="Query.games";calls=1;start=1.4, field.games.votes;dur=60;desc="Game.votes";calls=30;slowest=2.4;start=21;span=3.1, total;dur=3400';
const WARM = 'total;dur=34.1';

const settings = parseSettings({
  pages: [{ path: '/', expect: ['games'] }],
  requests: [
    { name: 'games', path: '/api/graphql', operation: 'Games' },
    { name: 'session', path: '/api/graphql', method: 'POST', operation: 'Session' },
  ],
  reads: [{ method: 'POST', path: '/api/graphql', operation: 'Session' }],
  previewSafe: [{ method: 'POST', path: '/api/graphql', operation: 'Vote' }],
  repeats: 2,
  hosts: ['*.vercel.app'],
  headers: { 'x-synthetic': 'probe' },
});

/**
 * A deployment whose first API request is cold, and whose page makes the
 * games query and whatever else `extra` names.
 */
function deployment({
  extra = [],
  answer,
  gotoFails,
  bypass,
}: {
  extra?: Sent[];
  answer?: (r: Sent & { method: string }, load: number) => Answer | undefined;
  gotoFails?: string;
  bypass?: Bypass;
} = {}) {
  let served = false;
  return testBrowser({
    gotoFails,
    bypass,
    page: () => [{ url: GAMES }, ...extra],
    answer: (request, load) => {
      const custom = answer?.(request, load);
      if (custom) return custom;
      if (!request.url.startsWith(API)) return {};
      const cold = !served;
      served = true;
      return {
        headers: { 'server-timing': cold ? COLD : WARM },
        timing: cold
          ? { requestStart: 2, responseStart: 3410, responseEnd: 3420 }
          : { requestStart: 0, responseStart: 140, responseEnd: 150 },
      };
    },
  });
}

const run = (fake: ReturnType<typeof testBrowser>, options: Partial<DriveOptions> = {}) =>
  drive({
    browser: fake.browser,
    settings,
    target: TARGET,
    environment: 'production',
    secret: 's3cret',
    ...options,
  });

describe('drive', () => {
  it('measures the cold load and the warm repeats, each in a fresh context with service workers blocked', async () => {
    const fake = deployment();
    const outcome = await run(fake);
    expect(fake.contexts).toEqual([
      { serviceWorkers: 'block' },
      { serviceWorkers: 'block' },
      { serviceWorkers: 'block' },
    ]);
    expect(outcome.problems).toEqual([]);
    expect(outcome.notes).toEqual(['cold carried by: games']);
    const warmRows = [
      { name: 'games', phase: 'total', start: 'warm', ms: 34.1 },
      {
        name: 'games',
        phase: 'browser',
        start: 'warm',
        ms: 150,
        requestStartMs: 0,
        responseStartMs: 140,
      },
    ];
    expect(outcome.measurements).toEqual([
      { name: 'games', phase: 'loaded', start: 'cold', ms: 812.3 },
      { name: 'games', phase: 'db-open', start: 'cold', ms: 40 },
      {
        name: 'games',
        phase: 'field.games',
        start: 'cold',
        ms: 20.6,
        label: 'Query.games',
        calls: 1,
        atMs: 1.4,
      },
      {
        name: 'games',
        phase: 'field.games.votes',
        start: 'cold',
        ms: 60,
        label: 'Game.votes',
        calls: 30,
        slowestMs: 2.4,
        atMs: 21,
        spanMs: 3.1,
      },
      { name: 'games', phase: 'total', start: 'cold', ms: 3400 },
      {
        name: 'games',
        phase: 'browser',
        start: 'cold',
        ms: 3418,
        requestStartMs: 2,
        responseStartMs: 3410,
      },
      ...warmRows,
      ...warmRows,
    ]);
  });

  it("sets the bypass cookie with the secret once a load, and adds only the app's headers to the deployment's exact origin", async () => {
    const fake = deployment({
      extra: [
        { url: 'https://board-games-abc.vercel.app:8443/x' },
        { url: 'http://board-games-abc.vercel.app/x' },
        { url: 'https://fonts.example/font.woff2' },
      ],
    });
    await run(fake);
    expect(fake.setups).toEqual(
      Array(3).fill({
        url: TARGET,
        options: {
          headers: {
            'x-synthetic': 'probe',
            [BYPASS_HEADER]: 's3cret',
            [SET_COOKIE_HEADER]: 'true',
          },
          maxRedirects: 0,
          timeout: 90_000,
        },
      }),
    );
    const own = fake.seen.filter((s) => s.url.startsWith(TARGET));
    const other = fake.seen.filter((s) => !s.url.startsWith(TARGET));
    expect(own.length).toBeGreaterThan(0);
    expect(other).toHaveLength(9);
    for (const s of own) expect(s.headers).toEqual({ accept: '*/*', 'x-synthetic': 'probe' });
    for (const s of other) expect(s.headers).toEqual({ accept: '*/*' });
  });

  it('makes no bypass request when no secret is given', async () => {
    const fake = deployment();
    const outcome = await run(fake, { secret: '' });
    expect(fake.setups).toEqual([]);
    expect(outcome.problems).toEqual([]);
  });

  it('goes on when Vercel sets the cookie with a redirect back to the deployment', async () => {
    const fake = deployment({
      bypass: {
        status: 307,
        headers: { location: '/', 'set-cookie': '_vercel_jwt=x; Path=/; HttpOnly' },
      },
    });
    const outcome = await run(fake);
    expect(outcome.problems).toEqual([]);
    expect(outcome.measurements.length).toBeGreaterThan(0);
  });

  it.each([
    [307, 'the bypass secret was refused (answered 307): check VERCEL_AUTOMATION_BYPASS_SECRET'],
    [
      {
        status: 307,
        headers: { location: 'https://vercel.com/sso-api?url=x', 'set-cookie': 'a=b' },
      },
      'the bypass secret was refused (answered 307): check VERCEL_AUTOMATION_BYPASS_SECRET',
    ],
    [
      { status: 307, headers: { location: '/' } },
      'the bypass secret was refused (answered 307): check VERCEL_AUTOMATION_BYPASS_SECRET',
    ],
    [401, 'the bypass secret was refused (answered 401): check VERCEL_AUTOMATION_BYPASS_SECRET'],
    [403, 'the bypass secret was refused (answered 403): check VERCEL_AUTOMATION_BYPASS_SECRET'],
    [500, "the bypass cookie's request to / answered 500"],
    ['socket hang up', "the bypass cookie's request failed: socket hang up"],
  ])('fails, loading nothing, when the bypass request answers %j', async (bypass, problem) => {
    const fake = deployment({ bypass });
    const outcome = await run(fake);
    expect(outcome.problems).toEqual([problem]);
    expect(fake.seen).toEqual([]);
    expect(outcome.measurements).toEqual([]);
  });

  it('aborts an unlisted write to any origin, and notes it with its origin', async () => {
    const sentry = 'https://o1.ingest.sentry.io/api/1/envelope/';
    const fake = deployment({ extra: [{ url: sentry, method: 'POST', body: '{}' }] });
    const outcome = await run(fake);
    expect(fake.aborted).toEqual(Array(3).fill(`POST ${sentry}`));
    expect(outcome.problems).toEqual([]);
    expect(outcome.notes).toContain(
      '3 requests not sent: POST https://o1.ingest.sentry.io/api/1/envelope/, not a read',
    );
  });

  it("refuses a page whose path leads off the deployment's origin", async () => {
    const fake = deployment();
    const outcome = await run(fake, {
      settings: { ...settings, pages: [{ path: '//evil.example/', expect: ['games'] }] },
    });
    expect(outcome.problems).toEqual([
      "//evil.example/: leads to https://evil.example, not the deployment's origin",
    ]);
    expect(fake.contexts).toEqual([]);
  });

  it('aborts an unlisted write before it leaves the browser, and notes it', async () => {
    const insights = { url: `${TARGET}_vercel/insights/view`, method: 'POST', body: '{}' };
    const fake = deployment({ extra: [insights] });
    const outcome = await run(fake);
    expect(fake.aborted).toEqual(Array(3).fill(`POST ${insights.url}`));
    expect(fake.seen.map((s) => s.url)).not.toContain(insights.url);
    expect(outcome.problems).toEqual([]);
    expect(outcome.notes).toContain('3 requests not sent: POST /_vercel/insights/view, not a read');
  });

  it('sends a read in both environments, and a preview-safe write on a preview only', async () => {
    const vote = { url: API, method: 'POST', body: JSON.stringify({ operationName: 'Vote' }) };
    for (const environment of ['production', 'preview'] as const) {
      const fake = deployment({ extra: [SESSION, vote] });
      const outcome = await run(fake, { environment });
      const sent = fake.seen.filter((s) => s.method === 'POST').length;
      if (environment === 'production') {
        expect(sent).toBe(3);
        expect(fake.aborted).toHaveLength(3);
        expect(outcome.notes).toContain(
          '3 requests not sent: POST /api/graphql (Vote), not a read',
        );
      } else {
        expect(sent).toBe(6);
        expect(fake.aborted).toEqual([]);
      }
      expect(outcome.problems).toEqual([]);
    }
  });

  it('reads the cold flag from a request it does not time, and names it', async () => {
    const health = `${TARGET}api/health`;
    let first = true;
    const fake = deployment({
      extra: [{ url: health }],
      answer: (request) => {
        if (request.url === GAMES) return { headers: { 'server-timing': WARM } };
        if (request.url !== health) return undefined;
        const cold = first;
        first = false;
        return { headers: { 'server-timing': cold ? 'cold, total;dur=9' : 'total;dur=1' } };
      },
    });
    const outcome = await run(fake);
    expect(outcome.notes[0]).toBe('cold carried by: GET /api/health');
    // The games query on load 1 carries no flag: it's left out, being
    // neither a cold start's nor a warm repeat's.
    expect(outcome.measurements.filter((m) => m.start === 'cold')).toEqual([]);
    expect(outcome.measurements.filter((m) => m.phase === 'total')).toHaveLength(2);
    expect(outcome.notes).toContain(
      '1 response on the first load left out: not cold, not a repeat',
    );
  });

  it('says plainly when no response carried the cold flag, and guesses nothing', async () => {
    const fake = deployment({ answer: () => ({ headers: { 'server-timing': WARM } }) });
    const outcome = await run(fake);
    expect(outcome.notes[0]).toBe(
      'cold not seen this run: no response carried the cold flag (cold)',
    );
    expect(outcome.measurements.every((m) => m.start === 'warm')).toBe(true);
  });

  it('leaves out responses a cache answered, and counts them', async () => {
    const fake = deployment({
      answer: (request, load) => {
        if (request.url !== GAMES || load === 0) return undefined;
        const cache: Record<string, string> =
          load === 1 ? { 'x-vercel-cache': 'HIT' } : { age: '12' };
        return { headers: { 'server-timing': WARM, ...cache } };
      },
    });
    const outcome = await run(fake);
    expect(outcome.measurements.filter((m) => m.start === 'warm')).toEqual([]);
    expect(outcome.notes).toContain(
      '2 cached responses left out (Age above 0, or x-vercel-cache: HIT)',
    );
  });

  it.each([
    [
      { status: 401 },
      'games: answered 401: check the bypass secret (VERCEL_AUTOMATION_BYPASS_SECRET, and probe.hosts)',
    ],
    [{ status: 500, headers: { 'server-timing': WARM } }, 'games: answered 500'],
    [{ headers: {} }, 'games: its response has no Server-Timing header'],
    [
      { headers: { 'server-timing': 'cold, miss' } },
      'games: its Server-Timing has no entry with a dur',
    ],
  ])('fails when measuring breaks: %j', async (answer, problem) => {
    const fake = deployment({ answer: (r) => (r.url === GAMES ? answer : undefined) });
    const outcome = await run(fake);
    expect(outcome.problems).toEqual([problem]);
    expect(outcome.measurements).toEqual([]);
  });

  it('fails, naming it, when the page never makes a listed request', async () => {
    const fake = testBrowser({ page: () => [], answer: () => ({}) });
    const outcome = await run(fake);
    expect(outcome.problems).toEqual(['games: / never made this request within 90s']);
  });

  it('fails when a listed request had to be aborted', async () => {
    const strict = parseSettings({
      pages: [{ path: '/', expect: ['session'] }],
      requests: [{ name: 'session', path: '/api/graphql', method: 'POST', operation: 'Session' }],
      repeats: 1,
    });
    const fake = deployment({ extra: [SESSION] });
    const outcome = await run(fake, { settings: strict, environment: 'preview' });
    expect(outcome.problems).toEqual([
      'session: aborted, as POST /api/graphql (Session) is not a read or preview-safe (probe.reads, probe.previewSafe)',
    ]);
    expect(outcome.notes).toContain(
      '2 requests not sent: POST /api/graphql (Session), not a read or preview-safe',
    );
  });

  it('ends the wait of every listed request an abort matches, with no hang', async () => {
    const twice = parseSettings({
      pages: [{ path: '/', expect: ['session', 'login'] }],
      requests: [
        { name: 'session', path: '/api/graphql', method: 'POST', operation: 'Session' },
        { name: 'login', path: '/api/graphql', operation: 'Session' },
      ],
      repeats: 1,
    });
    const outcome = await run(deployment({ extra: [SESSION] }), { settings: twice });
    expect(outcome.problems).toEqual([
      'session: aborted, as POST /api/graphql (Session) is not a read (probe.reads)',
      'login: aborted, as POST /api/graphql (Session) is not a read (probe.reads)',
    ]);
  });

  it("fails when a page doesn't load", async () => {
    const outcome = await run(deployment({ gotoFails: 'net::ERR_NAME_NOT_RESOLVED' }));
    expect(outcome.problems).toEqual(["/: didn't load: net::ERR_NAME_NOT_RESOLVED"]);
  });

  it("notes a response without the browser's own timing, and keeps its server rows", async () => {
    const fake = deployment({
      answer: (r, load) =>
        r.url === GAMES && load > 0
          ? {
              headers: { 'server-timing': WARM },
              timing: { requestStart: -1, responseStart: -1, responseEnd: -1 },
            }
          : undefined,
    });
    const outcome = await run(fake);
    expect(outcome.notes).toContain("2 responses without the browser's own timing");
    expect(outcome.measurements.filter((m) => m.start === 'warm').map((m) => m.phase)).toEqual([
      'total',
      'total',
    ]);
  });
});

describe('drive, with coldFirst', () => {
  const HEALTH = `${TARGET}api/health`;
  const coldFirst = parseSettings({
    pages: [
      { path: '/', expect: ['games', 'session'] },
      { path: '/wishlist', expect: ['games', 'session'] },
    ],
    requests: [
      { name: 'games', path: '/api/graphql', operation: 'Games' },
      { name: 'session', path: '/api/graphql', method: 'POST', operation: 'Session' },
      { name: 'vote', path: '/api/graphql', method: 'POST', operation: 'Vote' },
    ],
    reads: [{ method: 'POST', path: '/api/graphql', operation: 'Session' }],
    repeats: 1,
    coldFirst: 'games',
  });
  const without = parseSettings({ ...coldFirst, coldFirst: undefined });

  /**
   * A deployment whose first API request is cold, and whose page sends the
   * session query, an unlisted API call and an image before the games query,
   * all at once; `answered` lists each API request as it reaches the app.
   */
  function sessionFirst({
    sent = [SESSION, { url: HEALTH }, { url: `${TARGET}logo.png`, type: 'image' }, { url: GAMES }],
    answer,
  }: {
    sent?: Sent[];
    answer?: (r: Sent & { method: string }, load: number) => Answer | undefined;
  } = {}) {
    const answered: string[] = [];
    let served = false;
    const fake = testBrowser({
      page: () => sent,
      answer: (request, load) => {
        if (request.url.startsWith(`${TARGET}api/`)) {
          answered.push(
            request.url === GAMES ? 'games' : request.url === HEALTH ? 'health' : 'session',
          );
        }
        const custom = answer?.(request, load);
        if (custom) return custom;
        if (!request.url.startsWith(`${TARGET}api/`)) return {};
        const cold = !served;
        served = true;
        return { headers: { 'server-timing': cold ? 'cold, total;dur=900' : WARM } };
      },
    });
    return { fake, answered };
  }

  it('sends the named request first on the first load, then the held ones, left out and counted', async () => {
    const { fake, answered } = sessionFirst();
    const outcome = await run(fake, { settings: coldFirst });
    expect(outcome.problems).toEqual([]);
    expect(answered.slice(0, 3)).toEqual(['games', 'session', 'health']);
    // The image went out without waiting.
    expect(fake.seen.map((s) => s.url).slice(0, 3)).toEqual([TARGET, `${TARGET}logo.png`, GAMES]);
    // Page 2's first load, with no instance starting, is left out as ever.
    expect(outcome.notes).toEqual([
      'cold carried by: games',
      "2 held until games's wait ended, left out",
      '2 responses on the first load left out: not cold, not a repeat',
    ]);
    const rows = outcome.measurements.map((m) => `${m.name} ${m.start} ${m.phase}`);
    expect(rows.filter((row) => row.includes('cold'))).toEqual([
      'games cold total',
      'games cold browser',
    ]);
    // The session query is timed on the warm loads.
    expect(rows.filter((row) => row.startsWith('session'))).toEqual(
      Array(2).fill(['session warm total', 'session warm browser']).flat(),
    );
  });

  it("holds nothing on the other pages' first loads, nor on warm loads", async () => {
    const { fake, answered } = sessionFirst();
    await run(fake, { settings: coldFirst });
    const inOrder = ['session', 'health', 'games'];
    expect(answered).toEqual(['games', 'session', 'health', ...inOrder, ...inOrder, ...inOrder]);
  });

  it('holds nothing without the setting, and probes as before', async () => {
    const { fake, answered } = sessionFirst();
    const outcome = await run(fake, { settings: without });
    expect(answered.slice(0, 3)).toEqual(['session', 'health', 'games']);
    expect(outcome.notes).toEqual([
      'cold carried by: session',
      '3 responses on the first load left out: not cold, not a repeat',
    ]);
    expect(outcome.problems).toEqual([]);
  });

  it('notes, naming it and guessing nothing, a named request that carried no cold flag', async () => {
    const { fake } = sessionFirst({ answer: () => ({ headers: { 'server-timing': WARM } }) });
    const outcome = await run(fake, { settings: coldFirst });
    expect(outcome.notes).toEqual([
      'cold not seen this run: no response carried the cold flag (cold)',
      'games carried no cold flag on the first load',
      "2 held until games's wait ended, left out",
      '3 responses on the first load left out: not cold, not a repeat',
    ]);
    expect(outcome.problems).toEqual([]);
  });

  it('a held request that comes back cold is still left out', async () => {
    const { fake } = sessionFirst({
      answer: (r, load) =>
        r.url === API && load === 0
          ? { headers: { 'server-timing': 'cold, total;dur=700' } }
          : undefined,
    });
    const outcome = await run(fake, { settings: coldFirst });
    expect(outcome.notes[0]).toBe('cold carried by: games, session');
    expect(outcome.measurements.filter((m) => m.start === 'cold').map((m) => m.name)).toEqual([
      'games',
      'games',
    ]);
  });

  it.each([
    [
      'answers 500',
      { sent: [SESSION, { url: HEALTH }, { url: GAMES }] },
      (r: Sent) => (r.url === GAMES ? { status: 500 } : undefined),
      ['games: answered 500'],
    ],
    [
      'is never made',
      { sent: [SESSION, { url: HEALTH }] },
      undefined,
      [
        'games: / never made this request within 90s',
        'games: /wishlist never made this request within 90s',
      ],
    ],
  ])(
    'releases the held requests, with one problem, when the named request %s',
    async (_, { sent }, answer, problems) => {
      const { fake, answered } = sessionFirst({ sent, answer });
      const outcome = await run(fake, { settings: coldFirst });
      expect(outcome.problems).toEqual(problems);
      expect(answered.filter((name) => name !== 'games').slice(0, 2)).toEqual([
        'session',
        'health',
      ]);
      expect(outcome.notes).toContain("2 held until games's wait ended, left out");
    },
  );

  it('releases the held requests at once, with one problem, when the named request fails in the network', async () => {
    const failing = { url: GAMES, fail: 'net::ERR_CONNECTION_RESET' };
    // How many waits had reached their hang limit as each API request was answered.
    const hungAt: string[] = [];
    const { fake, answered } = sessionFirst({
      sent: [SESSION, { url: HEALTH }, failing],
      answer: (r, load) => {
        if (load === 0 && r.url.startsWith(`${TARGET}api/`))
          hungAt.push(`${r.url}: ${fake.hung()}`);
        return undefined;
      },
    });
    const outcome = await run(fake, { settings: coldFirst });
    expect(hungAt).toEqual([`${API}: 0`, `${HEALTH}: 0`]);
    expect(answered.slice(0, 2)).toEqual(['session', 'health']);
    // The other loads, which hold nothing, end their waits as ever.
    expect(outcome.problems).toEqual([
      'games: failed: net::ERR_CONNECTION_RESET',
      'games: / never made this request within 90s',
      'games: /wishlist never made this request within 90s',
    ]);
    expect(outcome.notes).toContain("2 held until games's wait ended, left out");
  });

  it('holds nothing sent after the named request answered: it is measured or left out as usual, and not counted', async () => {
    const VOTES = { url: API, method: 'POST', body: JSON.stringify({ operationName: 'Votes' }) };
    const withVotes = parseSettings({
      pages: [{ path: '/', expect: ['games', 'session', 'votes'] }],
      requests: [
        ...coldFirst.requests,
        { name: 'votes', path: '/api/graphql', method: 'POST', operation: 'Votes' },
      ],
      reads: [...coldFirst.reads, { method: 'POST', path: '/api/graphql', operation: 'Votes' }],
      repeats: 1,
      coldFirst: 'games',
    });
    for (const votesCold of [true, false]) {
      const { fake } = sessionFirst({
        sent: [SESSION, { url: HEALTH }, { url: GAMES, next: [VOTES] }],
        answer: (r, load) =>
          r.body === VOTES.body && load === 0
            ? { headers: { 'server-timing': votesCold ? 'cold, total;dur=500' : WARM } }
            : undefined,
      });
      const outcome = await run(fake, { settings: withVotes });
      expect(outcome.problems).toEqual([]);
      expect(outcome.notes).toContain("2 held until games's wait ended, left out");
      const coldRows = outcome.measurements.filter((m) => m.start === 'cold').map((m) => m.name);
      if (votesCold) {
        expect(coldRows).toEqual(['games', 'games', 'votes', 'votes']);
      } else {
        expect(coldRows).toEqual(['games', 'games']);
        expect(outcome.notes).toContain(
          '1 response on the first load left out: not cold, not a repeat',
        );
      }
    }
  });

  it('leaves out a held request the deployment redirected', async () => {
    const withHealth = parseSettings({
      pages: [{ path: '/', expect: ['games', 'health'] }],
      requests: [...coldFirst.requests, { name: 'health', path: '/api/health' }],
      repeats: 1,
      coldFirst: 'games',
    });
    const { fake } = sessionFirst({
      sent: [{ url: `${TARGET}api/old-health`, redirectTo: HEALTH }, { url: GAMES }],
      // Every response cold, so a held one that were measured would show.
      answer: () => ({ headers: { 'server-timing': 'cold, total;dur=300' } }),
    });
    const outcome = await run(fake, { settings: withHealth });
    expect(outcome.problems).toEqual([]);
    expect(outcome.notes).toContain("1 held until games's wait ended, left out");
    expect(outcome.measurements.filter((m) => m.name === 'health').length).toBe(2);
    expect(outcome.measurements.slice(0, 2).map((m) => m.name)).toEqual(['games', 'games']);
  });

  it('goes on holding when one of two named requests fails, while the other is still pending', async () => {
    const { fake, answered } = sessionFirst({
      sent: [SESSION, { url: HEALTH }, { url: GAMES, fail: 'net::ERR_ABORTED' }, { url: GAMES }],
    });
    const outcome = await run(fake, { settings: coldFirst });
    expect(answered.slice(0, 3)).toEqual(['games', 'session', 'health']);
    expect(outcome.problems).toEqual([]);
    expect(outcome.measurements.filter((m) => m.start === 'cold').map((m) => m.name)).toEqual([
      'games',
      'games',
    ]);
  });

  it('releases the held requests, with one problem, when the named request is aborted as a write', async () => {
    const vote = { url: API, method: 'POST', body: JSON.stringify({ operationName: 'Vote' }) };
    const voteFirst = parseSettings({
      pages: [{ path: '/', expect: ['vote', 'games'] }],
      requests: coldFirst.requests,
      repeats: 1,
      coldFirst: 'vote',
    });
    const { fake, answered } = sessionFirst({ sent: [{ url: GAMES }, vote] });
    const outcome = await run(fake, { settings: voteFirst });
    expect(outcome.problems).toEqual([
      'vote: aborted, as POST /api/graphql (Vote) is not a read (probe.reads)',
    ]);
    expect(answered).toEqual(['games', 'games']);
    expect(outcome.notes).toContain("1 held until vote's wait ended, left out");
    expect(outcome.measurements.filter((m) => m.start === 'cold')).toEqual([]);
  });
});
