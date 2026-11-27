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
// only the mutants lying wholly within them (report.ts). Test files are
// kept: Stryker needs them to tell which tests changed.
//
// A kept mutant's lines are the earlier run's, and the ranges this one's, so
// a line range keeps a mutant only where the file reads the same, from its
// first line to the mutant's last, in the earlier run's copy (the report's
// `source`) as it does now: Stryker places an old result by diffing the two
// copies, and that unchanged start stays where it was unless the file now
// repeats it further down, which lets the diff slide an insertion up above
// it, so a mutant whose start repeats is dropped too. Lines that merely read
// the same at the same numbers aren't enough, as code the PR inserted can
// repeat them while the old code moves down. Otherwise code
// the PR moved into a range's line numbers is kept: Stryker carries the old
// result to the code's new place, out of the range, and the PR is scored on
// code it didn't touch (a doc comment added above a function once scored a
// PR on the function's unchanged survivor, BoardGames#343). A dropped mutant
// is re-tested if it's in range, which costs time but never a wrong score; a
// file named whole keeps every mutant, as Stryker re-places them itself.
//
// Usage: node narrow.ts <incremental file> <comma-separated scope>

import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appRoot } from '../lib/app.mjs';
import { inRanges, parseReport, parseScope, readText, relativeName } from './report.ts';
import type { Report } from './report.ts';

/**
 * Which end lines (1-based) stay where they were when Stryker diffs the
 * earlier copy of a file with the file now: those the file reads the same
 * up to in both, whatever the line endings, provided the file now doesn't
 * repeat that start further down.
 */
export function staysPut(before: string, now: string): (end: number) => boolean {
  const old = before.split(/\r?\n/);
  const text = now.replace(/\r\n/g, '\n');
  const current = text.split('\n');
  let unchanged = 0;
  while (
    unchanged < old.length &&
    unchanged < current.length &&
    old[unchanged] === current[unchanged]
  ) {
    unchanged++;
  }
  return (end) =>
    end >= 1 && end <= unchanged && text.indexOf(old.slice(0, end).join('\n'), 1) === -1;
}

/**
 * The report with only the files, and lines, named in `scope` left in it. A
 * line range keeps a mutant only where it stays put between the report's
 * source and `read`'s text (null when the file can't be read).
 *
 * @param report
 * @param scope
 * @param cwd
 * @param read a file's text now, by its scope name
 */
export function narrow(
  report: Report,
  scope: string[],
  cwd: string,
  read: (file: string) => string | null = (file) => readText(path.resolve(cwd, file)),
): Report {
  const wanted = parseScope(scope, cwd);
  const files: NonNullable<Report['files']> = {};
  for (const [name, file] of Object.entries(report.files ?? {})) {
    const key = relativeName(name, cwd);
    if (!wanted.has(key)) continue;
    const ranges = wanted.get(key);
    if (!ranges) {
      files[name] = file;
      continue;
    }
    const before = typeof file.source === 'string' ? file.source : null;
    const now = before === null ? null : read(key);
    if (before === null || now === null) {
      files[name] = { ...file, mutants: [] };
      continue;
    }
    const stays = staysPut(before, now);
    files[name] = {
      ...file,
      mutants: (file.mutants ?? []).filter(
        (m) => inRanges(m, ranges) && stays(Number(m.location?.end?.line)),
      ),
    };
  }
  return { ...report, files };
}

/**
 * Narrows the file in place. A missing file is left missing (Stryker then
 * runs every mutant); one that won't parse is deleted for the same result,
 * since Stryker would stop on it instead.
 */
export function narrowFile(
  file: string,
  scope: string[],
  cwd: string,
  log: (line: string) => void = console.log,
) {
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
 */
export function main(args: string[], cwd: string = appRoot()) {
  const [file, scope] = args;
  if (!file || scope === undefined) {
    console.error('Usage: narrow.ts <incremental file> <comma-separated files or file:lines>');
    return 2;
  }
  narrowFile(file, scope.split(','), cwd);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
