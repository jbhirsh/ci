import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cli, selftest } from './selftest.mjs';
import { testPng } from '../lib/test-pixels.mjs';
import { repo } from './test-repo.mjs';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * An app with these settings and files.
 *
 * @param {Record<string, unknown> | undefined} config
 * @param {Record<string, string | Buffer>} files
 */
function app(config, files) {
  /** @type {Record<string, string>} */
  const ci = config ? { '.github/ci.json': JSON.stringify({ 'visual-baselines': config }) } : {};
  return repo({ ...ci, ...files }).root;
}

describe('selftest', () => {
  it("checks verify against the app's job, and the app's Vercel ignore script", async () => {
    const root = app(
      {
        folders: ['shots'],
        command: 'make shots',
        verify: { check: 'E2E', command: 'npm run test:e2e' },
      },
      {
        'shots/a.png': testPng(),
        '.github/workflows/e2e.yml':
          'jobs:\n  e2e:\n    name: E2E\n    steps:\n      - run: npm run test:e2e\n',
        'scripts/vercel-ignore.mjs': 'process.exit(1);\n',
      },
    );
    await expect(selftest(root)).rejects.toThrow(/vercel-ignore\.mjs answers wrongly/);
    writeFileSync(
      path.join(root, 'scripts/vercel-ignore.mjs'),
      "import { execFileSync } from 'node:child_process';\n" +
        "const [a, c] = execFileSync('git', ['log', '-1', '--format=%an|%cn'], { encoding: 'utf8' }).trim().split('|');\n" +
        "process.exit(process.env.VERCEL_ENV === 'preview' && c === 'github-actions[bot]' && a !== c ? 0 : 1);\n",
    );
    expect(await selftest(root)).toEqual([
      'visual-baselines: 1 baselines in shots.',
      'visual-baselines: rewritten by `make shots`.',
      "visual-baselines: verify runs E2E's `npm run test:e2e` (e2e.yml).",
      'visual-baselines: scripts/vercel-ignore.mjs answers all 5 cases.',
    ]);
  });

  it('passes an app without settings, saying so', async () => {
    expect(await selftest(app(undefined, { 'a.txt': '' }))).toEqual([
      'visual-baselines: no settings; the app uses no shared visual regression yet.',
    ]);
  });

  it('counts the baselines and names the command', async () => {
    const root = app(
      { folders: ['e2e/*-snapshots'], command: 'npx playwright test --update-snapshots' },
      { 'e2e/a-snapshots/x.png': testPng(), 'e2e/b-snapshots/y.png': testPng(), 'e2e/a.ts': '' },
    );
    expect(await selftest(root)).toEqual([
      'visual-baselines: 2 baselines in e2e/a-snapshots, e2e/b-snapshots.',
      'visual-baselines: rewritten by `npx playwright test --update-snapshots`.',
    ]);
  });

  it('compares each baseline with itself for an app rewritten from a run', async () => {
    const root = app(
      { folders: ['shots'], artifact: { workflow: 'ci.yml', name: 'ios' }, ratio: 0.001 },
      { 'shots/a.png': testPng(), '.github/workflows/ci.yml': '' },
    );
    expect((await selftest(root))[1]).toBe(
      "visual-baselines: rewritten from ci.yml's ios; compared with up to 0.1% of pixels differing.",
    );
  });

  it('refuses folders with no baselines, no way to rewrite them, or a missing workflow', async () => {
    await expect(
      selftest(app({ folders: ['none'], command: 'x' }, { 'shots/a.png': testPng() })),
    ).rejects.toThrow(/holds no PNGs/);
    await expect(
      selftest(app({ folders: ['shots'] }, { 'shots/a.png': testPng() })),
    ).rejects.toThrow(/needs a command or an artifact/);
    await expect(
      selftest(
        app(
          { folders: ['shots'], artifact: { workflow: 'ci.yml', name: 'x' } },
          { 'shots/a.png': testPng() },
        ),
      ),
    ).rejects.toThrow(/no .github\/workflows\/ci.yml/);
  });

  it('logs how the baselines pair under columns', async () => {
    const root = app(
      {
        folders: ['e2e/*-snapshots'],
        command: 'x',
        columns: [
          { label: 'Phone', file: '{state}-phone.png' },
          { label: 'Desktop', file: '{state}-desktop.png' },
        ],
      },
      {
        'e2e/p-snapshots/home-phone.png': testPng(),
        'e2e/p-snapshots/menu-phone.png': testPng(),
        'e2e/d-snapshots/home-desktop.png': testPng(),
        'e2e/d-snapshots/home-firefox.png': testPng(),
      },
    );
    expect((await selftest(root))[1]).toBe(
      'visual-baselines: 2 states in Phone / Desktop, 1 with every column.',
    );
  });

  it('refuses a column that picks no tracked baseline', async () => {
    const root = app(
      {
        folders: ['shots'],
        command: 'x',
        columns: [
          { label: 'Light', file: 'light-{state}.png' },
          { label: 'Dark', file: ['dark-{state}.png', 'night-{state}.png'] },
        ],
      },
      { 'shots/light-a.png': testPng() },
    );
    await expect(selftest(root)).rejects.toThrow(
      /columns: Dark picks no tracked baseline \(dark-\{state\}.png or night-\{state\}.png\)/,
    );
  });

  it("refuses a baseline pngjs can't read", async () => {
    const root = app(
      { folders: ['shots'], artifact: { workflow: 'ci.yml', name: 'x' } },
      { 'shots/a.png': 'not a png', '.github/workflows/ci.yml': '' },
    );
    await expect(selftest(root)).rejects.toThrow(/shots\/a.png is not a PNG pngjs reads/);
  });
});

describe('cli', () => {
  it('prints the lines', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cli([app(undefined, { 'a.txt': '' })]);
    expect(log).toHaveBeenCalledWith(
      'visual-baselines: no settings; the app uses no shared visual regression yet.',
    );
  });

  it('needs the app', async () => {
    await expect(cli([])).rejects.toThrow(/usage/);
  });
});
