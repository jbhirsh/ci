import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cli, selftest } from './selftest.mjs';
import { fakePng, repo, withPixels } from './test-repo.mjs';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * An app with these settings and files, its pixels stubbed.
 *
 * @param {Record<string, unknown> | undefined} config
 * @param {Record<string, string>} files
 */
function app(config, files) {
  /** @type {Record<string, string>} */
  const ci = config ? { '.github/ci.json': JSON.stringify({ 'visual-baselines': config }) } : {};
  const { root } = repo({ ...ci, ...files });
  return withPixels(root);
}

describe('selftest', () => {
  it('passes an app without settings, saying so', async () => {
    expect(await selftest(app(undefined, { 'a.txt': '' }))).toEqual([
      'visual-baselines: no settings; the app uses no shared visual regression yet.',
    ]);
  });

  it('counts the baselines and names the command', async () => {
    const root = app(
      { folders: ['e2e/*-snapshots'], command: 'npx playwright test --update-snapshots' },
      { 'e2e/a-snapshots/x.png': fakePng(), 'e2e/b-snapshots/y.png': fakePng(), 'e2e/a.ts': '' },
    );
    expect(await selftest(root)).toEqual([
      'visual-baselines: 2 baselines in e2e/a-snapshots, e2e/b-snapshots.',
      'visual-baselines: rewritten by `npx playwright test --update-snapshots`.',
    ]);
  });

  it('compares each baseline with itself for an app rewritten from a run', async () => {
    const root = app(
      { folders: ['shots'], artifact: { workflow: 'ci.yml', name: 'ios' }, ratio: 0.001 },
      { 'shots/a.png': fakePng(), '.github/workflows/ci.yml': '' },
    );
    expect((await selftest(root))[1]).toBe(
      "visual-baselines: rewritten from ci.yml's ios; compared with up to 0.1% of pixels differing.",
    );
  });

  it('refuses folders with no baselines, no way to rewrite them, or a missing workflow', async () => {
    await expect(
      selftest(app({ folders: ['none'], command: 'x' }, { 'shots/a.png': fakePng() })),
    ).rejects.toThrow(/holds no PNGs/);
    await expect(
      selftest(app({ folders: ['shots'] }, { 'shots/a.png': fakePng() })),
    ).rejects.toThrow(/needs a command or an artifact/);
    await expect(
      selftest(
        app(
          { folders: ['shots'], artifact: { workflow: 'ci.yml', name: 'x' } },
          { 'shots/a.png': fakePng() },
        ),
      ),
    ).rejects.toThrow(/no .github\/workflows\/ci.yml/);
  });

  it('refuses a baseline that does not compare equal to itself', async () => {
    const root = app(
      { folders: ['shots'], artifact: { workflow: 'ci.yml', name: 'x' } },
      { 'shots/a.png': fakePng(0, 0), '.github/workflows/ci.yml': '' },
    );
    await expect(selftest(root)).rejects.toThrow(/a.png doesn't compare equal to itself/);
  });
});

describe('cli', () => {
  it('prints the lines', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = app(undefined, { 'a.txt': '' });
    mkdirSync(path.join(root, 'x'));
    writeFileSync(path.join(root, 'x/y'), '');
    await cli([root]);
    expect(log).toHaveBeenCalledWith(
      'visual-baselines: no settings; the app uses no shared visual regression yet.',
    );
  });

  it('needs the app', async () => {
    await expect(cli([])).rejects.toThrow(/usage/);
  });
});
