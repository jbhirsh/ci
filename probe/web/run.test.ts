import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandData, readInputs, run, version } from './run.ts';
import { testBrowser } from './test-browser.ts';

const TARGET = 'https://board-games-abc.vercel.app/';
const PROBE = {
  pages: [{ path: '/', expect: ['games'] }],
  requests: [{ name: 'games', path: '/api/graphql' }],
  repeats: 1,
  hosts: ['*.vercel.app'],
};

/**
 * An app checkout with this `probe` key (none when undefined) and a lockfile.
 */
function app(probe: unknown) {
  const root = mkdtempSync(path.join(tmpdir(), 'probe-run-'));
  mkdirSync(path.join(root, '.github'));
  writeFileSync(path.join(root, '.github', 'ci.json'), JSON.stringify(probe ? { probe } : {}));
  writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({ packages: { 'node_modules/playwright': { version: '1.65.0' } } }),
  );
  return root;
}

/** A deployment whose first answer is cold. */
function deployment() {
  let served = false;
  return testBrowser({
    page: () => [{ url: `${TARGET}api/graphql` }],
    answer: (request) => {
      if (!request.url.endsWith('/api/graphql')) return {};
      const timing = served ? 'total;dur=30' : 'cold, total;dur=3400';
      served = true;
      return { headers: { 'server-timing': timing } };
    },
  });
}

let dir: string;
let out: string[];
let errors: string[];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'probe-out-'));
  out = [];
  errors = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((line) => out.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line) => errors.push(String(line)));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const withResults = (env: Record<string, string>) => ({
  PROBE_RESULTS: path.join(dir, 'probe', 'results.json'),
  ...env,
});
const results = () => JSON.parse(readFileSync(path.join(dir, 'probe', 'results.json'), 'utf8'));

describe('readInputs', () => {
  it('reads the URL, the environment (production by default) and the secret', () => {
    expect(readInputs({ PROBE_URL: TARGET })).toEqual({
      url: TARGET,
      environment: 'production',
      secret: '',
    });
    expect(
      readInputs({ PROBE_URL: TARGET, PROBE_ENVIRONMENT: 'preview', PROBE_SECRET: 's' }),
    ).toEqual({ url: TARGET, environment: 'preview', secret: 's' });
  });
  it('refuses what it cannot probe', () => {
    expect(() => readInputs({})).toThrow(`url: "" isn't a URL`);
    expect(() => readInputs({ PROBE_URL: 'ftp://x/' })).toThrow('url: must be an http(s) URL');
    expect(() => readInputs({ PROBE_URL: 'https://u:p@x/' })).toThrow('no user or password');
    expect(() => readInputs({ PROBE_URL: TARGET, PROBE_ENVIRONMENT: 'staging' })).toThrow(
      'environment: "staging" must be production or preview',
    );
  });
});

describe('run', () => {
  it('writes the results file and the table, and passes', async () => {
    const fake = deployment();
    const root = app(PROBE);
    const launch = vi.fn(async () => fake.browser);
    const code = await run({
      env: withResults({ PROBE_URL: TARGET, PROBE_SECRET: 's3cret', PROBE_PLAYWRIGHT: '/pw' }),
      root,
      launch,
    });
    expect(code).toBe(0);
    expect(launch).toHaveBeenCalledWith('/pw');
    expect(fake.isClosed()).toBe(true);
    expect(results()).toEqual({
      version: 1,
      driver: 'web',
      target: TARGET,
      environment: 'production',
      measurements: [
        { name: 'games', phase: 'total', start: 'cold', ms: 3400 },
        {
          name: 'games',
          phase: 'browser',
          start: 'cold',
          ms: 8,
          requestStartMs: 1,
          responseStartMs: 5,
        },
        { name: 'games', phase: 'total', start: 'warm', ms: 30 },
        {
          name: 'games',
          phase: 'browser',
          start: 'warm',
          ms: 8,
          requestStartMs: 1,
          responseStartMs: 5,
        },
      ],
      notes: ['cold carried by: games'],
    });
    expect(out.join('')).toContain('| Request | Phase | Cold | Warm (median of 1) |');
    expect(out.join('')).toContain('| games | total | 3.4s | 30ms |');
    expect(errors).toEqual([]);
  });

  it('never prints the secret, and launches from the checkout when no folder is named', async () => {
    const root = app(PROBE);
    const launch = vi.fn(async () => deployment().browser);
    await run({
      env: withResults({ PROBE_URL: TARGET, PROBE_SECRET: 's3cret', GITHUB_ACTIONS: 'true' }),
      root,
      launch,
    });
    expect([...out, ...errors].join('')).not.toContain('s3cret');
    expect(launch).toHaveBeenCalledWith(root);
  });

  it('fails at once, writing what it has, when the secret would go to a host outside probe.hosts', async () => {
    const launch = vi.fn();
    const code = await run({
      env: withResults({ PROBE_URL: 'https://example.com/', PROBE_SECRET: 's3cret' }),
      root: app(PROBE),
      launch,
    });
    expect(code).toBe(1);
    expect(launch).not.toHaveBeenCalled();
    const problem =
      "bypass-secret: example.com matches none of probe.hosts (*.vercel.app), so the secret isn't sent";
    expect(errors).toEqual([`::error title=Performance probe::${problem}`]);
    expect(results()).toMatchObject({
      target: 'https://example.com/',
      measurements: [],
      notes: [`measuring broke: ${problem}`],
    });
    expect(JSON.stringify(results())).not.toContain('s3cret');
  });

  it('fails at once when a secret would go over plain http', async () => {
    const launch = vi.fn();
    const code = await run({
      env: withResults({ PROBE_URL: 'http://board-games-abc.vercel.app/', PROBE_SECRET: 's3cret' }),
      root: app(PROBE),
      launch,
    });
    expect(code).toBe(1);
    expect(launch).not.toHaveBeenCalled();
    expect(errors).toEqual([
      "::error title=Performance probe::bypass-secret: the url must be https, or the secret would cross the network in the clear, so it isn't sent",
    ]);
  });

  it('escapes what it writes into a workflow command', () => {
    expect(commandData('50%\r\n::error::x')).toBe('50%25%0D%0A::error::x');
  });

  it('fails when the app has no probe key, or its settings are wrong', async () => {
    expect(await run({ env: withResults({ PROBE_URL: TARGET }), root: app(undefined) })).toBe(1);
    expect(errors.at(-1)).toContain('.github/ci.json has no probe key');
    expect(await run({ env: withResults({ PROBE_URL: TARGET }), root: app({ pages: [] }) })).toBe(
      1,
    );
    expect(errors.at(-1)).toContain('.github/ci.json: probe.requests');
  });

  it('fails when measuring breaks, after writing what it has, and closes the browser', async () => {
    const fake = testBrowser({ page: () => [], answer: () => ({}) });
    const code = await run({
      env: withResults({ PROBE_URL: TARGET }),
      root: app(PROBE),
      launch: async () => fake.browser,
    });
    expect(code).toBe(1);
    expect(fake.isClosed()).toBe(true);
    expect(results().notes).toContain(
      'measuring broke: games: / never made this request within 90s',
    );
  });

  it('writes to the temp folder when no results path is given', async () => {
    const code = await run({ env: { PROBE_URL: 'nope' }, root: app(PROBE) });
    expect(code).toBe(1);
    expect(
      JSON.parse(readFileSync(path.join(tmpdir(), 'probe', 'results.json'), 'utf8')).notes,
    ).toEqual(['measuring broke: url: "nope" isn\'t a URL']);
  });
});

describe('version', () => {
  it('sets the Playwright release the app pins as the version output', () => {
    const file = path.join(dir, 'output');
    writeFileSync(file, '');
    vi.stubEnv('GITHUB_OUTPUT', file);
    try {
      version(app(PROBE));
    } finally {
      vi.unstubAllEnvs();
    }
    expect(readFileSync(file, 'utf8')).toMatch(/^version<<(\w+)\n1\.65\.0\n\1\n$/);
  });
});
