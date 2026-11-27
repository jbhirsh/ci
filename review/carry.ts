// Claude Review's carry-over: on a later push to a PR, which changed files
// the review needn't read again, because an earlier review of the PR read
// them and their part of the PR's diff is the same now.
//
// A file's part of the diff is identified by git's patch-id of
// `git diff -M origin/<base>...HEAD -- <file>` (`git patch-id --verbatim`):
// it ignores line numbers and blob hashes, so it survives a rebase, a
// squash, a force-push and the base moving, none of which a diff from the
// last reviewed commit survives (the old head is often not an ancestor).
// Verbatim, not --stable, which strips whitespace: an indentation-only
// edit to YAML or Python must be read again. Context lines count too, so
// a base edit next to the PR's hunk means a re-read. A
// file whose patch-id differs, or that no completed review read, is read in
// full; that is the guarantee coverage.ts keeps. A file the PR deletes is
// left out of the plan: a listing of the PR's diff covers it in every pass
// (coverage.ts), so there is nothing to carry, and the prompt's "read in
// full" would be untrue of it. The plan step hands them to coverage.ts
// (output `removed`); if it fails, none are named, and every deleted file
// must be read like any other.
//
// The record of what was read is a small JSON file kept in an Actions cache,
// one entry per review, keyed by PR number (action.yml): restore takes the
// newest. Not in the summary comment: Claude rewrites that comment's body
// each pass, and it is posted under the Claude app's token, which the job's
// own token may not be able to edit. A cache costs no API call and nothing
// in the PR's thread, and only a run of the PR's own workflow can write to
// its scope (someone who can push to the PR, who could as well edit the
// stub to skip review). Still, the record is untrusted input: anything that
// isn't exactly the shape below is thrown away whole, and it is only ever
// compared with what git says, never run.
//
// The record is void (everything is read) when any of these changed since:
// prompt.md, followup.md, system.md (the reviewer's system prompt), the
// shared Claude rules the prompts point at
// (claude-rules/CLAUDE.md, read from this checkout of jbhirsh/ci, so
// renaming it fails the review until this follows), the
// app's review settings (its advisor and skipped bots among them) and
// guide, the app's CLAUDE.md on the base branch,
// or the base branch's name. Its `context` is a hash of them all.
//
// CLI, run from the app's checkout:
//   `node carry.ts plan`  reads RECORD (the restored record, if any) and
//     writes PLAN: the files to read with their patch-ids, and the ones
//     carried over with the commit each was read at. Step outputs
//     `carried`, those files, and `removed`, the files the PR deletes, one
//     per line (coverage.ts's CARRIED and REMOVED); the job summary names
//     the carried ones and counts the deleted.
//   `node carry.ts save`  writes RECORD from PLAN, once the review has read
//     every file the plan left to it (action.yml runs it only then).
// Both take RECORD and PLAN (the two files' paths); plan also BASE_REF
// (default `main`) and CONFIG_REF (where settings are read, as render.ts);
// save HEAD_SHA (the PR's head commit).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setOutput, summary } from '../lib/actions.ts';
import { appRoot } from '../lib/app.ts';
import { readAppFile } from './config.ts';
import { filesToRead } from './coverage.ts';
import { reviewSettings } from './settings.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const RECORD_VERSION = 1;
/** More than any PR will have; a record past it is not one we wrote. */
const MAX_FILES = 20000;
const HEX = /^[0-9a-f]+$/;

export type Entry = {
  /** the file's patch-id when it was read */
  patchId: string;
  /** the PR's head commit when it was read */
  sha: string;
};
export type ReviewRecord = {
  version: number;
  /** see contextHash */
  context: string;
  files: Record<string, Entry>;
};
export type Plan = {
  context: string;
  /** every file the review must cover */
  patchIds: Record<string, string | null>;
  /** the ones it needn't read again */
  carried: Record<string, Entry>;
};

function git(root: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', root, '--literal-pathspecs', ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * The PR's changed files, as action.yml lists them for coverage.ts, or with
 * `deleted` only those it deletes (renames found, so a moved file isn't one).
 */
export function changedFiles({
  root,
  base,
  deleted = false,
}: {
  root: string;
  base: string;
  deleted?: boolean;
}): string[] {
  const filter = deleted ? ['--diff-filter=D'] : [];
  return git(root, ['diff', '--name-only', '-z', '-M', ...filter, `origin/${base}...HEAD`])
    .split('\0')
    .filter(Boolean);
}

/**
 * The patch-id of one file's part of the PR's diff, or null when git gives
 * none (no diff at all): such a file is never carried over.
 */
export function patchId(
  file: string,
  { root, base }: { root: string; base: string },
): string | null {
  const diff = git(root, ['diff', '-M', `origin/${base}...HEAD`, '--', file]);
  if (!diff) return null;
  const id = git(root, ['patch-id', '--verbatim'], diff).split(' ')[0];
  return id && HEX.test(id) ? id : null;
}

/**
 * A hash of everything that decides what a review looks for; a record made
 * under another is void.
 */
export function contextHash(parts: {
  prompt: string;
  followup: string;
  system: string;
  rules: string;
  settings: unknown;
  claudeMd: string | null;
  base: string;
}): string {
  const { prompt, followup, system, rules, settings, claudeMd, base } = parts;
  return createHash('sha256')
    .update(
      JSON.stringify([RECORD_VERSION, prompt, followup, system, rules, settings, claudeMd, base]),
    )
    .digest('hex');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A record read back, or null when it is missing, unreadable or not exactly
 * the shape this module writes: then everything is read.
 */
export function parseRecord(text: string | null): ReviewRecord | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value) || value.version !== RECORD_VERSION) return null;
  const { context, files } = value;
  if (typeof context !== 'string' || context.length !== 64 || !HEX.test(context)) return null;
  if (!isObject(files)) return null;
  const entries = Object.entries(files);
  if (entries.length > MAX_FILES) return null;
  const out: Record<string, Entry> = {};
  for (const [file, entry] of entries) {
    if (!file || file.includes('\0') || !isObject(entry)) return null;
    const { patchId: id, sha } = entry;
    if (typeof id !== 'string' || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(id)) return null;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) return null;
    out[file] = { patchId: id, sha };
  }
  return { version: RECORD_VERSION, context, files: out };
}

/**
 * Which files may be carried over: those whose patch-id is the one a
 * completed review read, under the same context.
 */
export function plan(
  patchIds: Record<string, string | null>,
  record: ReviewRecord | null,
  context: string,
): Plan {
  const carried: Record<string, Entry> = {};
  if (record && record.context === context) {
    for (const [file, id] of Object.entries(patchIds)) {
      const entry = Object.hasOwn(record.files, file) ? record.files[file] : undefined;
      if (id !== null && entry?.patchId === id) carried[file] = entry;
    }
  }
  return { context, patchIds, carried };
}

/**
 * The record a review that read every file its plan left it makes: each
 * file it read, at this head, and each it carried, as it was.
 */
export function nextRecord(done: Plan, head: string): ReviewRecord {
  const files: Record<string, Entry> = {};
  for (const [file, id] of Object.entries(done.patchIds)) {
    if (id === null) continue;
    files[file] = Object.hasOwn(done.carried, file)
      ? done.carried[file]
      : { patchId: id, sha: head };
  }
  return { version: RECORD_VERSION, context: done.context, files };
}

/**
 * A plan file read back (it is written by this job, but checked as a record
 * is): null when it is missing or malformed, and then nothing is carried.
 */
export function readPlan(file: string | undefined): Plan | null {
  if (!file) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(value) || !isObject(value.patchIds) || !isObject(value.carried)) return null;
  const record = parseRecord(
    JSON.stringify({ version: RECORD_VERSION, context: value.context, files: value.carried }),
  );
  const ids = Object.entries(value.patchIds);
  if (!record || !ids.every(([, id]) => id === null || (typeof id === 'string' && HEX.test(id))))
    return null;
  return {
    context: record.context,
    patchIds: Object.fromEntries(ids) as Record<string, string | null>,
    carried: record.files,
  };
}

function readOrNull(file: string | undefined): string | null {
  if (!file) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The context of this run: the prompts, the shared rules, the app's settings and CLAUDE.md
 * as the base branch holds them, and the base's name.
 */
export function currentContext({
  root,
  ref,
  base,
}: {
  root: string;
  ref?: string;
  base: string;
}): string {
  return contextHash({
    prompt: readFileSync(path.join(HERE, 'prompt.md'), 'utf8'),
    followup: readFileSync(path.join(HERE, 'followup.md'), 'utf8'),
    system: readFileSync(path.join(HERE, 'system.md'), 'utf8'),
    rules: readFileSync(path.join(HERE, '..', 'claude-rules', 'CLAUDE.md'), 'utf8'),
    settings: reviewSettings({ root, ref }),
    claudeMd: readAppFile('CLAUDE.md', { root, ref }),
    base,
  });
}

/**
 * The job summary's note on what was carried over, and how many deleted
 * files a listing covers.
 */
export function summaryNote(p: Plan, deleted = 0): string {
  const carried = Object.entries(p.carried);
  const total = Object.keys(p.patchIds).length;
  const gone = deleted > 0 ? ` (and ${deleted} deleted, which a listing of the diff covers)` : '';
  if (carried.length === 0) return `Claude Review: all ${total} changed file(s) to be read${gone}.`;
  const lines = carried.map(([file, e]) => `- \`${file}\`, read at ${e.sha.slice(0, 7)}`);
  return [
    `Claude Review: ${carried.length} of ${total} changed file(s) carried over from earlier reviews (same patch-id), ${total - carried.length} to read${gone}:`,
    '',
    ...lines,
  ].join('\n');
}

/**
 * The CLI, minus process handling.
 *
 * @returns the job summary's note, the files carried over and the files the PR
 *   deletes (for coverage.ts's CARRIED and REMOVED)
 */
export function main(
  command: string | undefined,
  env: Record<string, string | undefined>,
  root: string,
): { note: string; carried: string[]; removed: string[] } {
  const recordFile = env.RECORD;
  const planFile = env.PLAN;
  if (!recordFile || !planFile) throw new Error('RECORD and PLAN must be set');
  if (command === 'plan') {
    const base = env.BASE_REF || 'main';
    const ref = env.CONFIG_REF || undefined;
    const { skip } = reviewSettings({ root, ref });
    const removed = filesToRead(changedFiles({ root, base, deleted: true }), skip);
    const gone = new Set(removed);
    const files = filesToRead(changedFiles({ root, base }), skip).filter((f) => !gone.has(f));
    const ids = Object.fromEntries(files.map((f) => [f, patchId(f, { root, base })]));
    const context = currentContext({ root, ref, base });
    const p = plan(ids, parseRecord(readOrNull(recordFile)), context);
    mkdirSync(path.dirname(planFile), { recursive: true });
    writeFileSync(planFile, JSON.stringify(p));
    return { note: summaryNote(p, removed.length), carried: Object.keys(p.carried), removed };
  }
  if (command === 'save') {
    const p = readPlan(planFile);
    const head = env.HEAD_SHA ?? '';
    if (!p || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(head)) {
      throw new Error('no plan to save, or HEAD_SHA is not a commit');
    }
    mkdirSync(path.dirname(recordFile), { recursive: true });
    writeFileSync(recordFile, JSON.stringify(nextRecord(p, head)));
    return { note: '', carried: [], removed: [] };
  }
  throw new Error('usage: carry.ts plan|save');
}

/* c8 ignore start: the CLI's lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { note, carried, removed } = main(process.argv[2], process.env, appRoot());
  if (note) summary(note);
  if (process.argv[2] === 'plan') {
    setOutput('carried', carried.join('\n'));
    setOutput('removed', removed.join('\n'));
  }
}
/* c8 ignore stop */
