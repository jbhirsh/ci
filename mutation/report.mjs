// Stryker's results as the mutation scripts read them: the incremental file
// (reports/stryker-incremental.json, which `--incremental` reads and writes)
// and the JSON report (reports/mutation/mutation.json, the `json` reporter's)
// share one shape, mutation-testing-report-schema's, of which only the parts
// typed here are read; everything else is carried through untouched.
//
// Paths are compared as a --mutate scope names them: relative to the app's
// checkout, with forward slashes. Stryker names files relative in one place
// and absolute in another, so every comparison goes through relativeName.
//
// A scope is the run's --mutate entries: a file whole (`src/a.ts`), or a
// block of its lines (`src/a.ts:10-20`, what scope.mjs prints for a file a PR
// edited). A mutant belongs to a block when it starts and ends inside it,
// Stryker's own rule for a line range; a file named whole anywhere is whole.
//
// The score is Stryker's (mutation-testing-metrics): detected (killed and
// timed out) over valid (detected, survived and with no coverage), leaving
// out compile and runtime errors and ignored mutants.

import { readFileSync } from 'node:fs';

/**
 * @typedef {{ line?: number, column?: number }} Position
 * @typedef {{ start?: Position, end?: Position }} Location
 * @typedef {{ id?: string, status?: string, location?: Location, coveredBy?: string[],
 *   killedBy?: string[], [key: string]: unknown }} Mutant
 * @typedef {{ mutants?: Mutant[], [key: string]: unknown }} FileResult
 * @typedef {{ id: string, name: string, location?: Location, [key: string]: unknown }} Test
 * @typedef {{ tests?: Test[], [key: string]: unknown }} TestFileResult
 * @typedef {{ files?: Record<string, FileResult>, testFiles?: Record<string, TestFileResult>,
 *   config?: Record<string, unknown>, [key: string]: unknown }} Report
 * @typedef {[first: number, last: number]} LineRange
 * @typedef {Map<string, LineRange[] | null>} Scope
 */

/**
 * Whether `value` is a plain object (not null, not an array).
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A report read from JSON text: null when it isn't JSON, or isn't an object
 * whose `files` and `testFiles` (when present) are objects.
 *
 * @param {string | null} text
 * @returns {Report | null}
 */
export function parseReport(text) {
  if (text === null) return null;
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of ['files', 'testFiles']) {
    if (value[key] !== undefined && !isRecord(value[key])) return null;
  }
  return /** @type {Report} */ (value);
}

/**
 * A file's text, or null when it can't be read.
 *
 * @param {string} file
 * @returns {string | null}
 */
export function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * A path as a scope names it: relative to `cwd`, with forward slashes and no
 * leading `./`. A path outside `cwd` is left as it is.
 *
 * @param {string} file
 * @param {string} cwd
 */
export function relativeName(file, cwd) {
  const name = file.replace(/\\/g, '/');
  const root = `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/`;
  return (name.startsWith(root) ? name.slice(root.length) : name).replace(/^\.\//, '');
}

/**
 * The scope's entries by file: null for a file named whole, else the line
 * ranges named for it. Blank entries and surrounding spaces are skipped.
 *
 * @param {string[]} entries
 * @param {string} cwd
 * @returns {Scope}
 */
export function parseScope(entries, cwd) {
  /** @type {Scope} */
  const byFile = new Map();
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const lines = /^(.+):(\d+)-(\d+)$/.exec(entry);
    const name = relativeName(lines ? lines[1] : entry, cwd);
    const known = byFile.get(name);
    if (!lines || known === null) byFile.set(name, null);
    else byFile.set(name, [...(known ?? []), [Number(lines[2]), Number(lines[3])]]);
  }
  return byFile;
}

/**
 * Whether a mutant starts and ends inside one of `ranges` (1-based lines).
 *
 * @param {Mutant} mutant
 * @param {LineRange[]} ranges
 */
export function inRanges(mutant, ranges) {
  const start = mutant.location?.start?.line;
  const end = mutant.location?.end?.line;
  if (start === undefined || end === undefined) return false;
  return ranges.some(([first, last]) => start >= first && end <= last);
}

/**
 * @typedef {{ killed: number, timeout: number, survived: number, noCoverage: number,
 *   errors: number, ignored: number, score: number | null }} Counts
 */

/**
 * Mutants by status, and Stryker's score over them (null with nothing valid).
 *
 * @param {Iterable<Mutant>} mutants
 * @returns {Counts}
 */
export function counts(mutants) {
  /** @type {Map<string, number>} */
  const count = new Map();
  for (const { status = 'unknown' } of mutants) count.set(status, (count.get(status) ?? 0) + 1);
  const n = (/** @type {string} */ status) => count.get(status) ?? 0;
  const detected = n('Killed') + n('Timeout');
  const valid = detected + n('Survived') + n('NoCoverage');
  return {
    killed: n('Killed'),
    timeout: n('Timeout'),
    survived: n('Survived'),
    noCoverage: n('NoCoverage'),
    errors: n('CompileError') + n('RuntimeError'),
    ignored: n('Ignored'),
    score: valid > 0 ? (detected / valid) * 100 : null,
  };
}

/**
 * Every mutant of every file in a report.
 *
 * @param {Report} report
 * @returns {Mutant[]}
 */
export function allMutants(report) {
  return Object.values(report.files ?? {}).flatMap((file) => file.mutants ?? []);
}
