import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSettings, parseSettings } from './settings.ts';

// How BoardGames might set it (ci#151's plan).
const BOARDGAMES = {
  pages: [{ path: '/', expect: ['games', 'session'] }],
  requests: [
    { name: 'games', path: '/api/graphql', operation: 'Games' },
    { name: 'session', path: '/api/graphql', method: 'POST', operation: 'Session' },
    { name: 'votes', path: '/api/graphql', method: 'POST', operation: 'WishlistVotes' },
  ],
  reads: [
    { method: 'POST', path: '/api/graphql', operation: 'Session' },
    { method: 'POST', path: '/api/graphql', operation: 'WishlistVotes' },
  ],
  hosts: ['*.vercel.app'],
  headers: { 'x-synthetic': 'probe' },
};

const minimal = {
  pages: [{ path: '/', expect: ['games'] }],
  requests: [{ name: 'games', path: '/api/graphql' }],
};

describe('parseSettings', () => {
  it("reads BoardGames' settings, with the defaults for the rest", () => {
    expect(parseSettings(BOARDGAMES)).toEqual({
      ...BOARDGAMES,
      previewSafe: [],
      cold: 'cold',
      repeats: 5,
      timeout: 90,
    });
  });

  it('defaults everything but the pages and the requests', () => {
    expect(parseSettings(minimal)).toEqual({
      ...minimal,
      reads: [],
      previewSafe: [],
      cold: 'cold',
      repeats: 5,
      hosts: [],
      headers: {},
      timeout: 90,
    });
    expect(
      parseSettings({
        ...minimal,
        previewSafe: [{ method: 'POST', path: '/api/graphql', operation: 'Vote' }],
        cold: 'first-use',
        repeats: 20,
        timeout: 0.5,
      }),
    ).toMatchObject({
      previewSafe: [{ method: 'POST', path: '/api/graphql', operation: 'Vote' }],
      cold: 'first-use',
      repeats: 20,
      timeout: 0.5,
    });
  });

  it.each([
    [null, 'probe must be an object'],
    [{ ...minimal, retries: 2 }, 'probe has "retries", which isn\'t one of'],
    [{ ...minimal, pages: [] }, 'probe.pages must be a list of at least one'],
    [{ ...minimal, pages: ['/'] }, 'probe.pages[0] must be an object'],
    [{ ...minimal, pages: [{ path: 'home', expect: ['games'] }] }, 'probe.pages[0].path must be'],
    [
      { ...minimal, pages: [{ path: '//evil.example/', expect: ['games'] }] },
      'probe.pages[0].path',
    ],
    [
      { ...minimal, pages: [{ path: '/\\evil.example', expect: ['games'] }] },
      'probe.pages[0].path',
    ],
    [{ ...minimal, pages: [{ path: '/?x=1', expect: ['games'] }] }, 'probe.pages[0].path'],
    [
      { ...minimal, pages: [{ path: '/', expect: ['games', 'games'] }] },
      'probe.pages[0].expect names "games" twice',
    ],
    [{ ...minimal, requests: [{ name: 'g', path: '//evil.example/' }] }, 'probe.requests[0].path'],
    [{ ...minimal, pages: [{ path: '/', expect: ['nope'] }] }, 'probe.pages[0].expect must list'],
    [{ ...minimal, pages: [{ path: '/', expect: [] }] }, 'probe.pages[0].expect must list'],
    [{ ...minimal, pages: [{ path: '/', expect: ['games'], x: 1 }] }, 'probe.pages[0] has "x"'],
    [{ ...minimal, requests: undefined }, 'probe.requests must be a list'],
    [{ ...minimal, requests: [{ name: 'a b', path: '/' }] }, 'probe.requests[0].name must be'],
    [{ ...minimal, requests: [{ name: 'g', path: '/x?y' }] }, 'probe.requests[0].path must be'],
    [
      { ...minimal, requests: [{ name: 'g', path: '/', method: 'get' }] },
      'probe.requests[0].method',
    ],
    [
      { ...minimal, requests: [{ name: 'g', path: '/', operation: '1x' }] },
      'probe.requests[0].operation',
    ],
    [
      { ...minimal, requests: [minimal.requests[0], minimal.requests[0]] },
      'probe.requests names "games" twice',
    ],
    [{ ...minimal, reads: {} }, 'probe.reads must be a list'],
    [
      { ...minimal, reads: [{ method: 'GET', path: '/' }] },
      'probe.reads[0].method must not be GET',
    ],
    [{ ...minimal, reads: [{ path: '/' }] }, 'probe.reads[0].method must be'],
    [
      { ...minimal, previewSafe: [{ method: 'POST', path: '/', operation: '' }] },
      'probe.previewSafe[0].operation',
    ],
    [{ ...minimal, cold: 'a b' }, 'probe.cold must be'],
    [{ ...minimal, repeats: 0 }, 'probe.repeats must be a whole number from 1 to 20'],
    [{ ...minimal, repeats: 2.5 }, 'probe.repeats'],
    [{ ...minimal, repeats: 21 }, 'probe.repeats'],
    [{ ...minimal, hosts: '*.vercel.app' }, 'probe.hosts must be a list of host globs'],
    [{ ...minimal, hosts: ['https://x.app'] }, 'probe.hosts'],
    [{ ...minimal, headers: { 'x-a': 'one\ntwo' } }, 'probe.headers must map'],
    [{ ...minimal, headers: { 'x a': 'v' } }, 'probe.headers'],
    [{ ...minimal, timeout: 0 }, 'probe.timeout must be a number of seconds'],
    [{ ...minimal, timeout: 601 }, 'probe.timeout'],
  ])('refuses %j, naming the setting', (raw, message) => {
    expect(() => parseSettings(raw)).toThrow(`.github/ci.json: ${message}`);
  });
});

describe('loadSettings', () => {
  function app(ciJson: string | undefined) {
    const root = mkdtempSync(path.join(tmpdir(), 'probe-settings-'));
    if (ciJson !== undefined) {
      mkdirSync(path.join(root, '.github'));
      writeFileSync(path.join(root, '.github', 'ci.json'), ciJson);
    }
    return root;
  }
  it('is null with no probe key, or no file', () => {
    expect(loadSettings(app('{"gif": {}}'))).toBe(null);
    expect(loadSettings(app(undefined))).toBe(null);
  });
  it("reads the app's probe key", () => {
    expect(loadSettings(app(JSON.stringify({ probe: minimal })))?.requests).toEqual(
      minimal.requests,
    );
    expect(() => loadSettings(app('{"probe": {}}'))).toThrow('probe.requests');
  });
});
