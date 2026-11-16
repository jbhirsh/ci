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
//
// A section may come in parts (ci#80), so a bot's pictures sit under the
// change that made them rather than in one block. The section is then lines
// `<!-- describe-part:<key> -->` each followed by that part's text, the key
// `head` (the heading), `rest` (rows no slot can take) or `screen:<state>`.
// A section with no part line is one part, as before. The author puts
// `<!-- describe:<bot>:<state> -->` … `<!-- /describe:<bot>:<state> -->`
// (a slot) under a change, and the part of that state goes in it; every
// other part goes in the bot's own block, in order, so nothing is lost. A
// slot whose state has no part this run is emptied, its markers kept. A slot
// counts only when it is a clean pair (placedSlots says what that is): a
// doubled, nested, torn or overlapping one, or one around another tool's
// block, is the author's text, and its
// part goes to the bot's block. The block is emptied before the slots are
// read, so a marker inside it is gone and can't count. A state is a file
// name's, so one outside letters, digits, `.`, `_` and `-`, or holding `--`,
// never gets a slot or a part (its rows stay in the bot's block). Part lines never reach the description. Slots added
// by editing the description are filled on the next run from the same
// upload: this reads the upload again each time, so no new upload is needed.

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

/** What a part's key may name: letters, digits, `.`, `_` and `-`, no `--`; a state is a file name, and blocks.mjs must take the key. */
export const isScreenState = (/** @type {string} */ state) =>
  /^[A-Za-z0-9._-]+$/.test(state) && !state.includes('--');
/** The line that starts a part in an upload's section. */
export const partMarker = (/** @type {string} */ key) => `<!-- describe-part:${key} -->`;
const PART = /^<!-- describe-part:(head|rest|screen:([^\s<>]+)) -->$/;

/**
 * The key a line starts a part with, or null when it isn't a part line.
 *
 * @param {string} line
 */
function partKey(line) {
  const m = PART.exec(line.trimEnd());
  if (!m) return null;
  return m[2] === undefined || isScreenState(m[2]) ? m[1] : null;
}

/** Any tool's block marker (lib/blocks.mjs): `<!-- prefix:key -->` or `<!-- /prefix:key -->`. */
const ANY_MARKER = /<!-- \/?[a-z][a-z0-9-]*:[^\s<>]+ -->/;

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
  // A marker inside would cut the block short or start another. The part
  // lines are the one thing of ours a section may hold.
  const plain = section
    .split('\n')
    .filter((line) => partKey(line) === null)
    .join('\n');
  if (plain.includes('<!-- describe') || plain.includes('<!-- /describe')) return null;
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
 * A section's parts, in order, or null when it has no part line.
 *
 * @param {string} section
 * @returns {{ key: string, state?: string, text: string }[] | null}
 */
function partsOf(section) {
  /** @type {{ key: string, state?: string, lines: string[] }[]} */
  const parts = [];
  let any = false;
  for (const line of section.split('\n')) {
    const key = partKey(line);
    if (key !== null) {
      any = true;
      const state = key.startsWith('screen:') ? key.slice('screen:'.length) : undefined;
      // A part named twice reads as two, and a slot takes both.
      parts.push({ key, state, lines: [] });
    } else if (parts.length > 0) parts[parts.length - 1].lines.push(line);
    else if (line.trim() !== '') parts.push({ key: 'rest', lines: [line] });
  }
  if (!any) return null;
  return parts.map(({ key, state, lines }) => ({ key, state, text: lines.join('\n').trim() }));
}

/**
 * The states with a slot in the description that counts for this bot: one
 * start and one end of its own, with nothing of any tool's markers between
 * them, the bot's other markers (a slot's, or its block's) and another
 * tool's blocks (`pr-gif:`, `pictures:`) alike. Writing such a slot destroys
 * no marker and no one's block, so the next run reads the same slots; a
 * doubled, nested, torn or overlapping one, or one around a block, is left
 * as the author wrote it.
 *
 * @param {string} body
 * @param {string} bot
 * @returns {Set<string>}
 */
function placedSlots(body, bot) {
  const marks = [
    ...body.matchAll(new RegExp(`<!-- (/?)describe:${bot}(?::([^\\s<>]+))? -->`, 'g')),
  ].map((m) => ({
    end: m[1] === '/',
    state: m[2],
    from: /** @type {number} */ (m.index),
    to: /** @type {number} */ (m.index) + m[0].length,
  }));
  /** @type {Set<string>} */
  const placed = new Set();
  marks.forEach((mark, i) => {
    const { state } = mark;
    if (mark.end || state === undefined || !isScreenState(state)) return;
    const own = marks.filter((m) => m.state === state);
    const next = marks[i + 1];
    if (own.length !== 2 || !next || !next.end || next.state !== state) return;
    if (!ANY_MARKER.test(body.slice(mark.to, next.from))) placed.add(state);
  });
  return placed;
}

/**
 * The description with one bot's section in it.
 *
 * @param {string} body
 * @param {string} bot
 * @param {string} section
 */
function writeSection(body, bot, section) {
  const parts = partsOf(section);
  // The block is emptied first, and the slots that count are read from what
  // is left: writing it later can't destroy a marker that made a slot not
  // count, which would make the next run decide differently.
  let out = blocks.write(body, bot, '');
  const slots = placedSlots(out, bot);
  for (const state of slots) {
    const text = (parts ?? []).filter((p) => p.state === state).map((p) => p.text);
    out = blocks.write(out, `${bot}:${state}`, text.filter(Boolean).join('\n\n'));
  }
  const rest = parts
    ? parts
        .filter((p) => p.state === undefined || !slots.has(p.state))
        .map((p) => p.text)
        .filter(Boolean)
        .join('\n\n')
    : section;
  return blocks.write(out, bot, rest);
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
    out = writeSection(out, bot, upload.section);
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
