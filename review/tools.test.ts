import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeFetch } from './fakeFetch.ts';
import { github } from './github.ts';
import {
  REVIEW_MARKER,
  PART_LIMIT,
  SUMMARY_MARKER,
  changedPaths,
  commit,
  diff,
  inlineComment,
  listing,
  log,
  postSummary,
  pr,
  show,
  splitParts,
} from './tools.ts';

/** @type {string} */
let repoDir;
/** @type {string} */
let prSha;

/**
 * @param {string[]} args
 * @returns {string}
 */
const git = (args) =>
  execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GIT_AUTHOR_NAME: 'A',
      GIT_AUTHOR_EMAIL: 'a@x',
      GIT_COMMITTER_NAME: 'A',
      GIT_COMMITTER_EMAIL: 'a@x',
    },
  });

beforeAll(() => {
  repoDir = mkdtempSync(path.join(tmpdir(), 'review-tools-'));
  git(['init', '-q', '-b', 'main']);
  mkdirSync(path.join(repoDir, 'src'));
  writeFileSync(path.join(repoDir, 'src', 'a.ts'), 'a\n');
  writeFileSync(path.join(repoDir, 'old.ts'), 'old\n'.repeat(5));
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  writeFileSync(path.join(repoDir, 'src', 'a.ts'), 'a\nb\n');
  git(['mv', 'old.ts', 'new.ts']);
  writeFileSync(path.join(repoDir, '-flag.ts'), 'x\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'Change a, move old']);
  prSha = git(['rev-parse', 'HEAD']).trim();
});

/**
 * @param {Record<string, [number, unknown, string?]>} [routes]
 * @param {{ url: string, method?: string, body?: string }[]} [calls]
 * @returns {import('./tools.ts').Context}
 */
const ctx = (routes = {}, calls = []) => ({
  repoDir,
  base: 'main',
  repo: 'o/r',
  pr: '7',
  headSha: prSha,
  api: github('t', fakeFetch(routes, calls)),
});

describe('git tools', () => {
  it('knows the changed paths, rename sources included', () => {
    expect([...changedPaths(ctx())].sort()).toEqual(['-flag.ts', 'new.ts', 'old.ts', 'src/a.ts']);
  });
  it("diffs the whole PR or the files it's given, and nothing it doesn't change", () => {
    expect(diff(ctx(), {}).text).toContain('+b');
    const one = diff(ctx(), { paths: ['src/a.ts'] });
    expect(one.text).toContain('src/a.ts');
    expect(one.text).not.toContain('new.ts');
    expect(diff(ctx(), { paths: ['old.ts', 'new.ts'] }).text).toContain('rename');
    expect(diff(ctx(), { paths: ['README.md'] })).toEqual({
      text: 'not changed by this PR: README.md',
      isError: true,
    });
    expect(diff(ctx(), { paths: ['--output=x'] }).isError).toBe(true);
    expect(diff(ctx(), { paths: 'src/a.ts' }).isError).toBe(true);
  });
  it('gives a long diff in numbered parts, and refuses it whole', () => {
    const big = path.join(repoDir, 'big.ts');
    writeFileSync(big, 'x'.repeat(100).concat('\n').repeat(450));
    git(['add', 'big.ts']);
    git(['commit', '-q', '-m', 'big']);
    try {
      const whole = diff(ctx(), { paths: ['big.ts'] });
      expect(whole.isError).toBe(true);
      expect(whole.text).toMatch(/in 3 parts/);
      const one = diff(ctx(), { paths: ['big.ts'], part: 1 });
      expect(one.text.startsWith('Part 1 of 3 of this diff.\n')).toBe(true);
      expect(Buffer.byteLength(one.text)).toBeLessThan(PART_LIMIT + 100);
      expect(diff(ctx(), { paths: ['big.ts'], part: 4 }).isError).toBe(true);
      expect(diff(ctx(), { paths: ['big.ts'], part: 0 }).isError).toBe(true);
    } finally {
      git(['reset', '-q', '--hard', 'HEAD~1']);
    }
  });
  it('splits at line ends by bytes, losing nothing', () => {
    const text = 'ab\n'.repeat(30_000);
    const parts = splitParts(text);
    expect(parts.join('')).toBe(text);
    expect(parts.every((p) => Buffer.byteLength(p) <= PART_LIMIT && p.endsWith('\n'))).toBe(true);
    // Dense text: four bytes a character, and one line longer than a part.
    const emoji = '😀'.repeat(PART_LIMIT);
    const split = splitParts(emoji);
    expect(split.join('')).toBe(emoji);
    expect(split.every((p) => Buffer.byteLength(p) <= PART_LIMIT)).toBe(true);
    expect(splitParts('')).toEqual(['']);
  });
  it('lists and counts the changes', () => {
    expect(listing(ctx(), '--name-status').text).toMatch(/^R\d+\told\.ts\tnew\.ts$/m);
    expect(listing(ctx(), '--stat').text).toContain('src/a.ts');
  });
  it('shows a file at HEAD or the base, and refuses any other ref', () => {
    expect(show(ctx(), { ref: 'HEAD', path: 'src/a.ts' }).text).toBe('a\nb\n');
    expect(show(ctx(), { ref: 'origin/main', path: 'src/a.ts' }).text).toBe('a\n');
    expect(show(ctx(), { ref: 'HEAD', path: 'gone.ts' })).toEqual({
      text: 'HEAD holds no gone.ts',
      isError: true,
    });
    expect(show(ctx(), { ref: 'HEAD~1', path: 'src/a.ts' }).isError).toBe(true);
    expect(show(ctx(), { ref: 'HEAD', path: '--help' }).isError).toBe(true);
  });
  it("lists the PR's commits and shows one of them, and no other", () => {
    expect(log(ctx()).text).toMatch(/^[0-9a-f]+ A <a@x> Change a, move old$/m);
    expect(commit(ctx(), { sha: prSha.slice(0, 8) }).text).toContain('src/a.ts');
    const base = git(['rev-parse', 'origin/main']).trim();
    expect(commit(ctx(), { sha: base }).isError).toBe(true);
    expect(commit(ctx(), { sha: '--all' }).isError).toBe(true);
  });
});

describe('GitHub tools', () => {
  const comments = 'GET https://api.github.com/repos/o/r/issues/7/comments?per_page=100';
  const summary = {
    id: 3,
    body: `${SUMMARY_MARKER}\nold`,
    user: { login: 'github-actions[bot]' },
  };
  const legacy = {
    id: 2,
    body: `${SUMMARY_MARKER}\nfrom the action`,
    user: { login: 'claude[bot]' },
  };
  const forged = { id: 4, body: `${SUMMARY_MARKER}\nfake`, user: { login: 'someone' } };

  it('reads the PR and its earlier summary, ignoring look-alikes', async () => {
    const result = await pr(
      ctx({
        'GET https://api.github.com/repos/o/r/pulls/7': [
          200,
          { title: 'T', body: 'B', user: { login: 'u' }, head: { ref: 'b' } },
        ],
        'GET https://api.github.com/repos/o/r/pulls/7/comments?per_page=100': [
          200,
          [{ path: 'src/a.ts', line: 2, body: 'fix', user: { login: 'claude[bot]' } }],
        ],
        [comments]: [200, [summary, forged]],
      }),
    );
    const data = JSON.parse(result.text);
    expect(data).toMatchObject({ title: 'T', description: 'B', earlierSummary: summary.body });
    expect(data.reviewComments).toEqual([
      { path: 'src/a.ts', line: 2, author: 'claude[bot]', body: 'fix' },
    ]);
  });
  it('replaces the earlier summary, or posts one, always with the marker', async () => {
    /** @type {{ url: string, method?: string, body?: string }[]} */
    const calls = [];
    const replaced = await postSummary(
      ctx(
        {
          [comments]: [200, [summary]],
          'PATCH https://api.github.com/repos/o/r/issues/comments/3': [200, {}],
        },
        calls,
      ),
      { body: 'new' },
    );
    expect(replaced.text).toContain('Replaced');
    expect(JSON.parse(calls.at(-1)?.body ?? '{}').body).toBe(`${SUMMARY_MARKER}\nnew`);
    const posted = await postSummary(
      ctx({
        [comments]: [200, [forged]],
        'POST https://api.github.com/repos/o/r/issues/7/comments': [201, { id: 9 }],
      }),
      { body: `${SUMMARY_MARKER}\nfirst` },
    );
    expect(posted.text).toBe('Posted the summary comment (9).');
    // claude-code-action's summary is claude[bot]'s, which the job's token
    // can't edit: it's read, and a new one posted.
    const fresh = await postSummary(
      ctx({
        [comments]: [200, [legacy]],
        'POST https://api.github.com/repos/o/r/issues/7/comments': [201, { id: 10 }],
      }),
      { body: 'x' },
    );
    expect(fresh.text).toBe('Posted the summary comment (10).');
    expect((await postSummary(ctx(), { body: ' ' })).isError).toBe(true);
  });
  it('comments only on files the PR changes, on the head commit', async () => {
    /** @type {{ url: string, method?: string, body?: string }[]} */
    const calls = [];
    const route = 'POST https://api.github.com/repos/o/r/pulls/7/comments';
    const made = await inlineComment(ctx({ [route]: [201, { id: 5 }] }, calls), {
      path: 'src/a.ts',
      line: 2,
      startLine: 1,
      body: 'Bug',
    });
    expect(made.text).toBe('Commented on src/a.ts:2 (5).');
    expect(JSON.parse(calls.at(-1)?.body ?? '{}')).toEqual({
      body: `Bug\n\n${REVIEW_MARKER}`,
      commit_id: prSha,
      path: 'src/a.ts',
      line: 2,
      side: 'RIGHT',
      start_line: 1,
      start_side: 'RIGHT',
    });
    for (const bad of [
      { path: 'README.md', line: 1, body: 'x' },
      { path: 'src/a.ts', line: 0, body: 'x' },
      { path: 'src/a.ts', line: 2, startLine: 2, body: 'x' },
      { path: 'src/a.ts', line: 2, side: 'UP', body: 'x' },
      { path: 'src/a.ts', line: 2, body: '' },
    ]) {
      expect((await inlineComment(ctx(), bad)).isError).toBe(true);
    }
    const refused = await inlineComment(ctx({ [route]: [422, { message: 'line not in diff' }] }), {
      path: 'src/a.ts',
      line: 99,
      body: 'x',
    });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain('422');
  });
});
