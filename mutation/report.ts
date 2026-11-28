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
// block of its lines (`src/a.ts:10-20`, what scope.ts prints for a file a PR
// edited). A mutant belongs to a block when it starts and ends inside it,
// Stryker's own rule for a line range; a file named whole anywhere is whole.
//
// The score is Stryker's (mutation-testing-metrics): detected (killed and
// timed out) over valid (detected, survived and with no coverage), leaving
// out compile and runtime errors and ignored mutants.

import { readFileSync } from 'node:fs';

export type Position = { line?: number; column?: number };

export type Location = { start?: Position; end?: Position };

export type Mutant = {
  id?: string;
  status?: string;
  location?: Location;
  coveredBy?: string[];
  killedBy?: string[];
  static?: boolean;
  [key: string]: unknown;
};

export type FileResult = { mutants?: Mutant[]; source?: unknown; [key: string]: unknown };

export type Test = { id: string; name: string; location?: Location; [key: string]: unknown };

export type TestFileResult = { tests?: Test[]; [key: string]: unknown };

export type Report = {
  files?: Record<string, FileResult>;
  testFiles?: Record<string, TestFileResult>;
  config?: Record<string, unknown>;
  [key: string]: unknown;
};

export type LineRange = [first: number, last: number];

export type Scope = Map<string, LineRange[] | null>;

/**
 * Whether `value` is a plain object (not null, not an array).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A report read from JSON text: null when it isn't JSON, or isn't an object
 * whose `files` and `testFiles` (when present) are objects.
 */
export function parseReport(text: string | null): Report | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of ['files', 'testFiles']) {
    if (value[key] !== undefined && !isRecord(value[key])) return null;
  }
  return value as Report;
}

/**
 * A file's text, or null when it can't be read.
 */
export function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * A path as a scope names it: relative to `cwd`, with forward slashes and no
 * leading `./`. A path outside `cwd` is left as it is.
 */
export function relativeName(file: string, cwd: string) {
  const name = file.replace(/\\/g, '/');
  const root = `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/`;
  return (name.startsWith(root) ? name.slice(root.length) : name).replace(/^\.\//, '');
}

/**
 * The scope's entries by file: null for a file named whole, else the line
 * ranges named for it. Blank entries and surrounding spaces are skipped.
 */
export function parseScope(entries: string[], cwd: string): Scope {
  const byFile: Scope = new Map();
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
 */
export function inRanges(mutant: Mutant, ranges: LineRange[]) {
  const start = mutant.location?.start?.line;
  const end = mutant.location?.end?.line;
  if (start === undefined || end === undefined) return false;
  return ranges.some(([first, last]) => start >= first && end <= last);
}

export type Counts = {
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  errors: number;
  ignored: number;
  score: number | null;
};

/**
 * Mutants by status, and Stryker's score over them (null with nothing valid).
 */
export function counts(mutants: Iterable<Mutant>): Counts {
  const count: Map<string, number> = new Map();
  for (const { status = 'unknown' } of mutants) count.set(status, (count.get(status) ?? 0) + 1);
  const n = (status: string) => count.get(status) ?? 0;
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
 */
export function allMutants(report: Report): Mutant[] {
  return Object.values(report.files ?? {}).flatMap((file) => file.mutants ?? []);
}
