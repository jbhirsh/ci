import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, gitCommits, selftest } from './selftest.mjs';

/** A throwaway repository holding these commits, oldest first. */
function repo(/** @type {{ message: string, author?: string }[]} */ commits) {
  const root = mkdtempSync(path.join(tmpdir(), 'commits-'));
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  for (const { message, author = 'Someone' } of commits) {
    git(
      '-c',
      `user.name=${author}`,
      '-c',
      'user.email=a@b.c',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      message,
    );
  }
  return root;
}

describe('gitCommits', () => {
  it('reads messages, parents and Dependabot', () => {
    const root = repo([
      { message: 'First\n\nBody.' },
      { message: 'Bump x', author: 'dependabot[bot]' },
    ]);
    const commits = gitCommits(root);
    expect(commits.map((c) => [c.message, c.login, c.parents])).toEqual([
      ['Bump x', 'dependabot[bot]', 1],
      ['First\n\nBody.', '', 0],
    ]);
  });
});

describe('selftest', () => {
  it('reports what the rules flag without failing on it', () => {
    const lines = selftest(repo([{ message: 'Good\n\nBody.' }, { message: 'WIP' }]));
    expect(lines[0]).toBe('commits: read 2 commits; the rules would flag 1 of them.');
    expect(lines[1]).toMatch(/^ {2}\w+ WIP$/);
  });

  it('fails when there is no history', () => {
    expect(() => selftest(repo([]))).toThrow();
  });
});

describe('cli', () => {
  it('prints the self-test and returns its exit code', () => {
    const lines = /** @type {string[]} */ ([]);
    expect(cli([repo([{ message: 'Good\n\nBody.' }])], (l) => lines.push(l))).toBe(0);
    expect(cli([repo([])], (l) => lines.push(l))).toBe(1);
    expect(lines.at(-1)).toMatch(/^commits self-test failed: /);
  });
});
