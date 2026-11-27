// Fails when a source file escapes the app's coverage gate unnoticed.
//
//   node unmeasured/check.ts     from the app's checkout (or APP_ROOT), after
//                                 a passing coverage run
//
// The coverage gate holds every file it measures to the app's bar, but which
// files it measures is the app's config, and nothing checked that: an
// `exclude` line, or an `include` pattern too narrow for a new folder, takes
// files out of the gate without anyone deciding to (jbhirsh/ci#35). So this
// compares what the coverage report measured with the app's source files,
// and every source file left out needs a reason written down.
//
// It reads the report, not the config, which each app writes its own way
// (Vitest's include/exclude, Jest's collectCoverageFrom): the report is the
// same in every app, and any route out of the gate shows there.
//   - The report is `coverage/coverage-final.json` (Istanbul's, Vitest's
//     `json` reporter and Jest's default), whose keys are the measured files,
//     untested ones included: Vitest lists every `include` match, Jest every
//     `collectCoverageFrom` match. Its keys are absolute; any outside the app
//     are ignored.
//   - The source files are those git tracks ending .ts, .tsx, .js, .jsx,
//     .mjs, .cjs, .mts or .cts, less the files that are never app code:
//       test files (`*.test.*`, `*.spec.*`), anything under a `__tests__` or
//       `__mocks__` folder, declaration files (`*.d.ts`), and config files at
//       the repo root (`*.config.*`, or a dotfile such as
//       `.dependency-cruiser.cjs`).
//     These go by file name and folder name, not by glob: a glob's wildcard
//     doesn't cross a folder starting with a dot, so `**/*.test.*` would miss
//     `.github/scripts/x.test.mjs`.
//
// The app's setting, its `unmeasured` key in `.github/ci.json`:
//   "unmeasured": { "files": ["<glob>: <reason>", ...] }
// Each entry names a glob of files the gate leaves out on purpose (generated
// code, test support, a browser-only entry point) and why, a reason of a few
// words (lib/reason.ts). Globs are lib/match.ts's: a wildcard doesn't enter
// a folder starting with a dot, so name such a path outright. With no key,
// nothing is listed.
//
// It fails on:
//   - a source file the report doesn't hold and no entry lists;
//   - an entry whose glob matches no unmeasured file (it outlived its files,
//     or names a file the gate measures);
//   - an entry with no `": "` before its reason, or too short a reason;
//   - a missing or unreadable report.
// A measured file under the bar isn't this check's: the gate fails that.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig, appRoot } from '../lib/app.ts';
import { matches } from '../lib/match.ts';
import { isReason } from '../lib/reason.ts';

/** Where the coverage run writes its report, from the app's root. */
export const REPORT = 'coverage/coverage-final.json';

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST = /\.(?:test|spec)\.[^/]+$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const CONFIG = /\.config\.[^/]+$/;
const TEST_FOLDERS = new Set(['__tests__', '__mocks__']);

/**
 * Whether a tracked file is source the gate should measure: code, and not a
 * test, a declaration or a root config file.
 *
 * @param file a repository path, with forward slashes
 */
export function isSource(file: string) {
  if (!CODE.test(file)) return false;
  const segments = file.split('/');
  const name = segments.at(-1) ?? '';
  if (TEST.test(name) || DECLARATION.test(name)) return false;
  if (segments.slice(0, -1).some((s) => TEST_FOLDERS.has(s))) return false;
  if (segments.length === 1 && (CONFIG.test(name) || name.startsWith('.'))) return false;
  return true;
}

/**
 * A path with its symbolic links resolved, or the path itself when it
 * doesn't exist (a report key for a file since deleted).
 */
export function realPath(file: string) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * The files a coverage report measured, as repository paths. A key outside
 * the app's root is dropped. `real` resolves links on both sides, as a test
 * runner may write real paths while the root it was given runs through a
 * link (APP_ROOT on a symlinked checkout).
 *
 * @param report the parsed coverage-final.json
 * @param root the app's root, absolute
 * @param real
 */
export function measuredFiles(
  report: Record<string, unknown>,
  root: string,
  real: (file: string) => string = (file) => file,
): Set<string> {
  const files = new Set<string>();
  const base = real(root);
  for (const key of Object.keys(report)) {
    const relative = path.relative(base, real(path.resolve(root, key)));
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)) continue;
    files.add(relative.split(path.sep).join('/'));
  }
  return files;
}

export type Entry = {
  glob: string;
  /** the entry as written */
  text: string;
};

/**
 * The app's `unmeasured.files` entries, split into globs and the entries
 * that are malformed (with what's wrong).
 *
 * @param settings the app's `unmeasured` key
 */
export function readEntries(settings: Record<string, unknown>): {
  entries: Entry[];
  malformed: string[];
} {
  const unknown = Object.keys(settings).filter((key) => key !== 'files');
  if (unknown.length > 0) {
    throw new Error(`.github/ci.json: unmeasured has no setting ${unknown.join(', ')}`);
  }
  const value = settings.files ?? [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error('.github/ci.json: unmeasured.files must be a list of "<glob>: <reason>"');
  }
  const entries: Entry[] = [];
  const malformed: string[] = [];
  for (const text of value) {
    const at = text.indexOf(': ');
    if (at <= 0) {
      malformed.push(
        `"${text}" has no "<glob>: <reason>" shape: write the glob, ": ", then why it isn't measured.`,
      );
    } else if (!isReason(text.slice(at + 2))) {
      malformed.push(
        `"${text}" gives too short a reason: say in a few words why it isn't measured.`,
      );
    } else {
      entries.push({ glob: text.slice(0, at), text });
    }
  }
  return { entries, malformed };
}

export type Result = {
  /** source files the report holds */
  measured: string[];
  /** source files it doesn't, that an entry lists */
  listed: string[];
  /** source files it doesn't, that nothing lists */
  unmeasured: string[];
  /** entries whose glob matches no unmeasured file */
  stale: Entry[];
};

/**
 * Sorts the app's source files by whether the gate measures them, and finds
 * the entries that list nothing.
 *
 * @param tracked every file git tracks
 * @param measured the report's files
 * @param entries
 */
export function classify(tracked: string[], measured: Set<string>, entries: Entry[]): Result {
  const result: Result = { measured: [], listed: [], unmeasured: [], stale: [] };
  const missing = tracked.filter((file) => isSource(file) && !measured.has(file));
  for (const file of tracked) {
    if (!isSource(file)) continue;
    if (measured.has(file)) result.measured.push(file);
    else if (entries.some(({ glob }) => matches(file, glob))) result.listed.push(file);
    else result.unmeasured.push(file);
  }
  result.stale = entries.filter(({ glob }) => !missing.some((file) => matches(file, glob)));
  return result;
}

/**
 * What fails, as messages that say how to fix it.
 */
export function failures(result: Result, malformed: string[]): string[] {
  return [
    ...result.unmeasured.map(
      (file) =>
        `${file} isn't measured by the coverage gate. Measure it (widen the coverage include, or drop the exclude that takes it out), or list it in .github/ci.json's unmeasured.files as "<glob>: <reason>". If the config does include it, it may fail to transform, or carry an "istanbul ignore file" comment.`,
    ),
    ...result.stale.map(
      ({ text }) =>
        `.github/ci.json unmeasured.files "${text}" matches no unmeasured file: the gate measures what it named, or the files are gone. Delete the entry.`,
    ),
    ...malformed.map((message) => `.github/ci.json unmeasured.files ${message}`),
  ];
}

/**
 * Reads the report; throws, saying how to fix it, when it's missing or isn't
 * a coverage-final.json.
 */
export function readReport(root: string): Record<string, unknown> {
  const file = path.join(root, REPORT);
  if (!existsSync(file)) {
    throw new Error(
      `${REPORT} is missing. Run this after the coverage run, and give it a "json" reporter (Vitest: coverage.reporter; Jest writes it by default).`,
    );
  }
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `${REPORT} isn't valid JSON (${error instanceof Error ? error.message : error}): re-run the coverage run to write it again.`,
      { cause: error },
    );
  }
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error(`${REPORT} isn't a coverage report: it should be an object keyed by file.`);
  }
  return report as Record<string, unknown>;
}

/**
 * The files git tracks in the app.
 */
export function trackedFiles(root: string): string[] {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(
      `git ls-files failed in ${root}: run this step from the app's checkout (after actions/checkout), or set APP_ROOT to it.`,
      { cause: error },
    );
  }
  return out.split('\0').filter((file) => file !== '');
}

/**
 * Runs the check on the app at `root` and returns the exit code.
 */
export function main(
  root: string,
  {
    log = console.log,
    actions = Boolean(process.env.GITHUB_ACTIONS),
  }: { log?: (line: string) => void; actions?: boolean } = {},
): number {
  let messages;
  let result;
  try {
    const { entries, malformed } = readEntries(appConfig('unmeasured', root));
    result = classify(trackedFiles(root), measuredFiles(readReport(root), root, realPath), entries);
    messages = failures(result, malformed);
  } catch (error) {
    messages = [error instanceof Error ? error.message : String(error)];
  }
  for (const message of messages) log(actions ? `::error::${message}` : message);
  log(
    messages.length === 0 && result
      ? `unmeasured: every source file is measured (${result.measured.length}) or listed with a reason (${result.listed.length}).`
      : `unmeasured: ${messages.length} to fix (unmeasured/check.ts says what counts).`,
  );
  return messages.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(appRoot());
}
