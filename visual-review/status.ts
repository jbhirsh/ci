// What the `Visual changes` commit status says (ci#64): the rule that lets a
// PR whose screens changed merge when a person will see them, and stops one
// that merges itself. Pure: the facts come in, a state and a description go
// out. review.ts gathers the facts and posts the status.
//
// A changed screen blocks only a PR that merges itself:
//   - auto-merge off: a person merges, so a person sees the table: success;
//   - auto-merge on, on a bot's PR (Dependabot's, a `bot/*` branch), or
//     turned on by anyone but the owner: failure, until it's turned off;
//   - auto-merge turned on by the owner, on the owner's own PR, after this
//     result was first shown: the owner accepted it: success;
//   - turned on before that: failure, until it's turned off and on again.
// Visual review alone decides whether a screen changed. Whether the
// description has the shared shape is the description check's job
// (pr-template/check-body.mjs), never read here.
//
// Each result has a fingerprint, a short hash of what changed (the screens'
// names and their "after" pictures), and the time it was first shown. Both
// ride at the end of the description, `[vr:<hash>@<epoch>]`, because the
// status is the one record a PR can't edit: a later run reads them back
// (readMark) to keep an acceptance across new heads that show the same
// result, such as "Update branch". GitHub cuts a status description at 140
// characters, so every description here stays within that.

import { createHash } from 'node:crypto';

/** GitHub's limit on a commit status's description. */
export const MAX_DESCRIPTION = 140;
/** The status's name: the required check. */
export const CONTEXT = 'Visual changes';

/** What the comparison found for the head. */
export type Result =
  | { kind: 'compared'; screens: number; fingerprint: string }
  | { kind: 'no-shots' }
  | { kind: 'job-failed'; job: string }
  | { kind: 'waiting'; base: string }
  | { kind: 'no-reference'; base: string };

/** The PR, as the rule reads it. */
export type Pull = {
  /** its author's login */
  author: string;
  /** a bot's PR: its author is a bot, or its branch is `bot/*` */
  bot: boolean;
  /** who turned auto-merge on and when (epoch seconds), or null when it's off */
  autoMerge: { by: string; at: number } | null;
};

export type Status = {
  state: 'success' | 'failure' | 'pending';
  /** at most MAX_DESCRIPTION characters */
  description: string;
};

/**
 * The fingerprint of a result: the first 8 hex digits of a SHA-256 over
 * each changed screen's name and its "after" picture's hash (empty for a
 * screen that's gone), in name order. The same changes give the same
 * fingerprint, whatever order they come in.
 *
 * @param changes `after`: the picture's SHA-256 in hex, or '' for a removed
 *   screen
 */
export function fingerprint(changes: { name: string; after: string }[]) {
  const lines = changes
    .map(({ name, after }) => `${name}\t${after}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(lines).digest('hex').slice(0, 8);
}

/**
 * The mark a description ends with, for a result with a fingerprint.
 *
 * @param hash
 * @param shown epoch seconds
 */
export function mark(hash: string, shown: number) {
  return `[vr:${hash}@${Math.floor(shown)}]`;
}

/**
 * The fingerprint and first-shown time a description ends with, or null.
 * The description is read back from GitHub, so anything else is null.
 */
export function readMark(
  description: string | null | undefined,
): { hash: string; shown: number } | null {
  const m = /\[vr:([0-9a-f]{8})@(\d{1,12})\]$/.exec(description ?? '');
  return m ? { hash: m[1], shown: Number(m[2]) } : null;
}

/**
 * "1 screen" or "3 screens".
 */
const screens = (n: number) => `${n} screen${n === 1 ? '' : 's'}`;

/**
 * The status for a head.
 */
export function status({
  result,
  pull,
  owner,
  shown,
}: {
  result: Result;
  pull: Pull;
  /** the repository owner's login */
  owner: string;
  /**
   * when this result was first shown, epoch seconds: from the previous status with the same
   * fingerprint, else now
   */
  shown: number;
}): Status {
  switch (result.kind) {
    case 'waiting':
      return {
        state: 'pending',
        description: `Waiting for main's screenshots of ${result.base.slice(0, 7)}`,
      };
    case 'no-reference':
      return {
        state: 'failure',
        description: `Main has no screenshots of ${result.base.slice(0, 7)}: re-run that job`,
      };
    case 'job-failed':
      return {
        state: 'failure',
        description: clip(`No screenshots: ${result.job} failed`),
      };
    case 'no-shots':
    case 'compared':
      break;
  }
  if (result.kind === 'no-shots' || result.screens === 0) {
    return {
      state: 'success',
      description: result.kind === 'no-shots' ? 'No screens taken' : 'No visual changes',
    };
  }
  const n = screens(result.screens);
  const tag = ` ${mark(result.fingerprint, shown)}`;
  const am = pull.autoMerge;
  if (!am) return { state: 'success', description: `${n} changed: see the table${tag}` };
  const ownersOwn = !pull.bot && pull.author === owner && am.by === owner;
  if (!ownersOwn) {
    return {
      state: 'failure',
      description: `${n} changed, and this PR merges itself. Turn auto-merge off to look${tag}`,
    };
  }
  // A tie counts as before: the owner can't have seen a table posted in
  // the same second.
  if (am.at > shown) {
    return {
      state: 'success',
      description: `${n} changed, accepted by turning on auto-merge${tag}`,
    };
  }
  return {
    state: 'failure',
    description: `${n} changed since auto-merge was turned on: turn it off and on to accept${tag}`,
  };
}

/**
 * A description cut to fit, for one that holds text from elsewhere (a job's
 * name).
 */
function clip(text: string) {
  return text.length <= MAX_DESCRIPTION ? text : `${text.slice(0, MAX_DESCRIPTION - 1)}…`;
}

/**
 * Whether this result's first-shown time carries over from the previous
 * status: the same fingerprint keeps its time (and so any acceptance);
 * anything else is shown now.
 *
 * @param hash this result's fingerprint
 * @param previous the previous status's description
 * @param now epoch seconds
 */
export function shownAt(hash: string, previous: string | null | undefined, now: number) {
  const before = readMark(previous);
  return before && before.hash === hash ? before.shown : now;
}
