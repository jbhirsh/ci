// Picks what a PR's Stryker run mutates: its `--mutate` entries.
//
// The files are those the PR changed (against the merge base with the base
// branch) that the Stryker config's `mutate` globs select, applied the way
// Stryker applies them: in order, a `!` pattern taking back what an earlier
// one selected, dotfiles never matched. Reading the config's globs keeps one
// list of what is mutated, so the PR scope can't drift from the sweep's.
//
// Of a file that was there at the merge base, only the lines the PR adds or
// changes are mutated: one `file:first-last` entry per block, from
// `git diff -U0`, which --mutate accepts. The rest of the file is code the PR
// didn't write, and a PR touching many files would otherwise mutate every
// line of each (in BoardGames, 77 components came to 5,176 mutants and
// outran a three-hour job at 52%, saving nothing). A file new to the branch
// is mutated whole, and one whose change only deletes lines has nothing left
// to mutate.
//
// A changed test file stands for the source it covers (`x.test.ts`,
// `x.cache.test.ts` or `__tests__/x.test.ts` beside `x.ts`/`x.tsx`), mutated
// whole, since a weakened test can let any of its mutants survive (setting
// `testSubjects`). An infix is stripped only when no source has the full
// name, so `x.helpers.test.ts` covers `x.helpers.ts` alone.
//
// A file whose change is formatting alone is left out (setting
// `formatCheck`): when the app's Prettier, with the app's config, turns its
// merge-base version into exactly the PR's, nothing a mutant could change
// has changed, and a reformat would otherwise re-test every mutant. A test
// that was only reformatted stands for nothing. A new file, one Prettier
// ignores or can't parse, and every file when Prettier isn't installed yet,
// stay in: so a run before the install can only over-count, and an empty
// scope then is empty after it too, which lets the action skip the install.
//
// With nothing to mutate, a PR that touches what Stryker's own setup rests on
// (the `wiring` setting; deletions count) runs the `smoke` scope, so a broken
// setup still shows; any other skips Stryker altogether, and the required
// check still reports, as only Stryker's steps are skipped. A smoke run on
// every PR cost an install and a dry run on PRs that change only pictures or
// docs, and held up bots' PRs.
//
// Usage: node scope.mjs <base ref>   (run in the app's checkout, or APP_ROOT)
// Prints the entries, and writes the step outputs `run` (true/false),
// `mutate` (the entries comma-joined) and `reason` (changed, smoke or none).

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { appRoot, importFromApp } from '../lib/app.mjs';
import { readSettings, readStrykerConfig, wiringGlobs } from './settings.mjs';

/** @typedef {import('./report.mjs').LineRange} LineRange */

/**
 * Whether the ordered `mutate` globs select `file` (a repo-relative path).
 *
 * @param {string} file
 * @param {string[]} patterns
 */
export function inMutateScope(file, patterns) {
  let selected = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    if (path.matchesGlob(file, negated ? pattern.slice(1) : pattern)) selected = !negated;
  }
  return selected;
}

/**
 * Whether any of `files` is one the `globs` name.
 *
 * @param {string[]} files
 * @param {string[]} globs
 */
export function wiringChanged(files, globs) {
  return files.some((file) => globs.some((glob) => path.matchesGlob(file, glob)));
}

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/**
 * The source files a changed file stands for: itself, or a test's subject.
 *
 * @param {string} file
 * @param {(file: string) => boolean} exists
 */
export function subjects(file, exists) {
  if (!TEST_FILE.test(file)) return [file];
  const base = file.replace(TEST_FILE, '').replace(/(^|\/)__tests__\//, '$1');
  const sources = (/** @type {string} */ b) => [`${b}.ts`, `${b}.tsx`].filter((c) => exists(c));
  const exact = sources(base);
  return exact.length > 0 ? exact : sources(base.replace(/\.[\w-]+$/, ''));
}

/**
 * The line ranges a diff with no context lines (`git diff -U0`) adds to its
 * new side, as `[first, last]` pairs; a hunk that only deletes adds none.
 *
 * @param {string} diff
 * @returns {LineRange[]}
 */
export function addedRanges(diff) {
  /** @type {LineRange[]} */
  const ranges = [];
  for (const [, start, count] of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const lines = count === undefined ? 1 : Number(count);
    if (lines > 0) ranges.push([Number(start), Number(start) + lines - 1]);
  }
  return ranges;
}

/**
 * `file` as --mutate entries: whole when `ranges` is null, else one
 * `file:first-last` per range, so none when it only lost lines.
 *
 * @param {string} file
 * @param {LineRange[] | null} ranges
 */
export function mutateEntries(file, ranges) {
  return ranges === null ? [file] : ranges.map(([first, last]) => `${file}:${first}-${last}`);
}

/**
 * How the scope reads the repository: a file at the merge base (null when it
 * isn't there) and as the PR has it, the base version as Prettier writes it
 * (null when Prettier ignores or can't read it), whether a file exists, and
 * the lines a file adds or changes (null for a file new to the branch).
 *
 * @typedef {{
 *   before: (file: string) => string | null,
 *   now: (file: string) => string | null,
 *   format: (text: string, file: string) => Promise<string | null>,
 *   exists: (file: string) => boolean,
 *   ranges: (file: string) => LineRange[] | null,
 * }} ScopeIo
 */

/**
 * Whether `file` changed only in formatting. Any failure counts as a real
 * change.
 *
 * @param {string} file
 * @param {Pick<ScopeIo, 'before' | 'now' | 'format'>} io
 */
export async function formatOnly(file, { before, now, format }) {
  try {
    const base = before(file);
    if (base === null) return false;
    const formatted = await format(base, file);
    return formatted !== null && formatted === now(file);
  } catch {
    return false;
  }
}

/**
 * The --mutate entries for the changed files (deletions already left out),
 * each in-scope file once, in the order first met.
 *
 * @param {string[]} changed
 * @param {{ mutate: string[], testSubjects: boolean, formatCheck: boolean }} rules
 * @param {ScopeIo} io
 */
export async function scopeEntries(changed, { mutate, testSubjects, formatCheck }, io) {
  /** @type {Map<string, LineRange[] | null>} */
  const lines = new Map();
  for (const file of changed) {
    const isTest = testSubjects && TEST_FILE.test(file);
    const inScope = (isTest ? subjects(file, io.exists) : [file]).filter((f) =>
      inMutateScope(f, mutate),
    );
    // Only a file that would count is read and formatted: a PR's pictures
    // and docs cost nothing.
    if (inScope.length === 0 || (formatCheck && (await formatOnly(file, io)))) continue;
    for (const subject of inScope) {
      if (lines.get(subject) === null) continue;
      lines.set(subject, isTest ? null : io.ranges(subject));
    }
  }
  return [...lines].flatMap(([file, ranges]) => mutateEntries(file, ranges));
}

/**
 * @typedef {{ entries: string[], reason: 'changed' | 'smoke' | 'none' }} PrScope
 */

/**
 * The PR run's entries: its changed lines, else the smoke scope when
 * `touched` (every file the PR changes, deletions included) changes the
 * setup, else none.
 *
 * @param {{ changed: string[], touched: string[], mutate: string[],
 *   settings: import('./settings.mjs').Settings, io: ScopeIo }} args
 * @returns {Promise<PrScope>}
 */
export async function prScope({ changed, touched, mutate, settings, io }) {
  const entries = await scopeEntries(changed, { ...settings, mutate }, io);
  if (entries.length > 0) return { entries, reason: 'changed' };
  if (settings.smoke.length > 0 && wiringChanged(touched, wiringGlobs(settings))) {
    return { entries: [...settings.smoke], reason: 'smoke' };
  }
  return { entries: [], reason: 'none' };
}

/**
 * @typedef {{
 *   getFileInfo: (file: string, options: { ignorePath: string }) =>
 *     Promise<{ ignored: boolean, inferredParser: string | null }>,
 *   resolveConfig: (file: string) => Promise<Record<string, unknown> | null>,
 *   format: (text: string, options: Record<string, unknown>) => Promise<string>,
 * }} Prettier
 */

/**
 * The app's Prettier, or null when it isn't installed (or isn't Prettier).
 *
 * @param {string} root
 * @returns {Promise<Prettier | null>}
 */
export async function loadPrettier(root) {
  // Only the app's own: Node would also find one through NODE_PATH or a
  // global folder, which isn't the version the app formats with.
  if (!existsSync(path.join(root, 'node_modules', 'prettier', 'package.json'))) return null;
  /** @type {unknown} */
  let mod;
  try {
    mod = await importFromApp('prettier', root);
  } catch {
    return null;
  }
  for (const candidate of [mod, /** @type {{ default?: unknown }} */ (mod).default]) {
    const p = /** @type {Partial<Prettier> | undefined} */ (candidate);
    if (typeof p?.format === 'function' && typeof p.getFileInfo === 'function') {
      return /** @type {Prettier} */ (p);
    }
  }
  return null;
}

/**
 * Prettier's output for `text` as the file at `file` under `root`, with the
 * app's config and ignore file, or null when it ignores the file or has no
 * parser for it. Throws when the text won't parse (formatOnly counts that as
 * a real change).
 *
 * @param {Prettier | null} prettier
 * @param {string} root
 * @returns {ScopeIo['format']}
 */
export function prettierFormat(prettier, root) {
  return async (text, file) => {
    if (prettier === null) return null;
    const abs = path.join(root, file);
    const info = await prettier.getFileInfo(abs, {
      ignorePath: path.join(root, '.prettierignore'),
    });
    if (info.ignored || !info.inferredParser) return null;
    const options = (await prettier.resolveConfig(abs)) ?? {};
    return prettier.format(text, { ...options, filepath: abs });
  };
}

/**
 * Runs git in `root`, its stderr kept (a missing file's `cat-file -e` is an
 * answer, not an error to show).
 *
 * @param {string} root
 */
export function gitIn(root) {
  return (/** @type {string[]} */ ...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/**
 * The PR's files and readers over git: what changed between the merge base
 * of `baseRef` and HEAD, and both sides' versions.
 *
 * @param {string} root
 * @param {string} baseRef
 * @param {Prettier | null} prettier
 */
export function gitScope(root, baseRef, prettier) {
  const git = gitIn(root);
  const base = git('merge-base', baseRef, 'HEAD').trim();
  const names = (/** @type {string[]} */ ...filter) =>
    git('diff', '--name-only', '-z', ...filter, base, 'HEAD')
      .split('\0')
      .filter(Boolean);
  /**
   * @param {string} rev
   * @param {string} file
   */
  const show = (rev, file) => {
    try {
      return git('show', `${rev}:${file}`);
    } catch {
      return null;
    }
  };
  /** @type {ScopeIo} */
  const io = {
    before: (file) => show(base, file),
    now: (file) => show('HEAD', file),
    format: prettierFormat(prettier, root),
    exists: (file) => existsSync(path.join(root, file)),
    ranges: (file) => {
      try {
        git('cat-file', '-e', `${base}:${file}`);
      } catch {
        return null;
      }
      return addedRanges(
        git('diff', '-U0', '--no-ext-diff', '--no-color', base, 'HEAD', '--', file),
      );
    },
  };
  // --diff-filter=d: a removed file must not be passed to --mutate; but
  // removing a setup file (a patch) is still a change to the setup.
  return { changed: names('--diff-filter=d'), touched: names(), io };
}

/**
 * The PR scope for the app at `root` against `baseRef`.
 *
 * @param {string} root
 * @param {string} baseRef
 * @returns {Promise<PrScope>}
 */
export async function scopeFor(root, baseRef) {
  const settings = readSettings(root);
  const { mutate } = readStrykerConfig(settings, root);
  const prettier = settings.formatCheck ? await loadPrettier(root) : null;
  const { changed, touched, io } = gitScope(root, baseRef, prettier);
  return prScope({ changed, touched, mutate, settings, io });
}

const MESSAGES = {
  changed: 'Mutating the changed lines:',
  smoke: "No mutable lines changed, but Stryker's setup did: running the smoke scope:",
  none: 'No mutable lines and nothing in the Stryker setup changed: Stryker is skipped.',
};

/**
 * The command line: `<base ref>`. Returns the exit code.
 *
 * @param {string[]} args
 * @param {string} [root]
 */
export async function main(args, root = appRoot()) {
  const [baseRef] = args;
  if (!baseRef) {
    console.error('Usage: scope.mjs <base ref>');
    return 2;
  }
  const { entries, reason } = await scopeFor(root, baseRef);
  console.log([MESSAGES[reason], ...entries].join('\n'));
  setOutput('run', String(entries.length > 0));
  setOutput('mutate', entries.join(','));
  setOutput('reason', reason);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
