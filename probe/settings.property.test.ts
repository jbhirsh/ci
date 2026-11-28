import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseSettings } from './settings.ts';
import type { ProbeSettings } from './settings.ts';

const KEYS = [
  'pages',
  'requests',
  'reads',
  'previewSafe',
  'cold',
  'repeats',
  'hosts',
  'headers',
  'timeout',
  'coldFirst',
];

// Any JSON, and JSON shaped like the settings with any values in each key.
const settingsish = fc.oneof(
  fc.jsonValue(),
  fc.dictionary(fc.constantFrom(...KEYS, 'other'), fc.jsonValue()),
  fc.record(
    {
      pages: fc.array(
        fc.record({
          path: fc.oneof(
            fc.constantFrom('/', '//evil.example/', '/\\evil.example', '/a?b'),
            fc.string(),
            fc.string().map((rest) => `/${rest}`),
          ),
          expect: fc.array(fc.constantFrom('a', 'b')),
        }),
      ),
      requests: fc.array(
        fc.record(
          {
            name: fc.constantFrom('a', 'b', 'a b'),
            path: fc.constantFrom('/x', 'x', '/x?y'),
            method: fc.constantFrom('GET', 'post', 'POST'),
            operation: fc.constantFrom('Games', '1', ''),
          },
          { requiredKeys: ['name', 'path'] },
        ),
      ),
      repeats: fc.oneof(fc.integer({ min: -2, max: 25 }), fc.double()),
      timeout: fc.double(),
      hosts: fc.array(fc.oneof(fc.domain(), fc.string())),
      headers: fc.dictionary(fc.string(), fc.string()),
      coldFirst: fc.oneof(fc.constantFrom('a', 'b', 'c'), fc.jsonValue()),
    },
    { requiredKeys: [] },
  ),
);

describe('parseSettings, for any JSON value', () => {
  it('returns valid settings or throws an Error naming .github/ci.json: probe', () => {
    fc.assert(
      fc.property(settingsish, (raw) => {
        let settings: ProbeSettings;
        try {
          settings = parseSettings(raw);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(/^\.github\/ci\.json: probe[ .]/);
          return;
        }
        expect(settings.pages.length).toBeGreaterThan(0);
        expect(settings.requests.length).toBeGreaterThan(0);
        const names = settings.requests.map((r) => r.name);
        for (const page of settings.pages) {
          for (const n of page.expect) expect(names).toContain(n);
          expect(new Set(page.expect).size).toBe(page.expect.length);
          // Every page and request path stays on the deployment's origin.
          for (const p of [page.path, ...settings.requests.map((r) => r.path)]) {
            expect(new URL(p, 'https://app.example').origin).toBe('https://app.example');
          }
        }
        expect(Number.isInteger(settings.repeats)).toBe(true);
        expect(settings.repeats).toBeGreaterThanOrEqual(1);
        expect(settings.repeats).toBeLessThanOrEqual(20);
        expect(settings.timeout).toBeGreaterThan(0);
        // The request to catch cold, if any, is one the first page waits for.
        if (settings.coldFirst !== undefined) {
          expect(settings.pages[0].expect).toContain(settings.coldFirst);
        }
      }),
    );
  });
});

// BoardGames' settings, which parse, with coldFirst anything: absent, any
// JSON, a request name the first page expects, or one it doesn't.
const BOARDGAMES = {
  pages: [
    { path: '/', expect: ['Games', 'Session'] },
    { path: '/wishlist', expect: ['WishlistVotes'] },
  ],
  requests: [
    { name: 'Games', path: '/api/graphql', method: 'GET', operation: 'Games' },
    { name: 'Session', path: '/api/graphql', method: 'POST', operation: 'Session' },
    { name: 'WishlistVotes', path: '/api/graphql', method: 'POST', operation: 'WishlistVotes' },
  ],
  reads: [
    { method: 'POST', path: '/api/graphql', operation: 'Session' },
    { method: 'POST', path: '/api/graphql', operation: 'WishlistVotes' },
  ],
  hosts: ['*.vercel.app'],
  headers: { 'x-synthetic': 'probe' },
  timeout: 60,
};
const coldFirst = fc.option(
  fc.oneof(
    fc.jsonValue(),
    fc.constantFrom('Games', 'Session'),
    fc.constantFrom('WishlistVotes', 'Nope', 'games'),
  ),
  { nil: undefined },
);

describe('parseSettings, for any coldFirst on settings that parse', () => {
  it('takes it exactly when it names a request the first page expects, and reads it back', () => {
    let taken = 0;
    fc.assert(
      fc.property(coldFirst, (value) => {
        const raw = value === undefined ? BOARDGAMES : { ...BOARDGAMES, coldFirst: value };
        const valid =
          value === undefined ||
          (typeof value === 'string' &&
            BOARDGAMES.requests.some((r) => r.name === value) &&
            BOARDGAMES.pages[0].expect.includes(value));
        if (!valid) {
          expect(() => parseSettings(raw)).toThrow(/^\.github\/ci\.json: probe\.coldFirst /);
          return;
        }
        const settings = parseSettings(raw);
        expect(settings.coldFirst).toBe(value);
        if (value !== undefined) taken += 1;
      }),
      { numRuns: 300 },
    );
    // The valid branch, with a request named, is reached.
    expect(taken).toBeGreaterThan(0);
  });
});
