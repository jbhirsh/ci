// What the sync (ci#109) would change in one app, worked out from files alone:
// which synced files differ from their source in this repo, by how many
// lines, the commit each gets, the PR that carries them, and, once a sync PR
// is open, what to do with it and what keeps it from merging. Pure functions
// over bytes and API answers, so sync.ts, the dry run and the self-test share
// them and the tests need no GitHub. manifest.ts says which files are synced;
// sync.ts says how a run uses this.
//
// A file differs when its bytes do (Buffer.equals), never "once parsed":
// the sync makes each app's copy byte-identical to its source. The line
// counts are only for people (the PR's table): a line diff over `\n`-split
// text, which a CRLF file counts as changed throughout.

import { createHash } from 'node:crypto';
import { newest } from '../lib/github.mjs';

/** @typedef {import('./manifest.ts').Resolved} Resolved */
/** @typedef {import('./manifest.ts').Companion} Companion */

/** The one branch every sync PR comes from, in every app. */
export const BRANCH = 'bot/sync-files';
/** This repository, which holds every synced file's source. */
export const CI_REPO = 'jbhirsh/ci';
/** The longest commit subject the apps' commit check allows. */
const MAX_SUBJECT = 72;
/**
 * The most cells the line diff fills (lines before × lines after, once the
 * common start and end are set aside). Past it the counts say every line in
 * between changed: an overcount, never a throw or a long wait.
 */
const MAX_CELLS = 4_000_000;

/**
 * One file the sync writes in an app.
 *
 * @typedef {object} Change
 * @property {string} path where the app holds it
 * @property {string} source where this repo holds its content
 * @property {string | undefined} why the app's variant's reason, when it has one
 * @property {'added' | 'updated'} status
 * @property {Buffer} bytes what the app's file becomes
 * @property {{ added: number, removed: number }} stat lines
 * @property {Companion[]} companions keys this file adds to the app's ci.json
 */

/**
 * Whether two files hold the same bytes.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
export const sameBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));

/**
 * The lines one text loses and gains on the way to another: a longest common
 * subsequence over `\n`-split lines, so equal texts lose and gain nothing and
 * any difference shows. Never throws.
 *
 * @param {string} before
 * @param {string} after
 * @returns {{ removed: string[], added: string[] }}
 */
export function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length * y.length > MAX_CELLS) return { removed: x, added: y };
  // lengths[i][j]: the longest common run of x[i..] and y[j..].
  const lengths = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lengths[i][j] =
        x[i] === y[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const added = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      removed.push(x[i++]);
    } else {
      added.push(y[j++]);
    }
  }
  removed.push(...x.slice(i));
  added.push(...y.slice(j));
  return { removed, added };
}

/**
 * How many lines a change adds and removes.
 *
 * @param {string} before
 * @param {string} after
 */
export function diffStat(before, after) {
  const { removed, added } = lineDiff(before, after);
  return { added: added.length, removed: removed.length };
}

/**
 * The id git (and GitHub's API) gives a file's content: a blob's SHA-1.
 *
 * @param {Uint8Array} bytes
 */
export function blobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * Whether a companion's key is already in the app's settings (it is then
 * never written: an app's own value stays).
 *
 * @param {Record<string, unknown>} settings
 * @param {string[]} key
 */
export function holds(settings, key) {
  /** @type {unknown} */
  let at = settings;
  for (const segment of key) {
    if (typeof at !== 'object' || at === null || !Object.hasOwn(at, segment)) return false;
    at = /** @type {Record<string, unknown>} */ (at)[segment];
  }
  return true;
}

/**
 * The files that differ in an app, in the manifest's order, each with what
 * it becomes. A companion comes with a file only when the sync adds that file
 * and the app's settings lack its key.
 *
 * @param {Resolved[]} files the app's synced files (manifest.ts's resolve)
 * @param {(source: string) => Buffer} readSource a file of this repo
 * @param {(file: string) => Buffer | null} readApp a file of the app, or null when absent
 * @param {Record<string, unknown>} settings the app's `.github/ci.json`
 * @returns {Change[]}
 */
export function changesFor(files, readSource, readApp, settings) {
  return files.flatMap((file) => {
    const bytes = readSource(file.source);
    const current = readApp(file.path);
    if (current !== null && sameBytes(current, bytes)) return [];
    const before = current === null ? '' : current.toString('utf8');
    const after = bytes.toString('utf8');
    return [
      {
        path: file.path,
        source: file.source,
        why: file.why,
        status: current === null ? 'added' : 'updated',
        bytes,
        stat: diffStat(before, after),
        companions:
          current === null ? file.companions.filter(({ key }) => !holds(settings, key)) : [],
      },
    ];
  });
}

/**
 * A link to a file of this repo at a commit.
 *
 * @param {string} sha
 * @param {string} file
 */
const blob = (sha, file) => `https://github.com/${CI_REPO}/blob/${sha}/${file}`;

/**
 * The commit a change gets: one per file, its subject naming the file (by
 * its base name when the path would make it too long).
 *
 * @param {Change} change
 * @param {string} ciSha
 * @returns {{ subject: string, body: string }}
 */
export function commitMessage(change, ciSha) {
  const full = `Sync ${change.path} with ${CI_REPO}`;
  const subject =
    full.length <= MAX_SUBJECT ? full : `Sync ${change.path.split('/').at(-1)} with ${CI_REPO}`;
  const lines = [
    `${CI_REPO} holds the copy every app keeps in step (sync/manifest.json); this ` +
      `${change.status === 'added' ? 'adds it' : "brings this repo's copy to it"}, from ` +
      `${change.source} at ${ciSha.slice(0, 7)}.`,
  ];
  if (change.why) lines.push('', `This repo's copy is a variant: ${change.why}`);
  if (change.companions.length > 0) {
    lines.push(
      '',
      `.github/ci.json gains what the file needs there: ${change.companions.map(({ key }) => key.join('.')).join(', ')}.`,
    );
  }
  return { subject: subject.slice(0, MAX_SUBJECT), body: lines.join('\n') };
}

/**
 * The mark every sync PR's description starts with: only a PR carrying it is
 * the sync's to rebuild (anyone can push a branch named bot/sync-files).
 */
export const MARKER = '<!-- sync-files -->';

/** Every sync PR's title. */
export const PR_TITLE = `Sync shared files with ${CI_REPO}`;

/** The characters a table cell's code may not hold as themselves, as entities. */
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '\\': '&#92;' };

/**
 * A path as code in a table cell, on one line. A Markdown code span can't
 * hold every character: GitHub splits a table row at any `|` not escaped as
 * `\|`, so a backslash before one changes where the cell ends. An HTML
 * <code> with each special character as an entity holds any text.
 *
 * @param {string} text
 */
export const codeCell = (text) =>
  `<code>${text
    .replace(/\s+/g, ' ')
    .replace(/[&<>|\\]/g, (char) => ENTITIES[/** @type {keyof typeof ENTITIES} */ (char)])}</code>`;

/**
 * The sync PR's description: what it changes, where each file comes from and
 * why a variant differs, in the shared template's headings.
 *
 * @param {{ ciSha: string, runUrl?: string, changes: Change[] }} input
 */
export function prBody({ ciSha, runUrl, changes }) {
  const variants = changes.filter((change) => change.why);
  const companions = changes.flatMap((change) =>
    change.companions.map((companion) => ({ file: change.path, key: companion.key })),
  );
  return [
    MARKER,
    '## Goal',
    '',
    `- Brings this repo's copies of the files [${CI_REPO}](https://github.com/${CI_REPO}) keeps in ` +
      `step ([\`sync/manifest.json\`](${blob(ciSha, 'sync/manifest.json')})) to ` +
      `[${ciSha.slice(0, 7)}](https://github.com/${CI_REPO}/commit/${ciSha}).`,
    `- Opened by ${CI_REPO}'s sync${runUrl ? ` ([run](${runUrl}))` : ''}; it merges itself once the ` +
      'required checks pass.',
    `- Change a synced file in ${CI_REPO}, never here: the next sync reverts a hand edit.`,
    '',
    '## Changes',
    '',
    '| File | Change | Source | Lines |',
    '|---|---|---|---|',
    ...changes.map(
      (change) =>
        `| ${codeCell(change.path)} | ${change.status} ` +
        `| [${codeCell(change.source)}](${blob(ciSha, change.source)}) ` +
        `| +${change.stat.added} −${change.stat.removed} |`,
    ),
    ...(variants.length > 0
      ? [
          '',
          ...variants.map((change) => `- \`${change.path}\` is this app's variant: ${change.why}`),
        ]
      : []),
    ...(companions.length > 0
      ? [
          '',
          ...companions.map(
            ({ file, key }) =>
              `- \`.github/ci.json\` gains \`${key.join('.')}\`, which \`${file}\` needs (an existing key is never overwritten).`,
          ),
        ]
      : []),
    '',
    '## Checklist',
    '',
    `- [x] Only files ${CI_REPO} keeps in step, one commit each, byte-identical to their source.`,
    '- Nothing to do: a review thread or a failing check on this PR turns the next sync run red, naming it.',
  ].join('\n');
}

/**
 * The dry run's report: the PR the sync would open, or that there is none.
 *
 * @param {string} app
 * @param {Change[]} changes
 * @param {string} ciSha
 * @returns {string[]}
 */
export function report(app, changes, ciSha) {
  if (changes.length === 0) return [`${app}: every synced file matches ${CI_REPO}; no PR.`];
  return [
    `${app}: would open or update one PR from ${BRANCH}, "${PR_TITLE}", with ${changes.length} commit(s):`,
    ...changes.map((change) => {
      const { subject } = commitMessage(change, ciSha);
      const notes = [
        change.status,
        `+${change.stat.added} −${change.stat.removed}`,
        ...(change.why ? ['variant'] : []),
        ...change.companions.map(({ key }) => `ci.json gains ${key.join('.')}`),
      ];
      return `  - ${subject} (${notes.join(', ')})`;
    }),
  ];
}

/**
 * What to do with the app's sync PR this run.
 *
 *   - `none`: nothing differs and no PR is open;
 *   - `close`: nothing differs any more, so the open PR has nothing to sync;
 *   - `build`: (re)build the branch from the app's head and open or update the PR;
 *   - `keep`: the open PR already holds exactly these bytes, and its branch
 *     can still merge (only the base moved), so it isn't rebuilt: a rebuild
 *     would rerun every check, and sift's take an hour.
 *
 * A branch GitHub calls `behind` (an app that requires an up-to-date branch)
 * or `dirty` (a conflict with the app's main) is rebuilt from the app's head,
 * which ends both: a conflict can't outlive a rebuild, so it is never
 * reported.
 *
 * @param {{ changes: number, open: boolean, matches: boolean, mergeable: string | null }} state
 *   `matches`: the open PR's branch changes exactly the files that differ,
 *   to exactly these bytes; `mergeable`: GitHub's `mergeable_state` for it
 * @returns {'none' | 'close' | 'build' | 'keep'}
 */
export function decide({ changes, open, matches, mergeable }) {
  if (changes === 0) return open ? 'close' : 'none';
  if (!open || !matches) return 'build';
  return mergeable === 'behind' || mergeable === 'dirty' ? 'build' : 'keep';
}

/** The conclusions of a check run that keep a required check from passing. */
const FAILED = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'stale',
]);

/**
 * @typedef {object} Thread
 * @property {boolean} isResolved
 * @property {string | null} path
 * @property {number | null} line
 * @property {string} [url] its first comment
 */

/** The conclusions of a check run that pass a required check. */
const PASSED = new Set(['success', 'skipped', 'neutral']);

/**
 * What keeps an open sync PR from merging, in plain words, for the run to
 * fail on: each unresolved review thread, and each required check that has
 * failed on its head. A check still running, or one not yet started, is no
 * cause: it may pass, and its result is read again at the next run.
 *
 * GitHub can also hold a PR `blocked` for a rule that is neither: code
 * scanning or code quality results, an approval it asks for. When it says
 * blocked, every required check passed and no thread is open, that is the
 * cause, named with the types of the rules on main, so a PR is never stuck
 * in silence.
 *
 * @param {{
 *   threads: Thread[],
 *   required: string[],
 *   checkRuns: { id: number, name: string, status: string, conclusion: string | null }[],
 *   statuses: { context: string, state: string }[],
 *   mergeable?: string | null,
 *   ruleTypes?: string[],
 * }} state the head's check runs and the combined status's statuses;
 *   `mergeable`, GitHub's mergeable_state; `ruleTypes`, main's rules' types
 * @returns {string[]}
 */
export function blockers({
  threads,
  required,
  checkRuns,
  statuses,
  mergeable = null,
  ruleTypes = [],
}) {
  const causes = threads
    .filter((thread) => !thread.isResolved)
    .map(
      (thread) =>
        `unresolved review thread on ${thread.path ?? 'the PR'}${thread.line ? `:${thread.line}` : ''}` +
        (thread.url ? ` (${thread.url})` : ''),
    );
  let allPassed = true;
  for (const context of required) {
    const run = newest(checkRuns.filter((r) => r.name === context));
    const status = statuses.find((s) => s.context === context);
    if (
      (run?.status === 'completed' && FAILED.has(run.conclusion ?? '')) ||
      status?.state === 'failure' ||
      status?.state === 'error'
    ) {
      causes.push(`required check "${context}" failed`);
    }
    const passed =
      (run?.status === 'completed' && PASSED.has(run.conclusion ?? '')) ||
      status?.state === 'success';
    if (!passed) allPassed = false;
  }
  if (mergeable === 'blocked' && causes.length === 0 && allPassed) {
    causes.push(
      'GitHub says it is blocked with every required check passed and no review thread open: ' +
        `look at its merge box; main's rules are ${ruleTypes.length > 0 ? ruleTypes.join(', ') : 'unknown'}`,
    );
  }
  return causes;
}
