import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runIn } from './baselines.mjs';
import { fromRun, main, shots } from './from-run.mjs';
import { settings } from './settings.mjs';
import { repo } from './test-repo.mjs';

afterEach(() => {
  vi.unstubAllEnvs();
});

const S = settings({
  folders: ['e2e/baselines'],
  artifact: { workflow: 'ci.yml', name: 'ios-screenshots' },
});

/**
 * A runner whose `gh` lists the runs `ids` (newest first) and downloads
 * `files` from any of them but those in `without`, and whose git is real.
 *
 * @param {string} root
 * @param {string | string[]} ids
 * @param {Record<string, string>} files
 * @param {string[][]} [calls]
 * @param {string[]} [without]
 * @returns {import('./baselines.mjs').Run}
 */
function runner(root, ids, files, calls = [], without = []) {
  const git = runIn(root);
  return (command, args) => {
    if (command !== 'gh') return git(command, args);
    calls.push(args);
    if (args[1] === 'list') return [ids].flat().filter(Boolean).join('\n') + '\n';
    if (without.includes(args[2])) throw new Error('no artifact matches');
    const dir = args[args.indexOf('--dir') + 1];
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), text);
    }
    return '';
  };
}

const temp = () => mkdtempSync(path.join(tmpdir(), 'from-run-'));

describe('fromRun', () => {
  it("puts the run's screenshots in the folder and commits them", () => {
    const { root, git } = repo({ 'e2e/baselines/a.png': 'old', 'src/x.ts': '' });
    /** @type {string[][]} */
    const calls = [];
    const committed = fromRun({
      root,
      s: S,
      run: runner(
        root,
        '42',
        { 'a.png': 'new', 'b.png': 'b', 'debug/c.png': 'c', 'x.log': '' },
        calls,
      ),
      sha: 'abcdef0123',
      branch: 'topic',
      by: 'a test',
      temp: temp(),
    });
    expect(committed).toBe(true);
    expect(calls[0]).toContain('abcdef0123');
    expect(calls[1]).toEqual([
      'run',
      'download',
      '42',
      '--name',
      'ios-screenshots',
      '--dir',
      calls[1][6],
    ]);
    expect(git('show', '--name-status', '--format=', 'HEAD').trim().split('\n')).toEqual([
      'M\te2e/baselines/a.png',
      'A\te2e/baselines/b.png',
    ]);
  });

  it('starts the folder when there are no baselines yet', () => {
    const { root, git } = repo({ 'src/x.ts': '' });
    const run = runner(root, '7', { 'a.png': 'a' });
    expect(fromRun({ root, s: S, run, sha: 'abc', branch: 'topic', by: 'x', temp: temp() })).toBe(
      true,
    );
    expect(git('ls-files', 'e2e').trim()).toBe('e2e/baselines/a.png');
  });

  it('refuses a run that missed a baseline, or took nothing', () => {
    const { root } = repo({ 'e2e/baselines/a.png': 'a', 'e2e/baselines/b.png': 'b' });
    const base = { root, s: S, sha: 'abc', branch: 'topic', by: 'x' };
    expect(() =>
      fromRun({ ...base, run: runner(root, '1', { 'a.png': 'a' }), temp: temp() }),
    ).toThrow(/run 1 took no b.png/);
    expect(() => fromRun({ ...base, run: runner(root, '1', {}), temp: temp() })).toThrow(
      /holds no screenshots/,
    );
    expect(() =>
      fromRun({ ...base, run: runner(root, '1', { 'a b.png': '' }), temp: temp() }),
    ).toThrow(/not a screenshot name: a b.png/);
  });

  it('says when the commit has no run yet', () => {
    const { root } = repo({ 'e2e/baselines/a.png': 'a' });
    expect(() =>
      fromRun({
        root,
        s: S,
        run: runner(root, '', {}),
        sha: 'abcdef0123',
        branch: 'topic',
        by: 'x',
        temp: temp(),
      }),
    ).toThrow(/no finished ci.yml run on abcdef0 has ios-screenshots/);
  });

  it('skips a newer run without the screenshots for one with them', () => {
    const { root, git } = repo({ 'e2e/baselines/a.png': 'old' });
    /** @type {string[][]} */
    const calls = [];
    const run = runner(root, ['9', '8'], { 'a.png': 'new' }, calls, ['9']);
    expect(fromRun({ root, s: S, run, sha: 'abc', branch: 'topic', by: 'x', temp: temp() })).toBe(
      true,
    );
    expect(calls.map((args) => args[2])).toEqual(['--workflow', '9', '8']);
    expect(calls[0]).toEqual(expect.arrayContaining(['--status', 'completed']));
    expect(git('show', 'HEAD:e2e/baselines/a.png')).toBe('new');
  });

  it('needs an artifact and one literal folder', () => {
    const base = { root: '/x', run: () => '', sha: 'a', branch: 'topic', by: 'x', temp: '/t' };
    expect(() => fromRun({ ...base, s: settings({ folders: ['a'] }) })).toThrow(
      /artifact is needed/,
    );
    expect(() =>
      fromRun({ ...base, s: settings({ ...S, folders: ['a/*'], artifact: S.artifact }) }),
    ).toThrow(/exactly one folder/);
  });

  it('lists only the PNGs directly in a folder', () => {
    const dir = temp();
    for (const name of ['b.png', 'a.png', 'c.txt']) writeFileSync(path.join(dir, name), '');
    expect(shots(dir)).toEqual(['a.png', 'b.png']);
    expect(shots(path.join(dir, 'none'))).toEqual([]);
  });
});

describe('main', () => {
  it('finds the run for HEAD with gh', () => {
    const { root, git } = repo({
      '.github/ci.json': JSON.stringify({ 'visual-baselines': S }),
      'e2e/baselines/a.png': 'a',
    });
    const bin = temp();
    const shot = path.join(bin, 'a.png');
    writeFileSync(shot, 'fresh');
    // A stand-in gh on the PATH: one run, whose artifact is a.png.
    writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh\nif [ "$2" = list ]; then echo 9; else cp ${shot} "$7/"; fi\n`,
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('GITHUB_REF_NAME', 'topic');
    vi.stubEnv('GITHUB_REF_TYPE', 'branch');
    expect(main(root)).toBe(true);
    expect(git('show', 'HEAD:e2e/baselines/a.png')).toBe('fresh');
  });
});
