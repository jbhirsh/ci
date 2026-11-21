import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { github } from './github.mjs';
import { fakeFetch } from './fakeFetch.mjs';
import { commit, diff, inlineComment, show } from './tools.mjs';

/** @type {import('./tools.mjs').Context} */
let ctx;

beforeAll(() => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'review-tools-prop-'));
  const env = {
    PATH: process.env.PATH,
    GIT_AUTHOR_NAME: 'A',
    GIT_AUTHOR_EMAIL: 'a@x',
    GIT_COMMITTER_NAME: 'A',
    GIT_COMMITTER_EMAIL: 'a@x',
  };
  /** @param {string[]} args */
  const git = (args) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(path.join(repoDir, 'a.ts'), 'a\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  writeFileSync(path.join(repoDir, 'a.ts'), 'b\n');
  git(['commit', '-q', '-am', 'change']);
  ctx = {
    repoDir,
    base: 'main',
    repo: 'o/r',
    pr: '1',
    headSha: git(['rev-parse', 'HEAD']).trim(),
    api: github('t', fakeFetch({})),
  };
});

/** Strings a model might send: options, paths, injections, unicode. */
const text = fc.oneof(
  fc.string(),
  fc.constantFrom('-', '--', '--output=/tmp/x', '--upload-pack=sh', '../../etc/passwd', 'a.ts'),
  fc.string().map((s) => `-${s}`),
  fc.string().map((s) => `a.ts${s}`),
);

// Each run that gets past a tool's own refusals starts a git process (the tools
// run git for real, which is the point), so these take 0.1-0.3 s on a quiet
// machine but 15-27 s when every start costs 250 ms, as on ci#127's runner. They
// keep all their runs and get a hang limit of their own, well above that.
describe('the tools, for any input', { timeout: 120_000 }, () => {
  it('never throw, and diff only files the PR changes', () => {
    fc.assert(
      fc.property(fc.array(text, { maxLength: 4 }), (paths) => {
        const result = diff(ctx, { paths });
        if (!result.isError && paths.length > 0) {
          expect(paths.every((p) => p === 'a.ts')).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
  it('never throw, and show only HEAD or the base', () => {
    fc.assert(
      fc.property(fc.oneof(text, fc.constantFrom('HEAD', 'origin/main')), text, (ref, file) => {
        const result = show(ctx, { ref, path: file });
        if (!result.isError) {
          expect(['HEAD', 'origin/main']).toContain(ref);
          expect(file.startsWith('-')).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
  it("never throw, and show only the PR's commits", () => {
    fc.assert(
      fc.property(fc.oneof(text, fc.stringMatching(/^[0-9a-f]{7,12}$/)), (sha) => {
        const result = commit(ctx, { sha });
        if (!result.isError) expect(ctx.headSha.startsWith(sha)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
  it('never comment on a file the PR leaves alone', async () => {
    await fc.assert(
      fc.asyncProperty(text, fc.integer(), text, async (file, line, body) => {
        const result = await inlineComment(ctx, { path: file, line, body });
        // The fake GitHub refuses every post, so anything that got that far
        // was a changed file on a real line.
        if (!result.text.startsWith('GitHub refused')) expect(result.isError).toBe(true);
        else expect(file).toBe('a.ts');
      }),
      { numRuns: 100 },
    );
  });
});
