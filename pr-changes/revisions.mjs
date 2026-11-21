// The Revisions table of a PR's description (ci#111): once the PR has a
// revision (its head moved, by a push or a force-push), the tool writes
// `## Revisions` and a table, newest first, between `<!-- pr-changes:revisions -->`
// markers; until then it writes nothing. A row says its head, what changed
// (written here from the commits) and why (the author's to write). The
// description check (pr-template/body.mjs) reads the row whose first cell
// says `(current)` and requires the head link in it to name the PR's head.
//
//   | What changed | Why |
//   | --- | --- |
//   | **👉 [`abc1234`](https://github.com/o/r/commit/<40 hex>)** (current)<br>**[`old7…new7`](…/compare/old...new)**<br>**subject**<br>**+ 3 more** | |
//   | [`def5678`](https://github.com/o/r/commit/<40 hex>)<br>[`older…old7`](…)<br>subject | why |
//
// The current row stands out the way the Plan table's current step does: a
// pointer, and each line of its first cell bold (the Why is not: it is the
// author's, never touched, and `(current)` stays outside the bold so that the
// check reads it the same however a row was edited); older rows are plain.
// Every write puts the pointer on the newest row only, so it moves with each
// push.
//
// Two columns, the head link at the top of the first cell: on a phone a
// Rev and a Head column of their own took most of the width and squeezed What
// changed to a few characters a line (the old four-column table, `| Rev | Head
// | What changed | Why |`, with `2 (current)` in the first cell and the head
// link in the second, is still read, and is written back in the new shape by
// the next write: remove that reader once no open PR holds one). A row's
// revision number is no longer written: it is its place from the oldest
// (row 1), counted with the rows a note says were left out.
//
// The old head goes in What, never in the head link: the check tests that the
// current row's head link holds the head's first 7 characters, so an old sha
// there would pass falsely after a force-push back to it.
//
// The block is the author's to edit (a Why is meant to be), so it is parsed,
// never trusted:
//   - a row is a line starting `|` with two cells (split on unescaped pipes;
//     the Why is the rest of the line), each at most CELL_CHARS, the first
//     opening with exactly one commit link of this repo whose seven hex are the
//     sha's first seven (the current row the tool writes has it bold with the
//     pointer; a plain one, and a bold one without the pointer, are read too,
//     as pr-template/body.mjs's check reads them, from the same two patterns),
//     then an optional ` (current)`, then its What after a `<br>`; or, the old shape, four cells: a Rev 1-999999 with an
//     optional ` (current)`, a Head that is such a link, What and Why. Only
//     such a row is ever read as state (the previous head is the `(current)`
//     one, else the highest Rev);
//   - what the author typed is never destroyed: a valid row's cells are kept
//     byte for byte (only `<!--` and `-->` are made harmless, as an unclosed
//     comment would hide the end marker; the one exception is the What of a row
//     written bold, which the tool writes bold line by line on the current
//     row, so one bold layer is taken off each line on reading and put back on
//     writing, and a plain row's What is never touched; and a cell is held to
//     CELL_CHARS, as it is read: a Why, or a What that its head link, pointer and bold
//     marks would take past that, is written in the plainest form that fits and, only
//     if it still does not, cut at its end with `…`, for a longer cell is read as no row
//     at all), and any other line is kept below the table, with its `(current)` defused,
//     and a warning, cut to REST_CHARS (a line longer than a row can be, or kept so, has its
//     first `|` escaped, so that it is read as no row each time);
//   - what this module writes is from validated values only: the repo and
//     the shas, a Rev number, and commit subjects escaped by changes.mjs's
//     `escape` (a subject is a stranger's text).
//
// Size: the block is held to REVISIONS_BUDGET characters by steps, each only
// when the one before is too long: the new row's subjects (3, then 1, then none);
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

import { leadBold, leadPlain, revisionsPair } from '../pr-template/body.mjs';
import { blocks, escape, ownBlock } from './changes.mjs';

/** The most characters the Revisions block holds. */
export const REVISIONS_BUDGET = 12_000;
/** The most characters of one cell the tool reads or keeps. */
export const CELL_CHARS = 2000;
/** The most characters of a line that is no row the tool keeps, after the changes it makes to it. */
const REST_CHARS = CELL_CHARS * 4;
/** The longest line that can be a row: two cells at most, the escapes in them, and the link. */
const ROW_CHARS = CELL_CHARS * 3;

/**
 * The first n characters of a text, never ending in half of a character that takes two (an emoji
 * is two UTF-16 units: cut between them it is written as nothing readable).
 *
 * @param {string} text
 * @param {number} n
 */
const startOf = (text, n) => {
  if (text.length <= n) return text;
  const cut = text.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};

/**
 * A text of at most n characters: the text itself, or, when it is longer, its start with `…`, cut at a
 * whole code point (a combining mark or a joiner after the cut may still be lost from the letter before it) and
 * not ending in a space, as a cell is trimmed when it is read. A text cut this way is cut no further
 * the next time, which is what keeps a table the same on every write.
 *
 * @param {string} text
 * @param {number} n
 */
function cutAt(text, n) {
  if (text.length <= n) return text;
  return `${startOf(text, n - 1).trimEnd()}…`;
}

/**
 * Text cut to a cell: a cell is read at most CELL_CHARS long, so a cell written longer would be read
 * as no row at all.
 *
 * @param {string} text
 */
const fitCell = (text) => cutAt(text, CELL_CHARS);
/**
 * The most commit subjects the current row lists, and an older row of a rebuilt
 * table, before "+ N more" (the row's compare link covers the rest), and the
 * longest a subject is. On a phone the table is two columns of a few words: a
 * row of five 72-character subjects was most of a screen. These also keep a
 * row's first cell, the head link, the range, the subjects and the bold marks,
 * under CELL_CHARS however a subject is escaped (a subject of `&` is five times
 * as long written): 3 x 56 x 5 is 840, with about 400 for the rest.
 */
export const SUBJECTS = 3;
export const OLDER_SUBJECTS = 2;
const SUBJECT_CHARS = 56;
/** The most characters of the goal's first sentence, which row 1's Why copies. */
const WHY_CHARS = 200;

const HEADING = '## Revisions';
const HEADER = '| What changed | Why |';
const SEPARATOR = '| --- | --- |';
const REV = /^([1-9]\d{0,5})( \(current\))?$/;
const OMITTED = /^_(\d{1,6}) earlier revisions? left out to stay under GitHub's limit\._$/;
const CAPPED =
  /^_(\d{1,6}) earlier heads? (?:is|are) not listed: the table keeps the first head and the latest ones\._$/;
const CUT = 'older revision: its commits are cut to keep this table short';

/**
 * One valid row of the table.
 *
 * @typedef {object} Row
 * @property {number} rev its place from the oldest, 1 up (read from an old table's Rev cell, else counted)
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
 * A What cell as the tool wrote it for the current row (each `<br>`-separated
 * line bold) back to the plain text it holds, one bold layer taken off each
 * line. What the tool writes is escaped, so a line it wrote never starts and
 * ends with an unescaped `**` of its own.
 *
 * @param {string} what
 */
function unbold(what) {
  return what
    .split('<br>')
    .map((l) => (/^\*\*[\s\S]+\*\*$/.test(l) && l.length > 4 ? l.slice(2, -2) : l))
    .join('<br>');
}

/**
 * A What cell for the current row: each `<br>`-separated line bold.
 *
 * @param {string} what
 */
const emphasised = (what) =>
  what
    .split('<br>')
    .map((l) => (l.trim() === '' ? l : `**${l.trim()}**`))
    .join('<br>');

/**
 * Reads the block's content (what is between its markers).
 *
 * @param {string} inner
 * @param {string} repo `owner/name`: a Head link must point here
 * @returns {Table}
 */
export function parseTable(inner, repo) {
  // The repo goes into a pattern: every character a pattern reads is escaped, the backslash with them.
  const where = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const link = `\\[\`([0-9a-f]{7})\`\\]\\(https://github\\.com/${where}/commit/([0-9a-f]{40})\\)`;
  // The old shape's Head cell is the link alone; the new shape's first cell opens with it: bold,
  // with a pointer, on the current row, plain on an older one, either way read.
  const head = new RegExp(`^${link}$`);
  const tail = '( \\(current\\))?(?:<br>([\\s\\S]*))?$';
  const bold = new RegExp(`^${leadBold(link)}${tail}`);
  const plain = new RegExp(`^${leadPlain(link)}${tail}`);
  /** @type {Row[]} */
  const rows = [];
  /** @type {string[]} */
  const rest = [];
  let omitted = 0;
  let capped = 0;
  for (const raw of inner.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line === HEADING || /^\|\s*(?:Rev|What changed)\s*\|/.test(line)) continue;
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
    // A line longer than any row can be is no row, however its cells split. It is kept cut (and a cut
    // line's cells can shrink to a row's size), and kept longer than a row can be it is read again
    // as it was: so a line that is, or is kept, longer than a row has its first `|` escaped, and
    // read again it starts with a backslash, no row either.
    const tooLong = line.length > ROW_CHARS;
    const c = line.startsWith('|') && !tooLong ? cells(line) : [];
    const small = c.every((x) => x.length <= CELL_CHARS);
    // The new shape: the head link opens the first cell; every cell after it is the Why
    // (pipes in the Why are the author's text, not more columns: they are put back escaped,
    // so the row stays a row when it is written).
    const asBold = c.length >= 2 && small ? bold.exec(c[0]) : null;
    const first = asBold ?? (c.length >= 2 && small ? plain.exec(c[0]) : null);
    /** @type {Row | null} */
    let row = null;
    if (first && first[2].startsWith(first[1])) {
      row = {
        rev: 0,
        current: first[3] !== undefined,
        sha: first[2],
        // Only a row written bold has its What unbolded: a plain row's What is as typed.
        what: inert(asBold ? unbold(first[4] ?? '') : (first[4] ?? '')),
        why: fitCell(inert(c.slice(1).join(' \\| ').trim())),
      };
    } else if (c.length >= 4 && small) {
      // The old shape, Rev | Head | What changed | Why, the Why again the rest of the line.
      if (c.length > 4) c.splice(3, c.length - 3, c.slice(3).join(' \\| '));
      const rev = REV.exec(c[0]);
      const old = rev ? head.exec(c[1]) : null;
      if (rev && old && old[2].startsWith(old[1])) {
        row = {
          rev: Number(rev[1]),
          current: rev[2] !== undefined,
          sha: old[2],
          what: inert(c[2]),
          why: fitCell(inert(c[3].trim())),
        };
      }
    }
    if (row) {
      rows.push(row);
    } else {
      // Cut after the changes (`<!--` and `(current)` grow), and cut at the end of text: a line already cut,
      // and read again with its spaces taken off, is then cut no further.
      const kept = cutAt(
        inert(startOf(line, REST_CHARS + 1)).replace(/\(current\)/g, '(current\u200b)'),
        REST_CHARS,
      );
      rest.push(
        line.startsWith('|') && (tooLong || kept.length > ROW_CHARS)
          ? cutAt(`\\${kept}`, REST_CHARS)
          : kept,
      );
    }
  }
  // A row of the new shape has no number: it is its place from the oldest, which stays row 1
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
 * A row's first cell: the head link, then its What after a `<br>`. It is written the way the row
 * reads best that fits CELL_CHARS, for a longer cell would be read as no row at all: the current
 * row bold with the pointer and its What bold line by line; else the link plain with ` (current)`
 * and its What as it is (still the current row, to the check and to the next read, but without the
 * pointer); and a What too long even then (one an author typed, or one a four-column table held
 * whole) cut at its end, with `…`. A cell is trimmed when it is read, so a current row's What that ends in spaces (a bold
 * `** **` is read back as one space, and so is a last line of bold spaces) is written trimmed, and a
 * What of spaces alone is no What; an older row's What is as a cell was read, already trimmed.
 *
 * @param {Row} row
 * @param {string} link
 */
function firstCell(row, link) {
  const text = row.current ? row.what.trimEnd() : row.what;
  const plain = (/** @type {string} */ x) => x;
  /** @type {[string, (x: string) => string][]} */
  const forms = row.current
    ? [
        [`**👉 ${link}** (current)`, emphasised],
        [`${link} (current)`, plain],
      ]
    : [[link, plain]];
  /** The first form in which a What fits the cell, or null. */
  const fit = (/** @type {string} */ what) => {
    for (const [lead, format] of forms) {
      const cell = what === '' ? lead : `${lead}<br>${format(what)}`;
      if (cell.length <= CELL_CHARS) return cell;
    }
    return null;
  };
  const whole = fit(text);
  if (whole !== null) return whole;
  // Cut to what the plainest form holds, then written in the first form the cut What fits (bold lines
  // are trimmed, so it may fit bold): the same What is then written the same way the next time.
  const lead = forms[forms.length - 1][0];
  const cut = cutAt(text, CELL_CHARS - lead.length - '<br>'.length);
  return fit(cut) ?? `${lead}<br>${cut}`;
}

/**
 * @param {Row} row
 * @param {string} repo
 */
const rowLine = (row, repo) => {
  const link = `[\`${row.sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${row.sha})`;
  return `| ${firstCell(row, link)} | ${row.why} |`;
};

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
 * @param {number} [subjects] how many subjects to list
 * @returns {string}
 */
export function describeRange(range, subjects = SUBJECTS) {
  const { repo, prev, head, how, commits, dropped = 0 } = range;
  const old = prev.slice(0, 7);
  const now = head.slice(0, 7);
  const lead =
    how === 'ahead'
      ? `[\`${old}…${now}\`](https://github.com/${repo}/compare/${prev}...${head})`
      : how === 'gone'
        ? `rewritten, the old head \`${old}\` is gone`
        : `rewritten from \`${old}\`${dropped > 0 ? ` (${dropped} commit${dropped === 1 ? '' : 's'} dropped)` : ''}`;
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
  for (const n of [1, 0]) {
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
