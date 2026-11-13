import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  branchOf,
  BOT,
  commit,
  knownFiles,
  matchingFolders,
  push,
  report,
  restoreRewritten,
  runIn,
  wipe,
} from './baselines.mjs';
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

  it('puts back the committed version of each baseline written again, leaving new and deleted ones', () => {
    const { root, git } = repo({
      'e2e/a-snapshots/noise.png': 'noise',
      'e2e/a-snapshots/gone.png': 'gone',
      'e2e/a-snapshots/same.png': 'same',
      'e2e/a.spec.ts': '',
    });
    const run = runIn(root);
    const at = (/** @type {string} */ f) => path.join(root, f);
    writeFileSync(at('e2e/a-snapshots/noise.png'), 'noise, a pixel off');
    rmSync(at('e2e/a-snapshots/gone.png'));
    writeFileSync(at('e2e/a-snapshots/new.png'), 'new');
    writeFileSync(at('e2e/a.spec.ts'), 'changed');
    expect(restoreRewritten(['e2e/*-snapshots'], run)).toEqual(['e2e/a-snapshots/noise.png']);
    expect(readFileSync(at('e2e/a-snapshots/noise.png'), 'utf8')).toBe('noise');
    expect(git('status', '--porcelain').trimEnd().split('\n').sort()).toEqual([
      ' D e2e/a-snapshots/gone.png',
      ' M e2e/a.spec.ts',
      '?? e2e/a-snapshots/new.png',
    ]);
    expect(restoreRewritten(['nothing'], run)).toEqual([]);
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
    git('add', 'e2e/a.spec.ts');

    expect(commit({ globs: ['e2e/*-snapshots'], by: 'a run', run })).toBe(true);
    // Committed, not yet pushed: push() does that.
    expect(
      execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'topic'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('first');
    expect(git('log', '-1', '--format=%s%n%n%b').trim()).toBe(
      'Update the visual baselines\n\nRewritten on CI by a run.',
    );
    expect(git('show', '--name-status', '--format=', 'HEAD').trim().split('\n').sort()).toEqual([
      'A\te2e/a-snapshots/new.png',
      'D\te2e/a-snapshots/old.png',
      'D\te2e/gone-snapshots/x.png',
    ]);
    // Only the baselines: the spec's change stays out, staged or not.
    expect(git('status', '--porcelain').trim()).toBe('M  e2e/a.spec.ts');
    push({ branch: 'topic', run });
    expect(
      execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'topic'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('Update the visual baselines');
  });

  it('commits nothing when the baselines are unchanged or there are none', () => {
    const { root, git } = repo({ 'shots/a.png': 'a' });
    const run = runIn(root);
    expect(commit({ globs: ['shots'], by: 'x', run })).toBe(false);
    expect(commit({ globs: ['none'], by: 'x', run })).toBe(false);
    // Something else staged, the baselines unchanged: still nothing to commit.
    writeFileSync(path.join(root, 'other.txt'), 'x');
    git('add', 'other.txt');
    expect(commit({ globs: ['shots'], by: 'x', run })).toBe(false);
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe('1');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('commit, amending, and push with a lease', () => {
  /** @param {string} remote */
  const remoteLog = (remote) =>
    execFileSync('git', ['--git-dir', remote, 'log', '--format=%H %an|%cn %s', 'topic'], {
      encoding: 'utf8',
    }).trim();

  it('adds the baselines to the head commit, keeping its message and author', () => {
    const { root, git } = repo({ 'shots/a.png': 'old', 'src/x.ts': '' });
    const run = runIn(root);
    const a = git('rev-parse', 'HEAD').trim();
    const message = git('log', '-1', '--format=%B').trim();
    writeFileSync(path.join(root, 'shots/a.png'), 'new');
    writeFileSync(path.join(root, 'src/x.ts'), 'not a baseline');
    expect(commit({ globs: ['shots'], by: 'ignored', run, amend: true })).toBe(true);
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe('1');
    expect(git('log', '-1', '--format=%B').trim()).toBe(message);
    expect(git('log', '-1', '--format=%an <%ae>|%cn <%ce>').trim()).toBe(
      `a <a@b.c>|${BOT.name} <${BOT.email}>`,
    );
    expect(git('diff', '--name-only', a, 'HEAD').trim()).toBe('shots/a.png');
    expect(git('status', '--porcelain').trim()).toBe('M src/x.ts');
  });

  it('force-pushes the amended commit only while the branch is where it was', () => {
    const { root, remote, git } = repo({ 'shots/a.png': 'old' });
    const run = runIn(root);
    const a = git('rev-parse', 'HEAD').trim();
    writeFileSync(path.join(root, 'shots/a.png'), 'new');
    commit({ globs: ['shots'], by: '', run, amend: true });
    push({ branch: 'topic', run, lease: a });
    const amended = git('rev-parse', 'HEAD').trim();
    expect(remoteLog(remote)).toBe(`${amended} a|${BOT.name} first`);

    // Someone pushes; a second amend's lease on the old head is refused.
    const other = path.join(mkdtempSync(path.join(tmpdir(), 'other-')), 'clone');
    execFileSync('git', ['clone', '-q', '-b', 'topic', remote, other]);
    writeFileSync(path.join(other, 'more.txt'), 'x');
    execFileSync('git', ['-C', other, 'add', 'more.txt']);
    execFileSync('git', [
      '-C',
      other,
      '-c',
      'user.name=b',
      '-c',
      'user.email=b@c.d',
      'commit',
      '-qm',
      'more',
    ]);
    execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'topic']);
    const theirs = execFileSync('git', ['-C', other, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(path.join(root, 'shots/a.png'), 'newer');
    commit({ globs: ['shots'], by: '', run, amend: true });
    expect(() => push({ branch: 'topic', run, lease: amended })).toThrow();
    expect(remoteLog(remote).split('\n')[0]).toBe(`${theirs} b|b more`);
  });
});

describe('report', () => {
  it('prints what the rewrite did, or its refusal as an error, with the exit code', () => {
    /** @type {string[]} */
    const lines = [];
    const log = (/** @type {string} */ line) => lines.push(line);
    expect(report(() => true, log)).toBe(0);
    expect(report(() => false, log)).toBe(0);
    expect(
      report(() => {
        throw new Error('no');
      }, log),
    ).toBe(1);
    expect(
      report(() => {
        throw 'text';
      }, log),
    ).toBe(1);
    expect(lines).toEqual([
      'Pushed the new baselines.',
      'The baselines are already up to date.',
      '::error::no',
      '::error::text',
    ]);
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
