// The Revisions of a PR's description (ci#111): once the PR has a revision
// (its head moved, by a push or a force-push), the tool writes `## Revisions`
// and, for each revision, newest first, a `<details>` block between
// `<!-- pr-changes:revisions -->` markers; until then it writes nothing. The
// description check (pr-template/body.mjs) reads the revision whose summary
// says `(current)` and requires the head link in it to name the PR's head.
//
//   <details open>
//   <summary><b>👉 <a href="https://github.com/o/r/commit/<40 hex>"><code>abc1234</code></a></b> (current) · <a href="…/compare/old...new">compare <code>old7…new7</code></a> · rewritten from <code>old7</code> (2 commits dropped)</summary>
//
//   | What changed | Why |
//   | --- | --- |
//   | what the author changed, in plain words | why |
//
//   </details>
//
//   <details>
//   <summary><a href="https://github.com/o/r/commit/<40 hex>"><code>def5678</code></a> · Opened</summary>
//   …
//
// The newest revision is `<details open>` and every older one is collapsed (a
// reader's own toggling in the browser isn't saved to the description, so the
// writer simply sets it so). The summary is the tool's: the head link (the
// current one bold with a pointer), a compare link on every revision that has a
// head before it (its text keeps the form `compare <code>old…new</code>:
// GitHub drops a link whose whole text is the range, and its row with it), and
// the tool's note (`rewritten from <code>old7</code> (N commits dropped)`,
// `Opened` for the first revision, which has no compare link). Under it is a
// two-column Markdown pipe table, one row for each change, which the AUTHOR
// writes, in plain words: the tool never derives a row from a commit (this repo
// reworks and squashes commits, so a row from git would be wrong or orphaned).
// A revision with no row yet gets one empty placeholder row, `|  |  |`. On every
// write the rows the author wrote are kept as they were, in order (and any
// other line the author typed inside the block, below the table).
//
// Why details, and a table in it: GitHub sizes a Markdown table's columns by
// their content, and an HTML table with set widths was tried and left (a
// three-column table scrolled sideways on a phone, and the owner found the
// others hard to read): one table of two columns under a label keeps each
// cell at half the width, and the collapsed older revisions keep the page short.
// GitHub keeps `open`, `<summary>` and a Markdown table inside `<details>` when
// blank lines surround it (tried on github.com at 402px).
//
// The check reads the summary's head link to find the current revision (a table row the
// author wrote can say anything, `(current)` included, and never makes a revision current),
// then the current revision's rows: it fails until one has both cells filled
// (pr-template/body.mjs says when a cell is). The placeholder written here is what it fails
// on, until the author replaces it (ci#140).
//
// Older shapes are still read, and written back in this one by the next write
// (remove those readers once no open PR holds one):
//   - the HTML table of ci#132's first push (`<tr>` rows, a Why in the last
//     cell, a row of one cell for each line of what changed);
//   - the two-column Markdown table of ci#126, `| What changed | Why |`, whose
//     first cell opens with the head link, bold with a pointer on the current
//     row, then the What after `<br>`;
//   - the old four-column one, `| Rev | Head | What changed | Why |`.
// A revision read from one of them keeps its head, its `(current)`, its Why and
// every line of What: the tool's own notes (`Opened`, `rewritten …`, a compare
// link) go to the summary (the compare link's old head is kept), and the other
// lines, which were the tool's list of commits, become the first row's What, one
// line after another with `<br>` (or `—` when there are none), the old Why in
// its Why cell. A revision's number is not written: it is its place from the
// oldest, counted with the revisions a note says were left out.
//
// The old head goes in the summary's compare link and note, never in the head
// link: the check tests that the current revision's head link holds the head's
// first 7 characters, so an old sha there would pass falsely after a force-push
// back to it.
//
// The block is the author's to edit, so it is parsed, never trusted. A revision
// is a `<details>` whose `<summary>` has a head link of this repo whose first
// seven hex are the text shown (the patterns the check uses). Only such a block
// is ever read as state (the previous head is the `(current)` one, else the
// highest Rev). Whatever its size, nothing is refused for its length. Anything
// else is kept below, with its `(current)` defused, and a warning.
//
// What the author typed is never destroyed: a row, and a line typed in the
// block, are kept (a comment, and a tag that would end the block, `<details>`,
// `<summary>`, a table's tags and a bogus comment `<!x`, `<?x`, `</ x`, are made
// harmless: `&lt;`; a row is one line, and U+2028 and U+2029, which break a line
// for the check's `^` and not for GitHub, are spaces). What this module writes is
// from validated values only: the repo and the shas, and the tool's notes.
//
// Size: the block is held to REVISIONS_BUDGET characters in one step: while it is
// too long, the OLDEST revision after revision 1 is left out whole (its block, with
// the rows and lines in it), said in a line under the blocks ("N earlier revisions
// left out"). Revision 1 and the newest are never left out, and no row of a revision
// that is kept is ever cut, shortened or replaced: what an author typed in a kept
// block is written back as it was. The only loss is a whole old revision, and only
// past 12,000 characters.
//
// What the tool changes in what an author typed, and what it does not do:
//  - a row that has other than two cells is written as GitHub reads it (the cells
//    after the second joined into it with `\|`, or an empty second cell): write a
//    pipe in a cell as `\|`;
//  - a `(current)` after a head link typed in a row or a line is defused with a
//    zero-width space, so it is not read as a current revision;
//  - a typed `</details>` in a row becomes `&lt;/details>`; the block ends at a line
//    that is `</details>` alone;
//  - text typed between the blocks, before the first or after the last, is kept
//    below all the blocks, in order;
//  - a block the author makes by typing a summary with a head link of this repo is
//    read as a revision, since it is one: delete it to remove it;
//  - an unclosed code fence typed inside the block hides the end marker from the
//    check (and the tool), as it always did: close it;
//  - what is left out at the size limit is whole old revisions; the text typed
//    outside the blocks is never left out, so a description that is too long
//    because of it stays too long: shorten it.
//
// The first write of a block rebuilds the heads before it from GitHub's
// timeline of the PR (revisions-run.mjs reads it; `headChain` and `capChain`
// decide which heads and which revisions). The timeline's `head_ref_force_pushed`
// events each carry the head after a force-push, in order: those are the heads
// a force-push made, and the only heads the record names. What it does not
// give: the head a PR opened at, once a force-push has replaced it (the first
// head listed is then the first one a force-push made), the heads of plain
// pushes (a plain push adds commits, and `committed` events carry no push
// boundary, so the commits of several plain pushes between two force-pushes
// are one revision, which its compare link covers), and any head
// that was force-pushed away and never fetched (its note says its commits
// were replaced; a revision whose commits are all gone from the PR says that
// too, and one whose range GitHub failed to read says so). At most HISTORY_HEADS
// heads are written: the first and the latest ones, with the true revision
// numbers, and a line saying how many are not listed (parseTable reads it back,
// so a later push keeps it). Revision 1 says `Opened` when no force-push came
// before the head it names, else that it is the first head the record names.
// What the author typed outside the blocks stays below them.
//
// A description with no revisions markers at all (an author, or a tool that
// rewrote it, left the template's pair out) would never get a block, and
// nothing would say so: `withPair` puts the empty pair back, so that the
// first push that moves the head can write it (revisions-run.mjs says when it
// asks for one).
//
// Pure: texts in, texts out. revisions-run.mjs reads and writes GitHub.

import {
  htmlLeadBold,
  htmlLeadPlain,
  htmlLink,
  leadBold,
  leadPlain,
  revisionsPair,
  TABLE_EMPTY_LINE,
  TABLE_HEAD_LINE,
  TABLE_RULE_LINE,
} from '../pr-template/body.mjs';
import { blocks, escape, ownBlock } from './changes.mjs';

/** The most characters the Revisions block holds. */
export const REVISIONS_BUDGET = 12_000;
/** The most characters of the goal's first sentence, which revision 1's first row copies. */
const WHY_CHARS = 200;

const HEADING = '## Revisions';
const TABLE_HEAD = '| What changed | Why |';
const TABLE_RULE = '| --- | --- |';
/** The row of a revision that has none yet: the author fills it (read as no row, so the tool writes it again while there is none). */
const PLACEHOLDER = '|  |  |';
const REV = /^([1-9]\d{0,5})( \(current\))?$/;
const OMITTED = /^_(\d{1,6}) earlier revisions? left out to stay under GitHub's limit\._$/;
const CAPPED =
  /^_(\d{1,6}) earlier heads? (?:is|are) not listed: the (?:table|list) keeps the first head and the latest ones\._$/;

/**
 * One revision of the PR.
 *
 * @typedef {object} Row
 * @property {number} rev its place from the oldest, 1 up (read from an old table's Rev cell, else counted)
 * @property {boolean} current
 * @property {string} sha the revision's head, 40 hex
 * @property {string | null} prev the head before it, 40 hex, which its compare link spans (null for the first, and when the old head is gone)
 * @property {string} note the tool's note, HTML on one line (`Opened`, `rewritten from …`), or ''
 * @property {string[]} rows the author's rows of the table, each a line starting `|`, as written
 * @property {string[]} typed any other line the author typed in the block
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
 * The content of the Revisions block, read.
 *
 * @typedef {object} Table
 * @property {Row[]} rows the revisions, as read
 * @property {string[]} rest lines that are no revision, kept below the blocks
 * @property {number} omitted how many earlier revisions a past run left out
 * @property {number} [capped] how many earlier heads the first write didn't list (HISTORY_HEADS)
 */

/**
 * The text of a cell or line with what could open or close an HTML comment, or start a bogus one
 * (`<!x`, `<?x`, `</ x`), made inert.
 *
 * @param {string} text
 */
export const inert = (text) =>
  text
    // `<!`, `<?` and `</` with no letter after it start a bogus comment, which ends at the first `>`
    // and so can swallow the `</details>` after it, as `<!--` does.
    .replace(/<(?=[!?]|\/(?![A-Za-z]))/g, '&lt;')
    .replace(/--!?>/g, (m) => m.slice(0, -1) + '&gt;');

/** A tag that would end a revision's block, a cell or the table, or open one. */
const STRUCTURAL =
  /<(?=\/?(?:table|thead|tbody|tfoot|tr|td|th|colgroup|col|caption|details|summary)\b)/gi;

/**
 * One line of text as it is kept: on one line (U+2028 and U+2029 break a line for the check's
 * `^`, and not for GitHub, so they are spaces here), with a comment and a tag of the block's own
 * made harmless, so that it can't end the block. What is escaped reads back as the same text, and
 * is not escaped again.
 *
 * @param {string} text
 */
const lineText = (text) =>
  inert(text.replace(/\s*[\r\n\u2028\u2029]\s*/g, ' ').trim()).replace(STRUCTURAL, '&lt;');

/**
 * A line the author typed, or a row, with a `(current)` that the check would read as a Markdown
 * table's current row (straight after a head link that opens it, or in a first cell before a cell
 * that holds one) defused with a zero-width space. Only that one: a line already defused is left
 * as it is.
 *
 * @param {string} line
 */
const defusedRow = (line) =>
  line
    .replace(
      /^(\|?[ \t]*(?:\*\*)?(?:👉 )?\[`[0-9a-f]{7}`\]\([^)]*\)(?:\*\*)?\s*)\(current\)/,
      '$1(current\u200b)',
    )
    // The old four-column table's current row: `(current)` in its first cell, a head link in the next.
    .replace(/^(\|[^|\n[]*)(\|[ \t]*\[`[0-9a-f]{7}`\])/, (match, first, second) =>
      /\(current\)/.test(first)
        ? `${first.replace(/\(current\)/g, '(current\u200b)')}${second}`
        : match,
    );

/**
 * A table row with the two cells of the table's header: GitHub drops the cells after the second and
 * pads a row with fewer, so a row of another count is written as it will read: the cells after the
 * first joined into the last, with their pipes escaped, or an empty last cell. A row of two cells is
 * left exactly as it is.
 *
 * @param {string} row a line starting `|`
 */
const twoCells = (row) => {
  const inner = row.replace(/^\|/, '').replace(/(?<!\\)\|\s*$/, '');
  const parts = inner.split(/(?<!\\)\|/);
  if (parts.length === 2 || inner.trim() === '') return row;
  const first = (parts[0] ?? '').trim();
  const rest = parts
    .slice(1)
    .map((c) => c.trim())
    .join(' \\| ');
  return `| ${first} | ${rest} |`.replace(/ {2,}\|$/, ' |');
};

/** A `|` in a table cell the author didn't escape: it would end the cell. */
const cellEscape = (/** @type {string} */ text) => text.replace(/(?<!\\)\|/g, '\\|');

/**
 * @param {string} line a line starting `|`
 * @returns {string[]} its cells, trimmed
 */
function cells(line) {
  const inner = line.replace(/^\|/, '').replace(/(?<!\\)\|\s*$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

/**
 * A What cell of a Markdown table as the tool wrote it for the current row (each `<br>`-separated
 * line bold) back to the plain lines it holds, one bold layer taken off each line. What the tool
 * wrote is escaped, so a line it wrote never starts and ends with an unescaped `**` of its own.
 *
 * @param {string} what
 * @param {boolean} bold
 * @returns {string[]}
 */
function markdownLines(what, bold) {
  return what
    .split('<br>')
    .map((l) => (bold && /^\*\*[\s\S]+\*\*$/.test(l) && l.length > 4 ? l.slice(2, -2) : l))
    .map((l) => lineText(l))
    .filter((l) => l !== '');
}

/** What the tool wrote on a revision's lines that is a note of its own, not a commit. */
const TOOL_NOTES = new Set([REPLACED, UNREAD, NO_LONGER, FIRST_KNOWN]);
const COMPARE_LINE =
  /^(?:\[[^\]]*\]\(|<a href=")https:\/\/github\.com\/[^")]*\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})(?:\)|"[^>]*>[\s\S]*<\/a>)$/;

/**
 * What an old shape's revision holds, as the new shape keeps it: its notes go to the summary (the
 * compare link's old head is kept), the other lines of What become the first row's What, one after
 * another with `<br>` (`—` when there is none), and the old Why its Why cell.
 *
 * @param {readonly string[]} what the lines of What, each already one line
 * @param {string} why
 * @param {string} sha the revision's head
 * @returns {{ prev: string | null, note: string, rows: string[] }}
 */
function fromOld(what, why, sha) {
  /** @type {string | null} */
  let prev = null;
  /** @type {string[]} */
  const notes = [];
  /** @type {string[]} */
  const keep = [];
  for (const line of what) {
    const compare = COMPARE_LINE.exec(line);
    if (compare) prev = compare[2] === sha ? compare[1] : prev;
    else if (line === 'Opened' || /^rewritten\b/.test(line) || TOOL_NOTES.has(line)) {
      notes.push(lineText(line.replace(/`([^`]*)`/g, '<code>$1</code>')));
    } else keep.push(line);
  }
  const rows =
    keep.length === 0 && why === ''
      ? []
      : [`| ${keep.map(cellEscape).join('<br>') || '—'} | ${cellEscape(why)} |`];
  return { prev, note: notes.join(' '), rows: rows.map((r) => twoCells(defusedRow(r))) };
}

/** The lines of the old HTML table's frame, which the tool no longer writes. */
const FRAME =
  /^(?:(?:<\/?(?:table|thead|tbody|tfoot|colgroup|col)\b[^>]*>\s*)+|<thead\b[\s\S]*<\/thead>|<tr>\s*<th\b[\s\S]*<\/tr>)$/i;
/** A row of one cell across the old HTML table, which holds a revision's next line. */
const MORE = /^[ \t]*<tr>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<\/tr>[ \t]*$/;
// The header and the rule of a Markdown table of two columns, which the tool writes again, and the
// row of a revision that has none yet (no cell holds anything): TABLE_HEAD_LINE, TABLE_RULE_LINE and
// TABLE_EMPTY_LINE, from pr-template/body.mjs, so that the check reads the same frame.
/** A line of an old Markdown table's frame (its header and its rule), which the tool no longer writes. */
const OLD_FRAME_LINE = /^\|\s*(?:Rev|What changed)\s*\|/;

/**
 * Reads the block's content (what is between its markers): the `<details>` blocks the tool writes,
 * and the shapes earlier PRs hold.
 *
 * @param {string} inner
 * @param {string} repo `owner/name`: a head link must point here
 * @returns {Table}
 */
export function parseTable(inner, repo) {
  // The repo goes into a pattern: every character a pattern reads is escaped, the backslash with them.
  const where = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const link = `\\[\`([0-9a-f]{7})\`\\]\\(https://github\\.com/${where}/commit/([0-9a-f]{40})\\)`;
  // The old four-column shape's Head cell is the link alone; the two-column shape's first cell
  // opens with it: bold, with a pointer, on the current row, plain on an older one, either way read.
  const head = new RegExp(`^${link}$`);
  const tail = '( \\(current\\))?(?:<br>([\\s\\S]*))?$';
  const bold = new RegExp(`^${leadBold(link)}${tail}`);
  const plain = new RegExp(`^${leadPlain(link)}${tail}`);
  const html = htmlLink(where);
  // The old HTML table's first row of a revision: its head cell and its why.
  const first = (/** @type {string} */ lead) =>
    new RegExp(
      String.raw`^[ \t]*<tr>\s*<td\b[^>]*>\s*${lead}(\s*\(current\))?\s*</td>\s*<td\b[^>]*>([\s\S]*?)</td>\s*</tr>[ \t]*$`,
    );
  const htmlBold = first(htmlLeadBold(html));
  const htmlPlain = first(htmlLeadPlain(html));
  // A revision's summary: the head link, `(current)`, a compare link ending at it, a note.
  const compare = `<a href="https://github\\.com/${where}/compare/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})">compare <code>[0-9a-f]{7}…[0-9a-f]{7}</code></a>`;
  const summary = (/** @type {string} */ lead) =>
    new RegExp(
      String.raw`^<summary>\s*${lead}(\s*\(current\))?(?:\s*·\s*${compare})?(?:\s*·\s*([\s\S]*?))?\s*</summary>$`,
    );
  const summaryBold = summary(htmlLeadBold(html));
  const summaryPlain = summary(htmlLeadPlain(html));
  /** @type {Row[]} */
  const rows = [];
  /** @type {string[]} */
  const rest = [];
  // What the old HTML table's rows hold, until the lines of a revision are all read.
  /** @type {Map<Row, { what: string[], why: string }>} */
  const old = new Map();
  let omitted = 0;
  let capped = 0;
  // The revision the last row of the old HTML table opened, while the rows after it are its lines.
  /** @type {Row | null} */
  let open = null;
  const lines = inner.split(/\r?\n/);
  // What the tool writes again, and so never keeps: the heading, an old Markdown table's header and
  // rule, and a table's empty row.
  const isFrame = (/** @type {string} */ line) =>
    line === HEADING ||
    OLD_FRAME_LINE.test(line) ||
    TABLE_RULE_LINE.test(line) ||
    TABLE_EMPTY_LINE.test(line);
  const keepLine = (/** @type {string} */ line) =>
    rest.push(
      inert(line.trim().replace(/[\u2028\u2029]/g, ' '))
        .replace(STRUCTURAL, '&lt;')
        .replace(/\(current\)/g, '(current\u200b)'),
    );
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === '') continue;
    if (isFrame(line)) continue;
    if (FRAME.test(line)) {
      open = null;
      continue;
    }
    const note = OMITTED.exec(line);
    if (note) {
      omitted += Number(note[1]);
      open = null;
      continue;
    }
    const cap = CAPPED.exec(line);
    if (cap) {
      capped += Number(cap[1]);
      open = null;
      continue;
    }
    const details = /^<details\b[^>]*>(.*)$/i.exec(line);
    if (details) {
      open = null;
      // The block runs to the line that ends with `</details>`, or to the next block, or the end.
      let end = i;
      while (
        end + 1 < lines.length &&
        !(
          lines[end].trim().toLowerCase() === '</details>' ||
          (end === i && /<\/details>\s*$/i.test(lines[end]))
        ) &&
        !/^\s*<details\b/i.test(lines[end + 1])
      ) {
        end++;
      }
      const original = lines.slice(i, end + 1);
      const block = [...original];
      block[0] = details[1];
      const at = block.findIndex((l) => l.trim() !== '');
      const label = at === -1 ? '' : block[at].trim().replace(/<\/details>\s*$/i, '');
      const s = summaryBold.exec(label) ?? summaryPlain.exec(label);
      if (s) {
        /** @type {Row} */
        const row = {
          rev: 0,
          current: s[3] !== undefined,
          sha: s[1],
          prev: s[4] !== undefined && s[5] === s[1] ? s[4] : null,
          note: s[6] === undefined ? '' : lineText(s[6]),
          rows: [],
          typed: [],
        };
        for (const l of block.slice(at + 1)) {
          const t = l.trim().toLowerCase() === '</details>' ? '' : l.trim();
          if (
            t === '' ||
            TABLE_HEAD_LINE.test(t) ||
            TABLE_RULE_LINE.test(t) ||
            TABLE_EMPTY_LINE.test(t)
          ) {
            continue;
          }
          (t.startsWith('|') ? row.rows : row.typed).push(
            t.startsWith('|') ? twoCells(defusedRow(lineText(t))) : defusedRow(lineText(t)),
          );
        }
        rows.push(row);
      } else {
        // Not a revision: its opener is kept, and the lines after it are read as any are, so what
        // the opener swallowed is the same once it is defanged and no longer opens a block.
        keepLine(line);
        continue;
      }
      i = end;
      continue;
    }
    if (line.startsWith('<tr')) {
      // A row of the old HTML table runs to its `</tr>`, over lines if an author broke it, and over
      // blank lines: up to the next row or the end of its tbody or table.
      let end = i;
      let text = raw.trimEnd();
      while (
        !text.endsWith('</tr>') &&
        end + 1 < lines.length &&
        !/^\s*<(?:tr|\/?tbody|\/table)\b/i.test(lines[end + 1])
      ) {
        end++;
        text += `\n${lines[end].trimEnd()}`;
      }
      const h = text.endsWith('</tr>') ? (htmlBold.exec(text) ?? htmlPlain.exec(text)) : null;
      const more = h || !open || !text.endsWith('</tr>') ? null : MORE.exec(text);
      if (h) {
        /** @type {Row} */
        const row = {
          rev: 0,
          current: h[3] !== undefined,
          sha: h[1],
          prev: null,
          note: '',
          rows: [],
          typed: [],
        };
        // Blank lines in a cell were two paragraphs: kept as a break.
        const why = h[4]
          .trim()
          .replace(/\r\n?|[\u2028\u2029]/g, '\n')
          .replace(/\s*\n\s*\n\s*/g, '<br><br>');
        old.set(row, { what: [], why: lineText(why) });
        rows.push(row);
        open = row;
        i = end;
        continue;
      }
      if (more && open) {
        const what = lineText(more[1]);
        if (what !== '') old.get(open)?.what.push(what);
        i = end;
        continue;
      }
    }
    open = null;
    const c = line.startsWith('|') ? cells(line) : [];
    // The two-column shape: the head link opens the first cell; every cell after it is the Why
    // (a pipe in the Why is the author's text, not another column).
    const asBold = c.length >= 2 ? bold.exec(c[0]) : null;
    const lead = asBold ?? (c.length >= 2 ? plain.exec(c[0]) : null);
    /** @type {Row | null} */
    let row = null;
    if (lead && lead[2].startsWith(lead[1])) {
      row = {
        rev: 0,
        current: lead[3] !== undefined,
        sha: lead[2],
        prev: null,
        note: '',
        rows: [],
        typed: [],
      };
      // Only a row written bold has its What unbolded: a plain row's What is as typed.
      Object.assign(
        row,
        fromOld(
          markdownLines(lead[4] ?? '', asBold !== null),
          lineText(c.slice(1).join(' | ')),
          lead[2],
        ),
      );
    } else if (c.length >= 4) {
      // The old shape, Rev | Head | What changed | Why, the Why again the rest of the line.
      if (c.length > 4) c.splice(3, c.length - 3, c.slice(3).join(' | '));
      const rev = REV.exec(c[0]);
      const oldHead = rev ? head.exec(c[1]) : null;
      if (rev && oldHead && oldHead[2].startsWith(oldHead[1])) {
        row = {
          rev: Number(rev[1]),
          current: rev[2] !== undefined,
          sha: oldHead[2],
          prev: null,
          note: '',
          rows: [],
          typed: [],
        };
        Object.assign(row, fromOld(markdownLines(c[2], false), lineText(c[3]), oldHead[2]));
      }
    }
    if (row) rows.push(row);
    else keepLine(line);
  }
  for (const [row, { what, why }] of old) Object.assign(row, fromOld(what, why, row.sha));
  // A row of the new shapes has no number: it is its place from the oldest, which stays row 1
  // when a note says rows between it and the rest were left out.
  const gap = omitted + capped;
  rows.forEach((r, i) => {
    if (r.rev === 0) r.rev = gap > 0 && i === rows.length - 1 ? 1 : rows.length + gap - i;
  });
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
 * A revision's summary: the head link, a compare link when a head comes before it, the note.
 *
 * @param {Row} row
 * @param {string} repo
 */
function summaryLine(row, repo) {
  const link = `<a href="https://github.com/${repo}/commit/${row.sha}"><code>${row.sha.slice(0, 7)}</code></a>`;
  const lead = row.current ? `<b>👉 ${link}</b> (current)` : link;
  const compare = row.prev
    ? ` · <a href="https://github.com/${repo}/compare/${row.prev}...${row.sha}">compare <code>${row.prev.slice(0, 7)}…${row.sha.slice(0, 7)}</code></a>`
    : '';
  const note = lineText(row.note);
  return `<summary>${lead}${compare}${note === '' ? '' : ` · ${note}`}</summary>`;
}

/**
 * A revision's block: open for the newest (`current`), the summary, a blank line, the table (its
 * header and rule are the tool's; the rows are the author's, as written, one empty one when there is
 * none), a blank line, what else the author typed, `</details>`.
 *
 * @param {Row} row
 * @param {string} repo
 * @returns {string[]}
 */
function revisionBlock(row, repo) {
  const rows = row.rows.map((r) => twoCells(defusedRow(lineText(r)))).filter((r) => r !== '');
  const typed = row.typed.map((l) => defusedRow(lineText(l))).filter((l) => l !== '');
  return [
    row.current ? '<details open>' : '<details>',
    summaryLine(row, repo),
    '',
    TABLE_HEAD,
    TABLE_RULE,
    ...(rows.length > 0 ? rows : [PLACEHOLDER]),
    '',
    ...(typed.length > 0 ? [...typed, ''] : []),
    '</details>',
  ];
}

/**
 * The block's content: the heading (unless one stands before the block), a `<details>` for each
 * revision newest first, a note of left-out revisions, and the lines kept.
 *
 * @param {Table} table
 * @param {string} repo
 * @param {{ heading: boolean }} options
 */
export function renderTable({ rows, rest, omitted, capped = 0 }, repo, { heading }) {
  // One revision is current, the newest one that says so: the check reads the first, and one block is open.
  const newestCurrent = [...rows].sort((a, b) => b.rev - a.rev).find((r) => r.current);
  const sorted = [...rows]
    .sort((a, b) => b.rev - a.rev)
    .map((r) => (r.current && r !== newestCurrent ? { ...r, current: false } : r));
  return [
    ...(heading ? [HEADING, ''] : []),
    ...sorted.flatMap((r, i) => [...(i > 0 ? [''] : []), ...revisionBlock(r, repo)]),
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
 * What a revision's summary says of the range between two heads: its compare link's old head, and
 * the note. A plain push (`ahead`) has no note, a rewrite says from which head and how many commits
 * it dropped, and a head that can't be read (`gone`) says so, with no compare link.
 *
 * @param {object} range
 * @param {string} range.prev the old head
 * @param {'ahead' | 'rewritten' | 'gone'} range.how `ahead`: the PR grew;
 *   `rewritten`: a force-push or rebase; `gone`: the old head can't be read
 * @param {number} [range.dropped] commits the old head had that the branch no longer has
 * @returns {{ prev: string | null, note: string }}
 */
export function rangeNote({ prev, how, dropped = 0 }) {
  const old = prev.slice(0, 7);
  if (how === 'ahead') return { prev, note: '' };
  if (how === 'gone') {
    return { prev: null, note: `rewritten, the old head <code>${old}</code> is gone` };
  }
  return {
    prev,
    note: `rewritten from <code>${old}</code>${dropped > 0 ? ` (${dropped} commit${dropped === 1 ? '' : 's'} dropped)` : ''}`,
  };
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
 * The table with a revision for `head` added, and every other revision no longer current. A table
 * with no revision yet gets revision 1 for the head the PR opened at (`opened`), with the goal's
 * first sentence as the Why of its one row.
 *
 * @param {Table} table
 * @param {object} next
 * @param {string} next.head the new head, 40 hex
 * @param {string | null} next.prev the head before it, which its compare link spans
 * @param {string} next.note its note
 * @param {{ sha: string, why: string } | null} next.opened the head the PR opened at, when the table has no revision
 * @returns {Table}
 */
export function addRevision(table, { head, prev, note, opened }) {
  const rows = table.rows.map((r) => ({ ...r, current: false }));
  if (rows.length === 0 && opened) {
    rows.push({
      rev: 1,
      current: false,
      sha: opened.sha,
      prev: null,
      note: 'Opened',
      rows: opened.why === '' ? [] : [`| — | ${opened.why} |`],
      typed: [],
    });
  }
  const rev = rows.reduce((n, r) => Math.max(n, r.rev), 0) + 1;
  rows.push({ rev, current: true, sha: head, prev, note, rows: [], typed: [] });
  return { ...table, rows };
}

/**
 * The block's content held to REVISIONS_BUDGET by leaving out the oldest revisions whole, as the
 * header says; the rows of a revision that is kept are never touched.
 *
 * @param {Table} table
 * @param {string} repo
 * @param {{ heading: boolean }} options
 * @returns {string}
 */
export function budgeted(table, repo, options) {
  /** @param {Table} t */
  const text = (t) => renderTable(t, repo, options);
  let list = table;
  if (text(list).length <= REVISIONS_BUDGET) return text(list);
  const newest = Math.max(...list.rows.map((r) => r.rev));
  const middle = (/** @type {Row} */ r) => r.rev !== 1 && r.rev !== newest;
  while (text(list).length > REVISIONS_BUDGET) {
    const droppable = list.rows.filter(middle);
    if (droppable.length === 0) break;
    const oldest = droppable.reduce((a, b) => (a.rev < b.rev ? a : b));
    list = {
      ...list,
      rows: list.rows.filter((r) => r !== oldest),
      omitted: list.omitted + 1,
    };
  }
  return text(list);
}
