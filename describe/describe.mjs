// The one writer of the bots' sections in a PR's or an issue's description
// (ci#64): visual-review's table today, the PR GIFs once they move here.
// Each bot posts its pictures in an upload comment with BOT_PR_TOKEN, the
// only kind of token GitHub lets attach files, and ends that comment with
// its finished section. This copies each bot's newest section into the
// description, between `<!-- describe:<bot> -->` markers, with the Actions
// token: GitHub starts no workflow for that token's edits, so PR visuals and
// the like don't run again. Runs share one concurrency group per PR
// (action.yml), so edits take turns.
//
// An upload comment counts only if:
//   - BOT_PR_TOKEN's own account wrote it (no one else can post as it);
//   - it starts with `<!-- describe-upload:<bot>:<sha> -->`, a bot name
//     and the commit it's for;
//   - its section, after `<!-- describe-section -->`, links only GitHub
//     attachments (`https://github.com/user-attachments/assets/…`).
// Of a bot's comments, the newest wins. A bot posts nothing for a head the
// PR has moved on from (visual-review checks before it uploads), and its
// runs for one PR take turns, so the newest is the latest head's; ranking
// by the comment rather than by the PR's commits keeps working after a
// force-push drops a commit. Every section is
// rebuilt on each run, not only the caller's, so a run GitHub drops from
// the queue loses nothing: the next one writes it all. A bot with no upload
// comment keeps whatever it already has, such as GIFs attached by hand.
// Earlier upload comments are hidden as outdated, never deleted, so no
// attachment depends on what GitHub does with a deleted comment.
//
// The description is read again just before it's written, and the edit is
// worked out afresh if it changed meanwhile, so a person's edit is lost
// only if it lands in the same moment. GitHub has no conditional edit.

import { blocksFor } from '../lib/blocks.mjs';

/** The first line of an upload comment, for a bot and a commit. */
export const uploadMarker = (/** @type {string} */ bot, /** @type {string} */ sha) =>
  `<!-- describe-upload:${bot}:${sha} -->`;
/** Where the finished section starts in an upload comment. */
export const SECTION = '<!-- describe-section -->';
/** The sections' markers in the description. */
export const blocks = blocksFor('describe', { named: 'a bot named', where: 'a description' });
/** How many times a write is worked out again when the description moved. */
const ATTEMPTS = 3;

const UPLOAD = /^<!-- describe-upload:([a-z][a-z0-9-]{0,39}):([0-9a-f]{40}) -->/;
const ATTACHMENT = /^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]{8,64}$/;

/**
 * A comment, as far as this reads it.
 *
 * @typedef {{ id: number, node_id: string, body?: string | null,
 *   user?: { login?: string } | null }} Comment
 */

/**
 * An upload comment that counts.
 *
 * @typedef {{ id: number, nodeId: string, bot: string, sha: string,
 *   section: string }} Upload
 */

/**
 * Every link or picture source in a section.
 *
 * @param {string} text
 */
function urlsIn(text) {
  return [
    ...[...text.matchAll(/\]\(([^)\s]*)/g)].map((m) => m[1]),
    ...[...text.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]),
    ...[...text.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]),
  ];
}

/**
 * The upload a comment is, or null when it doesn't count.
 *
 * @param {Comment} comment
 * @param {string} login BOT_PR_TOKEN's account
 * @returns {Upload | null}
 */
export function parseUpload(comment, login) {
  if (comment.user?.login !== login) return null;
  const body = comment.body ?? '';
  const m = UPLOAD.exec(body);
  if (!m) return null;
  const at = body.indexOf(SECTION);
  if (at === -1) return null;
  const section = body.slice(at + SECTION.length).trim();
  // A marker inside would cut the block short or start another.
  if (section.includes('<!-- describe') || section.includes('<!-- /describe')) return null;
  if (!urlsIn(section).every((url) => ATTACHMENT.test(url))) return null;
  return { id: comment.id, nodeId: comment.node_id, bot: m[1], sha: m[2], section };
}

/**
 * Each bot's newest upload, and the bots' other uploads, to hide.
 *
 * @param {readonly Comment[]} comments
 * @param {string} login
 */
export function latest(comments, login) {
  /** @type {Map<string, Upload>} */
  const best = new Map();
  /** @type {Upload[]} */
  const all = [];
  for (const comment of comments) {
    const upload = parseUpload(comment, login);
    if (!upload) continue;
    all.push(upload);
    const seen = best.get(upload.bot);
    if (!seen || upload.id > seen.id) best.set(upload.bot, upload);
  }
  const kept = new Set([...best.values()].map((u) => u.id));
  return { sections: best, outdated: all.filter((u) => !kept.has(u.id)) };
}

/**
 * The description with each bot's section in it.
 *
 * @param {string} body
 * @param {ReadonlyMap<string, Upload>} sections
 */
export function withSections(body, sections) {
  let out = body;
  for (const [bot, upload] of [...sections].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out = blocks.write(out, bot, upload.section);
  }
  return out;
}

/**
 * What describe needs from GitHub.
 *
 * @typedef {object} Io
 * @property {() => string} body the description, read now
 * @property {(body: string) => void} write sets it (the Actions token)
 * @property {() => Comment[]} comments the PR's or issue's comments
 * @property {(nodeId: string) => void} hide marks a comment outdated
 * @property {(line: string) => void} log
 */

/**
 * Writes every bot's newest section, and hides the uploads it supersedes.
 * Returns whether the description changed.
 *
 * @param {Io} io
 * @param {string} login BOT_PR_TOKEN's account
 */
export function describe(io, login) {
  const { sections, outdated } = latest(io.comments(), login);
  let changed = false;
  for (let attempt = 1; ; attempt++) {
    const before = io.body();
    const after = withSections(before, sections);
    if (after === before) break;
    // Read again just before writing: an edit meanwhile is worked in.
    if (io.body() !== before) {
      if (attempt >= ATTEMPTS) {
        throw new Error(
          `the description kept changing while describe wrote it (${ATTEMPTS} tries): run this job again`,
        );
      }
      continue;
    }
    io.write(after);
    changed = true;
    break;
  }
  for (const upload of outdated) io.hide(upload.nodeId);
  io.log(
    `describe: ${sections.size} section(s)${changed ? ' written' : ' already up to date'}, ${outdated.length} old upload(s) hidden`,
  );
  return changed;
}
