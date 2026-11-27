// Where each test is, read for job-summary's report (summary.ts): its file
// and line, so its name can link to it on GitHub, a snippet of its code for
// the tests worth reading (failed, slower, flaky), and which commits between
// the job's recent runs changed its file, so a test whose result changed
// because it was edited isn't called flaky (trends.ts). The job has the
// repository checked out; anything that can't be found leaves that part
// out, never an error.

import { execFileSync } from 'node:child_process';
import type { TestCase } from './junit.ts';

export type Git = (args: string[]) => string;

/** How many lines a snippet shows at most. */
export const SNIPPET_LINES = 16;

/**
 * Git, from the checkout, or throwing when it fails.
 */
export function realGit(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The repository's files as git tracks them, or none outside a checkout.
 */
export function trackedFiles(git: Git): string[] {
  try {
    return git(['ls-files']).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * A test's file in the repository: Maestro names it (its file attribute),
 * Vitest gives it as the suite, Playwright gives it relative to its test
 * folder, so it's the tracked file that the suite's path ends.
 *
 * @param test
 * @param files tracked files
 * @returns '' when none matches
 */
export function testPath(test: Pick<TestCase, 'suite' | 'source'>, files: string[]): string {
  const known = new Set(files);
  for (const candidate of [test.source, test.suite]) {
    const clean = candidate.replace(/^\.\//, '');
    if (!clean) continue;
    if (known.has(clean)) return clean;
    const ending = files.filter((f) => f.endsWith(`/${clean}`));
    if (ending.length === 1) return ending[0];
  }
  return '';
}

/**
 * The line a test starts on: where its title appears as a string (Vitest's
 * and Playwright's `it('title', …)`), or 1 for a file that is the test
 * (a Maestro flow).
 *
 * @param lines the file's
 * @param title
 */
export function testLine(lines: string[], title: string) {
  if (!title) return 1;
  const quoted = ["'", '"', '`'].map((q) => `${q}${title}${q}`);
  const at = lines.findIndex((l) => quoted.some((q) => l.includes(q)));
  return at < 0 ? 1 : at + 1;
}

/**
 * The line a failure points at in the test's file, from its message's
 * stack (`render.test.ts:142:18`), or 0 when it names none.
 */
export function failureLine(detail: string, path: string) {
  const base = path.split('/').pop() ?? '';
  if (!base) return 0;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = detail.match(new RegExp(`${escaped}:(\\d+)`));
  return m ? Number(m[1]) : 0;
}

/**
 * A snippet of a test: from its first line, or around the line its failure
 * points at, at most SNIPPET_LINES, stopping after the line that closes the
 * test (back to its first line's indent) when that comes first.
 *
 * @param lines the file's
 * @param start the test's first line
 * @param hit the failure's line, or 0
 * @returns line number, text, and whether it's the failure's
 */
export function snippet(lines: string[], start: number, hit: number): [number, string, boolean][] {
  if (!lines.length) return [];
  let from = start;
  if (hit && (hit < start || hit >= start + SNIPPET_LINES)) from = Math.max(1, hit - 8);
  const indent = (l: string) => l.length - l.trimStart().length;
  const base = indent(lines[from - 1] ?? '');
  const out: [number, string, boolean][] = [];
  for (let n = from; n <= lines.length && out.length < SNIPPET_LINES; n++) {
    const line = lines[n - 1];
    out.push([n, line, n === hit]);
    const closes =
      n > from && line.trim() !== '' && indent(line) <= base && /^\s*[)}\]]/.test(line);
    if (closes && (!hit || n >= hit)) break;
  }
  return out;
}

/** Where a test is, and its snippet when it's worth one. */
export type Located = {
  /** '' when not found */
  path: string;
  line: number;
  code: [number, string, boolean][] | null;
};

/**
 * Finds each test: its path and line, and a snippet for the ones `wanted`
 * names. Each file is read once.
 *
 * @param tests
 * @param wanted the names of the tests to show code for
 * @param files tracked files
 * @param read
 * @returns by test name
 */
export function locate(
  tests: (TestCase & { title: string })[],
  wanted: Set<string>,
  files: string[],
  read: (path: string) => string,
): Map<string, Located> {
  const cache: Map<string, string[]> = new Map();
  const linesOf = (path: string) => {
    if (!cache.has(path)) {
      try {
        cache.set(path, read(path).split('\n'));
      } catch {
        cache.set(path, []);
      }
    }
    return cache.get(path) ?? [];
  };
  const found: Map<string, Located> = new Map();
  for (const t of tests) {
    const path = testPath(t, files);
    if (!path) {
      found.set(t.name, { path: '', line: 1, code: null });
      continue;
    }
    const lines = linesOf(path);
    const flow = /\.ya?ml$/.test(path);
    const line = flow ? 1 : testLine(lines, t.title);
    const code = wanted.has(t.name) ? snippet(lines, line, failureLine(t.detail, path)) : null;
    found.set(t.name, { path, line, code: code?.length ? code : null });
  }
  return found;
}

/**
 * The files each run's commit changed since the previous run on the same
 * branch, oldest run first: null where that can't be told (a branch's first
 * run here, a commit git can't reach, or time up). Runs alternate between a
 * pull request's branch and the default branch, and a diff across the two
 * would show the branch's own edits as a change at every step. Commits the
 * checkout lacks are fetched together, each only as deep as itself, which
 * is all a diff of two commits needs; nothing is fetched or diffed once
 * `until` has passed.
 *
 * @param runs oldest first, this run last
 * @param git
 * @param until milliseconds
 * @param clock
 */
export function changedFiles(
  runs: { sha: string; branch: string }[],
  git: Git,
  until: number = Infinity,
  clock: () => number = Date.now,
): (Set<string> | null)[] {
  const attempt = (args: string[]) => {
    try {
      git(args);
      return true;
    } catch {
      return false;
    }
  };
  const present = (sha: string) => attempt(['cat-file', '-e', `${sha}^{commit}`]);
  const before = runs.map((r, i) => {
    for (let j = i - 1; j >= 0; j--) if (runs[j].branch === r.branch) return runs[j].sha;
    return '';
  });
  const wanted = [...new Set(runs.flatMap((r, i) => (before[i] ? [before[i], r.sha] : [])))].filter(
    Boolean,
  );
  const have = new Set(wanted.filter(present));
  const missing = wanted.filter((sha) => !have.has(sha));
  if (missing.length && clock() < until) {
    attempt(['fetch', '--no-tags', '--depth=1', 'origin', ...missing]);
    for (const sha of missing) if (present(sha)) have.add(sha);
  }
  return runs.map((r, i) => {
    const from = before[i];
    if (!from || !r.sha) return null;
    if (from === r.sha) return new Set();
    if (!have.has(from) || !have.has(r.sha) || clock() >= until) return null;
    try {
      return new Set(git(['diff', '--name-only', from, r.sha]).split('\n').filter(Boolean));
    } catch {
      return null;
    }
  });
}
