// Narrows a restored Stryker incremental file to what a PR run mutates,
// rewriting it in place.
//
// Stryker's incremental mode carries every old result in the file into the
// run's report and score, in scope or not: restore main's baseline into a PR
// run that mutates three files and the PR is scored on the whole project,
// its three files diluted by thousands of reused results; restore a PR's
// own last results and a file it no longer changes keeps failing it, or an
// earlier push's well-tested code lifts new code over the threshold. So a
// file the scope doesn't name is dropped, and one it names by lines keeps
// only the mutants lying wholly within them (report.mjs). Test files are
// kept: Stryker needs them to tell which tests changed.
//
// The kept mutants' lines are the earlier run's and the ranges this one's: a
// mutant whose line has since moved out of range is dropped and re-tested,
// which costs time but never a wrong score.
//
// Usage: node narrow.mjs <incremental file> <comma-separated scope>

import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { appRoot } from '../lib/app.mjs';
import { inRanges, parseReport, parseScope, readText, relativeName } from './report.mjs';

/** @typedef {import('./report.mjs').Report} Report */

/**
 * The report with only the files, and lines, named in `scope` left in it.
 *
 * @param {Report} report
 * @param {string[]} scope
 * @param {string} cwd
 * @returns {Report}
 */
export function narrow(report, scope, cwd) {
  const wanted = parseScope(scope, cwd);
  /** @type {NonNullable<Report['files']>} */
  const files = {};
  for (const [name, file] of Object.entries(report.files ?? {})) {
    const key = relativeName(name, cwd);
    if (!wanted.has(key)) continue;
    const ranges = wanted.get(key);
    files[name] = ranges
      ? { ...file, mutants: (file.mutants ?? []).filter((m) => inRanges(m, ranges)) }
      : file;
  }
  return { ...report, files };
}

/**
 * Narrows the file in place. A missing file is left missing (Stryker then
 * runs every mutant); one that won't parse is deleted for the same result,
 * since Stryker would stop on it instead.
 *
 * @param {string} file
 * @param {string[]} scope
 * @param {string} cwd
 * @param {(line: string) => void} [log]
 */
export function narrowFile(file, scope, cwd, log = console.log) {
  if (!existsSync(file)) {
    log(`No incremental file at ${file}: every mutant in scope will run.`);
    return;
  }
  const report = parseReport(readText(file));
  if (report === null) {
    rmSync(file);
    log(`Unreadable incremental file at ${file}, removed: every mutant in scope will run.`);
    return;
  }
  const narrowed = narrow(report, scope, cwd);
  writeFileSync(file, JSON.stringify(narrowed));
  const kept = Object.keys(narrowed.files ?? {}).length;
  const total = Object.keys(report.files ?? {}).length;
  log(`Kept ${kept} of ${total} file(s) from the incremental file for this run's scope.`);
}

/**
 * The command line: `<file> <scope>`. Returns the exit code.
 *
 * @param {string[]} args
 * @param {string} [cwd]
 */
export function main(args, cwd = appRoot()) {
  const [file, scope] = args;
  if (!file || scope === undefined) {
    console.error('Usage: narrow.mjs <incremental file> <comma-separated files or file:lines>');
    return 2;
  }
  narrowFile(file, scope.split(','), cwd);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
