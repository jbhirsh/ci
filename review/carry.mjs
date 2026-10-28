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
// full; that is the guarantee coverage.mjs keeps.
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
// prompt.md, followup.md, the app's review settings and guide, the app's
// CLAUDE.md on the base branch, or the base branch's name. Its `context` is
// a hash of them all.
//
// CLI, run from the app's checkout:
//   `node carry.mjs plan`  reads RECORD (the restored record, if any) and
//     writes PLAN: the files to read with their patch-ids, and the ones
//     carried over with the commit each was read at. Step output `carried`:
//     those files, one per line (coverage.mjs's CARRIED); they also go in
//     the job summary.
//   `node carry.mjs save`  writes RECORD from PLAN, once the review has read
//     every file the plan left to it (action.yml runs it only then).
// Both take RECORD and PLAN (the two files' paths); plan also BASE_REF
// (default `main`) and CONFIG_REF (where settings are read, as render.mjs);
// save HEAD_SHA (the PR's head commit).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setOutput, summary } from '../lib/actions.mjs';
import { appRoot } from '../lib/app.mjs';
import { readAppFile } from './config.mjs';
import { filesToRead } from './coverage.mjs';
import { reviewSettings } from './settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const RECORD_VERSION = 1;
/** More than any PR will have; a record past it is not one we wrote. */
const MAX_FILES = 20000;
const HEX = /^[0-9a-f]+$/;

/**
 * @typedef {object} Entry
 * @property {string} patchId the file's patch-id when it was read
 * @property {string} sha the PR's head commit when it was read
 */
/**
 * @typedef {object} ReviewRecord
 * @property {number} version
 * @property {string} context see contextHash
 * @property {Record<string, Entry>} files
 */
/**
 * @typedef {object} Plan
 * @property {string} context
 * @property {Record<string, string | null>} patchIds every file the review must cover
 * @property {Record<string, Entry>} carried the ones it needn't read again
 */

/**
 * @param {string} root
 * @param {string[]} args
 * @param {string} [input]
 * @returns {string}
 */
function git(root, args, input) {
  return execFileSync('git', ['-C', root, '--literal-pathspecs', ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * The PR's changed files, as action.yml lists them for coverage.mjs.
 *
 * @param {{ root: string, base: string }} where
 * @returns {string[]}
 */
export function changedFiles({ root, base }) {
  return git(root, ['diff', '--name-only', '-z', '-M', `origin/${base}...HEAD`])
    .split('\0')
    .filter(Boolean);
}

/**
 * The patch-id of one file's part of the PR's diff, or null when git gives
 * none (no diff at all): such a file is never carried over.
 *
 * @param {string} file
 * @param {{ root: string, base: string }} where
 * @returns {string | null}
 */
export function patchId(file, { root, base }) {
  const diff = git(root, ['diff', '-M', `origin/${base}...HEAD`, '--', file]);
  if (!diff) return null;
  const id = git(root, ['patch-id', '--verbatim'], diff).split(' ')[0];
  return id && HEX.test(id) ? id : null;
}

/**
 * A hash of everything that decides what a review looks for; a record made
 * under another is void.
 *
 * @param {{ prompt: string, followup: string, settings: unknown, claudeMd: string | null, base: string }} parts
 * @returns {string}
 */
export function contextHash(parts) {
  const { prompt, followup, settings, claudeMd, base } = parts;
  return createHash('sha256')
    .update(JSON.stringify([RECORD_VERSION, prompt, followup, settings, claudeMd, base]))
    .digest('hex');
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A record read back, or null when it is missing, unreadable or not exactly
 * the shape this module writes: then everything is read.
 *
 * @param {string | null} text
 * @returns {ReviewRecord | null}
 */
export function parseRecord(text) {
  if (text === null) return null;
  /** @type {unknown} */
  let value;
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
  /** @type {Record<string, Entry>} */
  const out = {};
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
 *
 * @param {Record<string, string | null>} patchIds
 * @param {ReviewRecord | null} record
 * @param {string} context
 * @returns {Plan}
 */
export function plan(patchIds, record, context) {
  /** @type {Record<string, Entry>} */
  const carried = {};
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
 *
 * @param {Plan} done
 * @param {string} head
 * @returns {ReviewRecord}
 */
export function nextRecord(done, head) {
  /** @type {Record<string, Entry>} */
  const files = {};
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
 *
 * @param {string | undefined} file
 * @returns {Plan | null}
 */
export function readPlan(file) {
  if (!file) return null;
  /** @type {unknown} */
  let value;
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
    patchIds: /** @type {Record<string, string | null>} */ (Object.fromEntries(ids)),
    carried: record.files,
  };
}

/**
 * @param {string | undefined} file
 * @returns {string | null}
 */
function readOrNull(file) {
  if (!file) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The context of this run: the prompts, the app's settings and CLAUDE.md
 * as the base branch holds them, and the base's name.
 *
 * @param {{ root: string, ref?: string, base: string }} where
 * @returns {string}
 */
export function currentContext({ root, ref, base }) {
  return contextHash({
    prompt: readFileSync(path.join(HERE, 'prompt.md'), 'utf8'),
    followup: readFileSync(path.join(HERE, 'followup.md'), 'utf8'),
    settings: reviewSettings({ root, ref }),
    claudeMd: readAppFile('CLAUDE.md', { root, ref }),
    base,
  });
}

/**
 * The job summary's note on what was carried over.
 *
 * @param {Plan} p
 * @returns {string}
 */
export function summaryNote(p) {
  const carried = Object.entries(p.carried);
  const total = Object.keys(p.patchIds).length;
  if (carried.length === 0) return `Claude Review: all ${total} changed file(s) to be read.`;
  const lines = carried.map(([file, e]) => `- \`${file}\`, read at ${e.sha.slice(0, 7)}`);
  return [
    `Claude Review: ${carried.length} of ${total} changed file(s) carried over from earlier reviews (same patch-id), ${total - carried.length} to read:`,
    '',
    ...lines,
  ].join('\n');
}

/**
 * The CLI, minus process handling.
 *
 * @param {string | undefined} command
 * @param {Record<string, string | undefined>} env
 * @param {string} root
 * @returns {{ note: string, carried: string[] }} the job summary's note, and
 *   the files carried over (for coverage.mjs's CARRIED)
 */
export function main(command, env, root) {
  const recordFile = env.RECORD;
  const planFile = env.PLAN;
  if (!recordFile || !planFile) throw new Error('RECORD and PLAN must be set');
  if (command === 'plan') {
    const base = env.BASE_REF || 'main';
    const ref = env.CONFIG_REF || undefined;
    const { skip } = reviewSettings({ root, ref });
    const files = filesToRead(changedFiles({ root, base }), skip);
    const ids = Object.fromEntries(files.map((f) => [f, patchId(f, { root, base })]));
    const context = currentContext({ root, ref, base });
    const p = plan(ids, parseRecord(readOrNull(recordFile)), context);
    mkdirSync(path.dirname(planFile), { recursive: true });
    writeFileSync(planFile, JSON.stringify(p));
    return { note: summaryNote(p), carried: Object.keys(p.carried) };
  }
  if (command === 'save') {
    const p = readPlan(planFile);
    const head = env.HEAD_SHA ?? '';
    if (!p || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(head)) {
      throw new Error('no plan to save, or HEAD_SHA is not a commit');
    }
    mkdirSync(path.dirname(recordFile), { recursive: true });
    writeFileSync(recordFile, JSON.stringify(nextRecord(p, head)));
    return { note: '', carried: [] };
  }
  throw new Error('usage: carry.mjs plan|save');
}

/* c8 ignore start: the CLI's lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { note, carried } = main(process.argv[2], process.env, appRoot());
  if (note) summary(note);
  if (process.argv[2] === 'plan') setOutput('carried', carried.join('\n'));
}
/* c8 ignore stop */
