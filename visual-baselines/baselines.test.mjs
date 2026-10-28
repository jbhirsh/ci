import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { branchOf, commit, knownFiles, matchingFolders, runIn, wipe } from './baselines.mjs';
import { repo } from './test-repo.mjs';

describe('matchingFolders', () => {
  it('finds the folders a glob names among the files’ ancestors', () => {
    const files = [
      'e2e/home.spec.ts-snapshots/a.png',
      'e2e/home.spec.ts-snapshots/b.png',
      'e2e/phone.spec.ts-snapshots/c.png',
      'e2e/home.spec.ts',
      'src/a.ts',
    ];
    expect(matchingFolders(files, ['e2e/*-snapshots'])).toEqual([
      'e2e/home.spec.ts-snapshots',
      'e2e/phone.spec.ts-snapshots',
    ]);
    expect(matchingFolders(files, ['nothing'])).toEqual([]);
  });
});

describe('knownFiles, wipe and commit', () => {
  it('lists names git would quote as they are', () => {
    const { root } = repo({ 'shots/café.png': '1' });
    expect(knownFiles(runIn(root))).toEqual(['shots/café.png']);
  });

  it('lists tracked and new files, not ignored ones', () => {
    const { root } = repo({ 'a/x.png': '1', '.gitignore': 'tmp\n' });
    writeFileSync(path.join(root, 'new.txt'), '');
    mkdirSync(path.join(root, 'tmp'));
    writeFileSync(path.join(root, 'tmp/y'), '');
    expect(knownFiles(runIn(root)).sort()).toEqual(['.gitignore', 'a/x.png', 'new.txt']);
  });

  it('wipes the baselines folders and commits the rewrite with a body', () => {
    const { root, remote, git } = repo({
      'e2e/a-snapshots/old.png': 'old',
      'e2e/gone-snapshots/x.png': 'x',
      'e2e/a.spec.ts': '',
    });
    const run = runIn(root);
    expect(wipe(root, ['e2e/*-snapshots'], run)).toEqual(['e2e/a-snapshots', 'e2e/gone-snapshots']);
    expect(existsSync(path.join(root, 'e2e/a-snapshots'))).toBe(false);
    expect(existsSync(path.join(root, 'e2e/a.spec.ts'))).toBe(true);
    mkdirSync(path.join(root, 'e2e/a-snapshots'));
    writeFileSync(path.join(root, 'e2e/a-snapshots/new.png'), 'new');
    writeFileSync(path.join(root, 'e2e/a.spec.ts'), 'changed');

    expect(commit({ globs: ['e2e/*-snapshots'], branch: 'topic', by: 'a run', run })).toBe(true);
    expect(git('log', '-1', '--format=%s%n%n%b').trim()).toBe(
      'Update the visual baselines\n\nRewritten on CI by a run.',
    );
    expect(git('show', '--name-status', '--format=', 'HEAD').trim().split('\n').sort()).toEqual([
      'A\te2e/a-snapshots/new.png',
      'D\te2e/a-snapshots/old.png',
      'D\te2e/gone-snapshots/x.png',
    ]);
    // Only the baselines: the spec's change stays unstaged.
    expect(git('status', '--porcelain').trim()).toBe('M e2e/a.spec.ts');
    expect(
      execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'topic'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('Update the visual baselines');
  });

  it('commits nothing when the baselines are unchanged or there are none', () => {
    const { root, git } = repo({ 'shots/a.png': 'a' });
    const run = runIn(root);
    expect(commit({ globs: ['shots'], branch: 'topic', by: 'x', run })).toBe(false);
    expect(commit({ globs: ['none'], branch: 'topic', by: 'x', run })).toBe(false);
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe('1');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('branchOf', () => {
  it('is the branch a workflow ran on', () => {
    expect(branchOf({ GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'topic' })).toBe('topic');
  });

  it.each([{}, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1' }, { GITHUB_REF_TYPE: 'branch' }])(
    'refuses %j',
    (env) => {
      expect(() => branchOf(env)).toThrow(/runs on a branch/);
    },
  );
});
