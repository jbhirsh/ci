// Where each test is, read for job-summary's report (summary.mjs): its file
// and line, so its name can link to it on GitHub, a snippet of its code for
// the tests worth reading (failed, slower, flaky), and which commits between
// the job's recent runs changed its file, so a test whose result changed
// because it was edited isn't called flaky (trends.mjs). The job has the
// repository checked out; anything that can't be found leaves that part
// out, never an error.

import { execFileSync } from 'node:child_process';

/** @typedef {import('./junit.mjs').TestCase} TestCase */
/** @typedef {(args: string[]) => string} Git */

/** How many lines a snippet shows at most. */
export const SNIPPET_LINES = 16;

/**
 * Git, from the checkout, or throwing when it fails.
 *
 * @type {Git}
 */
export function realGit(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The repository's files as git tracks them, or none outside a checkout.
 *
 * @param {Git} git
 * @returns {string[]}
 */
export function trackedFiles(git) {
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
 * @param {Pick<TestCase, 'suite' | 'source'>} test
 * @param {string[]} files tracked files
 * @returns {string} '' when none matches
 */
export function testPath(test, files) {
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
 * @param {string[]} lines the file's
 * @param {string} title
 */
export function testLine(lines, title) {
  if (!title) return 1;
  const quoted = ["'", '"', '`'].map((q) => `${q}${title}${q}`);
  const at = lines.findIndex((l) => quoted.some((q) => l.includes(q)));
  return at < 0 ? 1 : at + 1;
}

/**
 * The line a failure points at in the test's file, from its message's
 * stack (`render.test.mjs:142:18`), or 0 when it names none.
 *
 * @param {string} detail
 * @param {string} path
 */
export function failureLine(detail, path) {
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
 * @param {string[]} lines the file's
 * @param {number} start the test's first line
 * @param {number} hit the failure's line, or 0
 * @returns {[number, string, boolean][]} line number, text, and whether it's the failure's
 */
export function snippet(lines, start, hit) {
  if (!lines.length) return [];
  let from = start;
  if (hit && (hit < start || hit >= start + SNIPPET_LINES)) from = Math.max(1, hit - 8);
  const indent = (/** @type {string} */ l) => l.length - l.trimStart().length;
  const base = indent(lines[from - 1] ?? '');
  /** @type {[number, string, boolean][]} */
  const out = [];
  for (let n = from; n <= lines.length && out.length < SNIPPET_LINES; n++) {
    const line = lines[n - 1];
    out.push([n, line, n === hit]);
    const closes =
      n > from && line.trim() !== '' && indent(line) <= base && /^\s*[)}\]]/.test(line);
    if (closes && (!hit || n >= hit)) break;
  }
  return out;
}

/**
 * Where a test is, and its snippet when it's worth one.
 *
 * @typedef {object} Located
 * @property {string} path '' when not found
 * @property {number} line
 * @property {[number, string, boolean][] | null} code
 */

/**
 * Finds each test: its path and line, and a snippet for the ones `wanted`
 * names. Each file is read once.
 *
 * @param {(TestCase & { title: string })[]} tests
 * @param {Set<string>} wanted the names of the tests to show code for
 * @param {string[]} files tracked files
 * @param {(path: string) => string} read
 * @returns {Map<string, Located>} by test name
 */
export function locate(tests, wanted, files, read) {
  /** @type {Map<string, string[]>} */
  const cache = new Map();
  const linesOf = (/** @type {string} */ path) => {
    if (!cache.has(path)) {
      try {
        cache.set(path, read(path).split('\n'));
      } catch {
        cache.set(path, []);
      }
    }
    return cache.get(path) ?? [];
  };
  /** @type {Map<string, Located>} */
  const found = new Map();
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
 * @param {{ sha: string, branch: string }[]} runs oldest first, this run last
 * @param {Git} git
 * @param {number} [until] milliseconds
 * @param {() => number} [clock]
 * @returns {(Set<string> | null)[]}
 */
export function changedFiles(runs, git, until = Infinity, clock = Date.now) {
  const attempt = (/** @type {string[]} */ args) => {
    try {
      git(args);
      return true;
    } catch {
      return false;
    }
  };
  const present = (/** @type {string} */ sha) => attempt(['cat-file', '-e', `${sha}^{commit}`]);
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
