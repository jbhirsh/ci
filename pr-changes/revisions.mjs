// The Revisions table of a PR's description (ci#111): once the PR has a
// revision (its head moved, by a push or a force-push), the tool writes
// `## Revisions` and a table, newest first, between `<!-- pr-changes:revisions -->`
// markers; until then it writes nothing. A row says the revision's number,
// its head, what changed (written here from the commits) and why (the author's
// to write). The description check (pr-template/body.mjs) reads the row whose
// Rev cell says `(current)` and requires its Head cell to name the PR's head.
//
//   | Rev | Head | What changed | Why |
//   | 2 (current) | [`abc1234`](https://github.com/o/r/commit/<40 hex>) | [`old7…new7`](…/compare/old...new)<br>subject<br>+ 3 more | |
//
// The old head goes in What, never in Head: the check tests that the current
// row's Head cell holds the head's first 7 characters, so an old sha there
// would pass falsely after a force-push back to it.
//
// The block is the author's to edit (a Why is meant to be), so it is parsed,
// never trusted:
//   - a row is a line starting `|` with exactly four cells (split on unescaped
//     pipes), each at most CELL_CHARS; its Rev is 1-999999 with an optional
//     ` (current)`; its Head is exactly one commit link of this repo whose
//     seven hex are the sha's first seven. Only such a row is ever read as
//     state (the previous head is the `(current)` one, else the highest Rev);
//   - what the author typed is never destroyed: a valid row's cells are kept
//     byte for byte (only `<!--` and `-->` are made harmless, as an unclosed
//     comment would hide the end marker), and any other line is kept below
//     the table, with its `(current)` defused, and a warning;
//   - what this module writes is from validated values only: the repo and
//     the shas, a Rev number, and commit subjects escaped by changes.mjs's
//     `escape` (a subject is a stranger's text).
//
// Size: the block is held to REVISIONS_BUDGET characters by steps, each only
// when the one before is too long: the new row's subjects (3, then none);
// older rows' What cut to a note (never row 1's, nor the newest's); the oldest
// rows after row 1 left out, said in a line under the table.
//
// The first write of a table rebuilds the heads before it from GitHub's
// timeline of the PR (revisions-run.mjs reads it; `headChain` and `capChain`
// decide which heads and which rows). The timeline's `head_ref_force_pushed`
// events each carry the head after a force-push, in order: those are the heads
// a force-push made, and the only heads the record names. What it does not
// give: the head a PR opened at, once a force-push has replaced it (the first
// head listed is then the first one a force-push made), the heads of plain
// pushes (a plain push adds commits, and `committed` events carry no push
// boundary, so the commits of several plain pushes between two force-pushes
// are one row, which the row's compare range covers), and any head
// that was force-pushed away and never fetched (its row says its commits
// were replaced; a row whose commits are all gone from the PR says that too, and one
// whose range GitHub failed to read says so). At most HISTORY_HEADS heads are
// written: the first and the latest ones, with the true revision numbers, and a
// line saying how many are not listed (parseTable reads it back, so a later
// push keeps it). Row 1 says `Opened` when no force-push came before the head
// it names, else that it is the first head the record names. What the author
// typed in the block stays below the table.
//
// A description with no revisions markers at all (an author, or a tool that
// rewrote it, left the template's pair out) would never get a table, and
// nothing would say so: `withPair` puts the empty pair back, so that the
// first push that moves the head can write the table (revisions-run.mjs says
// when it asks for one).
//
// Pure: texts in, texts out. revisions-run.mjs reads and writes GitHub.

import { revisionsPair } from '../pr-template/body.mjs';
import { blocks, escape, ownBlock } from './changes.mjs';

/** The most characters the Revisions block holds. */
export const REVISIONS_BUDGET = 12_000;
/** The most characters of one cell the tool reads or keeps. */
export const CELL_CHARS = 2000;
/** The most commit subjects a row lists, and their longest, before "+ N more". */
export const SUBJECTS = 5;
const SUBJECT_CHARS = 72;
/** The most characters of the goal's first sentence, which row 1's Why copies. */
const WHY_CHARS = 200;

const HEADING = '## Revisions';
const HEADER = '| Rev | Head | What changed | Why |';
const SEPARATOR = '| --- | --- | --- | --- |';
const REV = /^([1-9]\d{0,5})( \(current\))?$/;
const OMITTED = /^_(\d{1,6}) earlier revisions? left out to stay under GitHub's limit\._$/;
const CAPPED =
  /^_(\d{1,6}) earlier heads? (?:is|are) not listed: the table keeps the first head and the latest ones\._$/;
const CUT = 'older revision: its commits are cut to keep this table short';

/**
 * One valid row of the table.
 *
 * @typedef {object} Row
 * @property {number} rev
 * @property {boolean} current
 * @property {string} sha the row's head, 40 hex
 * @property {string} what
 * @property {string} why
 */

/** The most heads the first write of a table lists (the first, and the latest of the rest). */
export const HISTORY_HEADS = 20;
/** What a row says when the commits between its head and the one before are gone. */
export const REPLACED = '(commits replaced by a force-push)';
/** What a row says when a range of commits could not be read just now (a rate limit, say). */
export const UNREAD = '(its commits could not be read just now)';
/** What a row adds when none of its commits is on the PR any more. */
export const NO_LONGER = '(none of its commits is on the PR now)';
/** What row 1 says when a force-push replaced the head the PR opened at. */
export const FIRST_KNOWN =
  "the first head GitHub's record of the PR names (earlier heads were replaced)";

/** @typedef {Record<string, unknown>} TimelineEvent  one event of a PR's timeline: only `event` and `commit_id` are read */

/**
 * The heads a PR has had, oldest first, as far as its timeline says (the
 * header says what it can't): the head each force-push made, then the head
 * before the push that is being recorded (`before`, when a plain push) and the
 * current head. Empty when the timeline names no force-push (the caller then
 * starts from `before`), and when fewer than two distinct heads come out.
 * Consecutive repeats are one head.
 *
 * @param {readonly TimelineEvent[]} events
 * @param {{ head: string, before: string | null }} now
 * @returns {string[]}
 */
export function headChain(events, { head, before }) {
  return headHistory(events, { head, before }).chain;
}

/**
 * `headChain`, and whether its first head is one a force-push made (so that
 * earlier heads were replaced before it) rather than `before`, the head the PR
 * had before this push, which is its opening head when no force-push came
 * earlier.
 *
 * @param {readonly TimelineEvent[]} events
 * @param {{ head: string, before: string | null }} now
 * @returns {{ chain: string[], fromTimeline: boolean }}
 */
export function headHistory(events, { head, before }) {
  const sha = /^[0-9a-f]{40}$/;
  /** @type {string[]} */
  const ids = [];
  for (const e of events) {
    if (e?.event !== 'head_ref_force_pushed' || typeof e.commit_id !== 'string') continue;
    const id = e.commit_id.toLowerCase();
    if (sha.test(id) && ids[ids.length - 1] !== id) ids.push(id);
  }
  if (ids.length === 0 || !sha.test(head)) return { chain: [], fromTimeline: false };
  const chain = ids[ids.length - 1] === head ? ids.slice(0, -1) : ids;
  const fromTimeline = chain.length > 0;
  if (before !== null && sha.test(before) && chain[chain.length - 1] !== before) chain.push(before);
  if (chain[chain.length - 1] !== head) chain.push(head);
  return chain.length >= 2 ? { chain, fromTimeline } : { chain: [], fromTimeline: false };
}

/**
 * Which heads of a chain are written, each with its true revision number (its
 * place in the whole chain, from 1): all of them up to `max`, else the first
 * and the latest `max - 1`.
 *
 * @param {readonly string[]} chain
 * @param {number} [max]
 * @returns {{ kept: { sha: string, rev: number }[], omitted: number }}
 */
export function capChain(chain, max = HISTORY_HEADS) {
  const all = chain.map((sha, i) => ({ sha, rev: i + 1 }));
  if (all.length <= max) return { kept: all, omitted: 0 };
  return { kept: [all[0], ...all.slice(all.length - (max - 1))], omitted: all.length - max };
}

/** A footer a tool or an author closes a description with: a rule, then one italic line. */
const FOOTER = /\r?\n---[ \t]*(?:\r?\n)+_[^\r\n]*_[ \t]*(?:\r?\n)*$/;

/**
 * The description with the empty revisions marker pair in it when it has no
 * revisions marker at all, counted as the description check counts them
 * (`revisionsPair`): a marker is the whole of its line, outside fenced code,
 * so a fenced example or a marker quoted in a sentence doesn't stop the pair
 * being put in, and one torn or repeated pair is the author's to mend, which
 * the tool warns about. The pair goes where the template puts it: above the
 * index block of the changes tool when there is one, else at the end, ahead of
 * a footer rule, in the description's own line endings.
 *
 * @param {string} body
 * @returns {string}
 */
export function withPair(body) {
  const found = revisionsPair(body);
  if (found.starts.length > 0 || found.ends.length > 0) return body;
  const { start, end } = blocks.markers('revisions');
  const nl = body.includes('\r\n') ? '\r\n' : '\n';
  const pair = `${start}${nl}${end}`;
  const index = ownBlock(body, 'index');
  const footer = FOOTER.exec(body);
  let out;
  if (index) {
    const before = body.slice(0, index.from);
    // The pair is lines of its own, even where the index block shares a line with text.
    const lead = before === '' || before.endsWith('\n') ? '' : nl;
    out = `${before}${lead}${pair}${nl}${nl}${body.slice(index.from)}`;
  } else if (footer) {
    out = `${body.slice(0, footer.index).trimEnd()}${nl}${nl}${pair}${nl}${body.slice(footer.index)}`;
  } else {
    out = body.trimEnd() ? `${body.trimEnd()}${nl}${nl}${pair}${nl}` : `${pair}${nl}`;
  }
  // A description that ends inside a fence that never closes would hide a pair
  // put at the end: then it goes first, where no fence has opened yet.
  return revisionsPair(out).at ? out : `${pair}${nl}${nl}${body}`;
}

/**
 * The block's content, read.
 *
 * @typedef {object} Table
 * @property {Row[]} rows the valid rows
 * @property {string[]} rest lines that are no valid row, kept below the table
 * @property {number} omitted how many earlier revisions a past run left out
 * @property {number} [capped] how many earlier heads the first write didn't list (HISTORY_HEADS)
 */

/**
 * The text of a cell or line with what could open or close an HTML comment made inert.
 *
 * @param {string} text
 */
export const inert = (text) =>
  text.replace(/<!--/g, '&lt;!--').replace(/--!?>/g, (m) => m.slice(0, -1) + '&gt;');

/**
 * @param {string} line a line starting `|`
 * @returns {string[]} its cells, trimmed
 */
function cells(line) {
  const inner = line.replace(/^\|/, '').replace(/(?<!\\)\|\s*$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

/**
 * Reads the block's content (what is between its markers).
 *
 * @param {string} inner
 * @param {string} repo `owner/name`: a Head link must point here
 * @returns {Table}
 */
export function parseTable(inner, repo) {
  const head = new RegExp(
    `^\\[\`([0-9a-f]{7})\`\\]\\(https://github\\.com/${repo.replace(/[.\\]/g, '\\$&')}/commit/([0-9a-f]{40})\\)$`,
  );
  /** @type {Row[]} */
  const rows = [];
  /** @type {string[]} */
  const rest = [];
  let omitted = 0;
  let capped = 0;
  for (const raw of inner.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line === HEADING || /^\|\s*Rev\s*\|/.test(line)) continue;
    if (/^\|[\s:|-]+\|?$/.test(line)) continue;
    const note = OMITTED.exec(line);
    if (note) {
      omitted += Number(note[1]);
      continue;
    }
    const cap = CAPPED.exec(line);
    if (cap) {
      capped += Number(cap[1]);
      continue;
    }
    const c = line.startsWith('|') ? cells(line) : [];
    // Pipes in the Why (the last cell) are the author's text, not more columns:
    // they are put back escaped, so the row stays a row when it is written.
    if (c.length > 4) c.splice(3, c.length - 3, c.slice(3).join(' \\| '));
    const rev = c.length === 4 && c.every((x) => x.length <= CELL_CHARS) ? REV.exec(c[0]) : null;
    const link = rev ? head.exec(c[1]) : null;
    if (rev && link && link[2].startsWith(link[1])) {
      rows.push({
        rev: Number(rev[1]),
        current: rev[2] !== undefined,
        sha: link[2],
        what: inert(c[2]),
        why: inert(c[3]),
      });
    } else {
      rest.push(inert(line.slice(0, CELL_CHARS * 4)).replace(/\(current\)/g, '(current\u200b)'));
    }
  }
  return { rows, rest, omitted, capped };
}

/**
 * The head a table says the PR was last at: its `(current)` row, else the highest Rev.
 *
 * @param {readonly Row[]} rows
 * @returns {string | null}
 */
export function previousHead(rows) {
  const current = rows.find((r) => r.current);
  if (current) return current.sha;
  return (
    rows.reduce((/** @type {Row | null} */ best, r) => (!best || r.rev > best.rev ? r : best), null)
      ?.sha ?? null
  );
}

/**
 * @param {Row} row
 * @param {string} repo
 */
const rowLine = (row, repo) =>
  `| ${row.rev}${row.current ? ' (current)' : ''} | [\`${row.sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${row.sha}) | ${row.what} | ${row.why} |`;

/**
 * The block's content: the heading (unless one stands before the block), the
 * table newest first, a note of left-out revisions, and the lines kept.
 *
 * @param {Table} table
 * @param {string} repo
 * @param {{ heading: boolean }} options
 */
export function renderTable({ rows, rest, omitted, capped = 0 }, repo, { heading }) {
  const sorted = [...rows].sort((a, b) => b.rev - a.rev);
  return [
    ...(heading ? [HEADING, ''] : []),
    HEADER,
    SEPARATOR,
    ...sorted.map((r) => rowLine(r, repo)),
    ...(omitted > 0
      ? [
          '',
          `_${omitted} earlier revision${omitted === 1 ? '' : 's'} left out to stay under GitHub's limit._`,
        ]
      : []),
    ...(capped > 0
      ? [
          '',
          `_${capped} earlier head${capped === 1 ? ' is' : 's are'} not listed: the table keeps the first head and the latest ones._`,
        ]
      : []),
    ...(rest.length > 0 ? ['', ...rest] : []),
  ].join('\n');
}

/**
 * One commit of the PR, as the What cell lists it.
 *
 * @typedef {object} Subject
 * @property {string} sha
 * @property {string} subject
 * @property {boolean} skipped a merge or a bot's commit, which is counted, not listed
 */

/**
 * What changed between two heads, for a row's What cell.
 *
 * @param {object} range
 * @param {string} range.repo
 * @param {string} range.prev the old head
 * @param {string} range.head the new head
 * @param {'ahead' | 'rewritten' | 'gone'} range.how `ahead`: the PR grew;
 *   `rewritten`: a force-push or rebase; `gone`: the old head can't be read
 * @param {readonly Subject[]} range.commits the commits since the old head (or, rewritten, the PR's own)
 * @param {number} [range.dropped] commits the old head had that the branch no longer has
 * @param {string | null} [range.base] the merge base, when rewritten
 * @param {number} [subjects] how many subjects to list
 * @returns {string}
 */
export function describeRange(range, subjects = SUBJECTS) {
  const { repo, prev, head, how, commits, dropped = 0, base = null } = range;
  const old = prev.slice(0, 7);
  const now = head.slice(0, 7);
  const lead =
    how === 'ahead'
      ? `[\`${old}…${now}\`](https://github.com/${repo}/compare/${prev}...${head})`
      : how === 'gone'
        ? `rewritten, the old head \`${old}\` is gone`
        : `rewritten (force-push or rebase) from \`${old}\`${base ? `, merge base \`${base.slice(0, 7)}\`` : ''}${dropped > 0 ? `, ${dropped} earlier commit${dropped === 1 ? '' : 's'} no longer on the branch` : ''}`;
  const listed = commits.filter((c) => !c.skipped);
  const skipped = commits.length - listed.length;
  const shown = listed.slice(0, subjects).map((c) => {
    const cut = [...c.subject].slice(0, SUBJECT_CHARS).join('');
    return escape(cut) + (cut.length < c.subject.length ? '…' : '');
  });
  return [
    lead,
    ...shown,
    ...(listed.length > shown.length ? [`+ ${listed.length - shown.length} more`] : []),
    ...(skipped > 0 ? [`+ ${skipped} bot or merge commit${skipped === 1 ? '' : 's'}`] : []),
  ].join('<br>');
}

/**
 * The goal's first sentence, for row 1's Why: the first line under the
 * `## Goal` (or `## Problem`) heading of the lines a reader sees, cut at its
 * first full stop and at WHY_CHARS, escaped. Empty when there is none.
 *
 * @param {readonly string[]} lines the description as `renderedLines` gives it
 * @returns {string}
 */
export function goalSentence(lines) {
  const at = lines.findIndex((l) => /^#{2}\s+(Goal|Problem)\s*$/i.test(l.trim()));
  if (at === -1) return '';
  const text = lines.slice(at + 1).find((l) => l.trim() !== '' && !/^#{1,6}\s/.test(l.trim()));
  if (text === undefined) return '';
  const first = /^(.+?[.!?])(\s|$)/.exec(text.trim())?.[1] ?? text.trim();
  const cut = [...first].slice(0, WHY_CHARS).join('');
  return escape(cut);
}

/**
 * The table with a row for `head` added, and every other row no longer current.
 * A table with no row yet gets row 1 for the head the PR opened at (`opened`),
 * and its Why is the goal's first sentence.
 *
 * @param {Table} table
 * @param {object} next
 * @param {string} next.head the new head, 40 hex
 * @param {string} next.what its What cell
 * @param {{ sha: string, why: string } | null} next.opened the head the PR opened at, when the table has no row
 * @returns {Table}
 */
export function addRevision(table, { head, what, opened }) {
  const rows = table.rows.map((r) => ({ ...r, current: false }));
  if (rows.length === 0 && opened) {
    rows.push({ rev: 1, current: false, sha: opened.sha, what: 'Opened', why: opened.why });
  }
  const rev = rows.reduce((n, r) => Math.max(n, r.rev), 0) + 1;
  rows.push({ rev, current: true, sha: head, what, why: '' });
  return { ...table, rows };
}

/**
 * The block's content held to REVISIONS_BUDGET, stepping down as the header
 * says. `build(subjects)` makes the table with the new row listing that many
 * subjects.
 *
 * @param {(subjects: number) => Table} build
 * @param {string} repo
 * @param {{ heading: boolean }} options
 * @returns {string}
 */
export function budgeted(build, repo, options) {
  let table = build(SUBJECTS);
  /** @param {Table} t */
  const text = (t) => renderTable(t, repo, options);
  if (text(table).length <= REVISIONS_BUDGET) return text(table);
  for (const n of [3, 0]) {
    table = build(n);
    if (text(table).length <= REVISIONS_BUDGET) return text(table);
  }
  const newest = Math.max(...table.rows.map((r) => r.rev));
  const rows = table.rows.map((r) =>
    r.rev === 1 || r.rev === newest || r.what === CUT ? r : { ...r, what: CUT },
  );
  table = { ...table, rows };
  while (text(table).length > REVISIONS_BUDGET) {
    const droppable = table.rows.filter((r) => r.rev !== 1 && r.rev !== newest);
    if (droppable.length === 0) break;
    const oldest = droppable.reduce((a, b) => (a.rev < b.rev ? a : b));
    table = {
      ...table,
      rows: table.rows.filter((r) => r !== oldest),
      omitted: table.omitted + 1,
    };
  }
  return text(table);
}
