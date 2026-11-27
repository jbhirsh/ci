// Whether a PR's description is in the shared shape (ci#79), in every app. The master is `.github/pull_request_template.md`;
// structure.mjs checks a template against it, and this reads a description the
// author, or a tool, has written from it. Shape only, never the words: a
// description passes with any text in its sections, and a Revisions cell needs
// only to hold some.
//
// What it requires, in what a reader sees (code, HTML comments and the
// blocks other tools keep between their markers are not read, so a heading
// quoted in a fence or a table a tool wrote counts for nothing):
//   - the headings Goal (or Problem) and Changes, each once, in the template's
//     order, with Plan (or Solution) after Goal, and Checklist and Revisions
//     after Changes where a PR has them: all three are optional (Plan for a PR
//     that is not a step of a plan, Revisions until the PR has a revision, a
//     push after it opened; ci#111 has the changes tool write it then);
//   - words under Goal or Problem that say `Closes #N` or `Part of #N` (or a
//     link to the issue), or that there is no issue;
//   - under a Problem (a bug fix), an `**Example**` paragraph, there or under
//     one of its changes;
//   - under a Plan, the template's HTML table, each step its own `<tbody>` and
//     only this PR's starting with an empty `<tr></tr>`, so that GitHub shades
//     only this PR's row (a Markdown table shades every other row);
//   - under Changes, at least one change, each with its commit: a commit link,
//     or the `pr-changes:change:N` pair the changes tool has filled (an empty
//     pair is not a commit, only the place the tool writes it). A change is
//     its pair, whose title line the tool writes (`**N. subject** [sha](link)`),
//     with the author's why in bullets under it; a description from before
//     has a numbered heading `### 1. The change` above each pair, and keeps
//     passing as long as it has one (a heading marks a change, and the pair
//     under it is its commit);
//   - Revisions' current revision naming the PR's head, when the head is given: a
//     push makes it stale, and the check fails until it is updated (a
//     description with no current revision passes). The current revision is the
//     `<details>` whose `<summary>` opens with the head link, bold with a
//     pointer, then `(current)` (`<summary><b>👉 <a href="…/commit/<sha>"><code>abc1234</code></a></b>
//     (current) · …</summary>`): only the summary decides which revision is
//     current, never the table under it, which the author writes (a row that
//     says `(current)` is of no concern). Then, in that revision only, when it
//     is a `<details>` block naming the head, its rows (up to a line that is
//     `</details>` alone, the next `<details>` or the pair's end marker) must
//     include one with letters or digits in both cells (comments, tags and
//     entities aside) and none with only one: the tool's empty placeholder fails
//     until the author fills it (ci#140). Older revisions, and the older shapes
//     below, are never judged. The shapes earlier PRs hold are read too: the
//     HTML table whose first cell of a row opens the same way
//     (`<tr><td …><b>👉 <a href="…"><code>abc1234</code></a></b> (current)</td>…`),
//     the two-column Markdown table (`| **👉 [`abc1234`](…)** (current)<br>…`), and
//     the old four-column one, whose Rev cell says `(current)` and whose next cell
//     is the head link. A head that is plain or lacks the pointer is read the same.
//     It reads the raw description, fenced code aside, since the block sits in a
//     tool's markers; the tool must write it with a person's token, or its edit
//     starts no new run of this check.
//   - Revisions' marker pair, once a push has moved the PR's head: a
//     description without `<!-- pr-changes:revisions -->` and its closing
//     marker never gets a table, silently, since the changes tool writes only
//     inside them. The event is the proof of a second head: a push
//     (`synchronize`), not a PR's commit count (a PR opened with several
//     commits, or edited, reopened or marked ready, has had one head). A
//     marker is the whole of its line and outside fenced code (`revisionsPair`:
//     the tool counts them the same way, so the two agree). On a push the
//     tool puts a missing pair back and writes the row, and the edit it makes
//     starts a run that supersedes this one; a push whose description has the
//     pair but no current row yet is red the same way a stale row is, until the
//     tool's edit; then red until the author fills the new revision's row (a
//     fork's author adds the revision and its row by hand);
//   - none of the template's own placeholders left in: the sample change
//     heading, its "Why this change." line, the plan table's empty row;
//   - no `No visible UI change` box, which this template doesn't have.
// Text after Revisions is fine: visual review's fingerprint goes at the very
// end. A GIF or a screen is not: pictureProblems holds the blocks the tools
// write (`pr-gif:<scenario>`, `describe:visual-review:<screen>`) to a place
// under a change, and to what a failed upload leaves: a GIF that is still a
// local path, a recording the tool marked stale, a marker pair twice.
//
// Pure: a description in, what is wrong with it out. check-body.mjs decides
// which PRs this holds (not a closed PR, Dependabot's, a bot's).

import { HEADINGS } from './structure.mjs';

/** A tool's marker alone on its line: `<!-- x:y -->`, and `<!-- /x:y -->` ends its block. */
const TOOL_START = /^ *<!-- ([a-z][a-z0-9-]*:[^\s<>]+) -->\s*$/;
/** The headings a description may leave out, by their first name. */
const OPTIONAL = ['Plan', 'Checklist', 'Revisions'];
/** The goal's last words: an issue it closes or is part of, or that there is none. */
const ISSUE =
  /\b(?:closes|part of)\s+\[?(?:(?:[\w.-]{1,100}\/[\w.-]{1,100})?#\d+|https?:\/\/\S{1,200}\/issues\/\d+)|\bno issues?\b/i;
/** A bug fix's example: a bold paragraph, as the template says. */
const EXAMPLE = /^ {0,3}\*\*Example:?\*\*/m;
/**
 * How a Revisions row's first cell opens, with the head link `link` (a pattern
 * source that captures nothing but the link's own groups): the current row is
 * bold with a pointer, an older row plain, and a row an author took the pointer
 * or the bold off is read the same. The tool's parser (pr-changes/revisions.mjs)
 * and the check below build their patterns from these two (and `htmlLink` with
 * `htmlLeadBold` and `htmlLeadPlain` for the HTML table), so they accept the
 * same forms.
 *
 * @param {string} link
 */
export const leadBold = (link) => `\\*\\*(?:👉 )?${link}\\*\\*`;
/** @param {string} link */
export const leadPlain = (link) => link;
/**
 * The head link of the HTML table, a pattern source for `where`, the pattern of
 * `owner/name` (the parser's is its repo, escaped; the check's any repo): the
 * commit link around the sha's first seven characters in code. Group 1 is the
 * whole sha, group 2 its first seven, which the link text must repeat, so a
 * pattern holds it once: the bold and the plain lead below are two patterns.
 *
 * @param {string} where
 */
export const htmlLink = (where) =>
  `<a href="https://github\\.com/${where}/commit/(([0-9a-f]{7})[0-9a-f]{33})"><code>\\2</code></a>`;
/** @param {string} link */
export const htmlLeadBold = (link) => `<b>(?:👉 )?${link}</b>`;
/** @param {string} link */
export const htmlLeadPlain = (link) => link;
/** A head link to a GitHub commit whose sha opens with the seven characters shown, capturing them. */
const ANY_LINK =
  '\\[`([0-9a-f]{7})`\\]\\(https://github\\.com/[\\w.-]+/[\\w.-]+/commit/\\1[0-9a-f]{33}\\)';
/** Revisions' current row, as the tool wrote it in the two-column Markdown table (bold, with the pointer) or plain: the head link opens its first cell, then `(current)`. */
const CURRENT_BOLD = new RegExp(`^\\|[ \\t]*${leadBold(ANY_LINK)} \\(current\\)`, 'm');
const CURRENT_PLAIN = new RegExp(`^\\|[ \\t]*${leadPlain(ANY_LINK)} \\(current\\)`, 'm');
/** The same in a revision's summary: `<summary>` opens it (alone on its line, or after the `<details>` tag), the head link is its first thing, then `(current)`. */
const SUMMARY_ROW = String.raw`^[ \t]*(?:<details\b[^>]*>\s*)?<summary>\s*`;
/** The same in the HTML table of an earlier PR: the row opens `<tr><td …>`, the head link is the cell's first thing, then `(current)`. */
const HTML_ROW = String.raw`^[ \t]*<tr><td\b[^>]*>[ \t]*`;
const HTML_ANY = htmlLink('[\\w.-]+/[\\w.-]+');
const CURRENT_HTML_BOLD = new RegExp(`${HTML_ROW}${htmlLeadBold(HTML_ANY)}\\s*\\(current\\)`, 'm');
const CURRENT_HTML_PLAIN = new RegExp(
  `${HTML_ROW}${htmlLeadPlain(HTML_ANY)}\\s*\\(current\\)`,
  'm',
);
const CURRENT_SUMMARY_BOLD = new RegExp(
  `${SUMMARY_ROW}${htmlLeadBold(HTML_ANY)}\\s*\\(current\\)`,
  'm',
);
const CURRENT_SUMMARY_PLAIN = new RegExp(
  `${SUMMARY_ROW}${htmlLeadPlain(HTML_ANY)}\\s*\\(current\\)`,
  'm',
);
/** The same row in the table's old shape: its Rev cell (no link in it) says `(current)`; the next cell is its head. As it always was: whatever the Head cell holds, `currentHead` compares it with the head. */
const CURRENT_ROW_OLD = /^\|[^|\n[]*\(current\)[^|\n[]*\|([^|\n]*)\|/m;

/**
 * The description with what the TOOL writes under a revision's summary taken out: a closed
 * `<details>` whose `<summary>` opens with a head link of the tool's form, up to its `</details>`.
 * The table an author fills there is never read as a current row, whatever its rows say. Nothing an
 * author typed is taken out: a `<details>` that is never closed, or whose summary isn't the tool's,
 * stays, so a row of an old table after it is read as it always was.
 *
 * `back` turns a position in what is left into the same position in `text`, so that the current
 * revision found here can have its rows read where they are.
 *
 * @param {string} text
 * @returns {{ text: string, back: (at: number) => number }}
 */
function withoutTables(text) {
  /** @type {{ at: number, length: number }[][]} each pass's cuts, where each is in what the pass left */
  const passes = [];
  // One pattern for each lead: the link's back-reference counts groups from its own start.
  const left = [htmlLeadBold(HTML_ANY), htmlLeadPlain(HTML_ANY)].reduce((t, lead) => {
    /** @type {{ at: number, length: number }[]} */
    const cuts = [];
    let gone = 0;
    const next = t.replace(
      new RegExp(
        String.raw`<details\b[^>]*>\s*<summary>\s*${lead}[^\n]*?</summary>[\s\S]*?</details>`,
        'gi',
      ),
      // Keep up to the summary's end: no capture group of its own, which would shift the link's back-reference.
      (m, ...rest) => {
        const keep = m.indexOf('</summary>') + '</summary>'.length;
        cuts.push({
          at: /** @type {number} */ (rest.at(-2)) - gone + keep,
          length: m.length - keep,
        });
        gone += m.length - keep;
        return m.slice(0, keep);
      },
    );
    passes.push(cuts);
    return next;
  }, text);
  return {
    text: left,
    back: (at) =>
      passes.reduceRight(
        (pos, cuts) => pos + cuts.filter((c) => c.at <= pos).reduce((n, c) => n + c.length, 0),
        at,
      ),
  };
}

/**
 * Revisions' current revision: the text of its row or summary that names its
 * head (the first of any shape), and, when it is a `<details>` block (the
 * shape since ci#132) whose summary closes on its line, the rows of its table
 * (`revisionRows`); null when the table has no current row.
 *
 * @param {string} description the description, fenced code aside
 * @returns {{ head: string, rows: string[] | null } | null}
 */
function currentRevision(description) {
  const { text, back } = withoutTables(description);
  /** @type {{ index: number, head: string, summary?: number }[]} */
  const found = [];
  for (const re of [CURRENT_BOLD, CURRENT_PLAIN]) {
    const m = re.exec(text);
    if (m) found.push({ index: m.index, head: m[1] });
  }
  for (const re of [CURRENT_HTML_BOLD, CURRENT_HTML_PLAIN]) {
    const m = re.exec(text);
    if (m) found.push({ index: m.index, head: m[2] });
  }
  for (const re of [CURRENT_SUMMARY_BOLD, CURRENT_SUMMARY_PLAIN]) {
    const m = re.exec(text);
    // The summary's own tag: the head link after it holds no `<summary>`, so it is the last one.
    if (m)
      found.push({ index: m.index, head: m[2], summary: m.index + m[0].lastIndexOf('<summary>') });
  }
  const old = CURRENT_ROW_OLD.exec(text);
  if (old) found.push({ index: old.index, head: old[1] });
  if (found.length === 0) return null;
  const first = found.reduce((a, b) => (b.index < a.index ? b : a));
  return {
    head: first.head,
    rows: first.summary === undefined ? null : revisionRows(description, back(first.summary)),
  };
}

/**
 * The text of Revisions' current row that names its head, or null.
 *
 * @param {string} description the description, fenced code aside
 */
const currentHead = (description) => currentRevision(description)?.head ?? null;

/** The header, the rule and the empty row of a revision's table, the frame the changes tool writes (a trimmed line): not rows the author wrote. pr-changes/revisions.mjs reads the frame with these too. */
export const TABLE_HEAD_LINE = /^\|\s*What changed\s*\|\s*Why\s*\|$/i;
export const TABLE_RULE_LINE = /^\|(?:\s*:?-{3,}:?\s*\|)+$/;
export const TABLE_EMPTY_LINE = /^\|(?:\s*\|)+$/;
/** The revisions end marker, alone on a trimmed line. */
const REVISIONS_END_ALONE = /^<!-- \/pr-changes:revisions -->$/;

/** A line that ends a revision's block for the changes tool (a trimmed line): `</details>` alone, the next `<details>`, or the end marker. */
const blockEnds = (/** @type {string} */ row) =>
  row.toLowerCase() === '</details>' || /^<details\b/i.test(row) || REVISIONS_END_ALONE.test(row);

/**
 * The rows of the revision whose `<summary>` is at `at`, as the changes tool reads them: the
 * trimmed lines after the line that closes the summary that start with `|`, but for the frame, up
 * to a line that ends the block (`blockEnds`, so a `</details>` in a row's code span ends nothing).
 * A line in an HTML comment block (from a line that opens with `<!--` to the line holding `-->`)
 * is not read, as a reader doesn't see it. A summary on its `<details>` line that ends with
 * `</details>` is a block of one line, with no rows, as the tool reads it. Null when the summary
 * never closes before the block ends: not a block.
 *
 * @param {string} text the description, fenced code aside
 * @param {number} at
 * @returns {string[] | null}
 */
function revisionRows(text, at) {
  const from = text.lastIndexOf('\n', at - 1) + 1;
  const lines = text.slice(from).split('\n');
  // The summary may wrap: its rows start after the line that closes it.
  let close = 0;
  while (!/<\/summary>/i.test(close === 0 ? lines[0].slice(at - from) : lines[close])) {
    close++;
    if (close === lines.length || blockEnds(lines[close].trim())) return null;
  }
  if (close === 0 && /^\s*<details\b/i.test(lines[0]) && /<\/details>\s*$/i.test(lines[0]))
    return [];
  /** @type {string[]} */
  const rows = [];
  let comment = false;
  for (const raw of lines.slice(close + 1)) {
    const row = raw.trim();
    if (blockEnds(row)) break;
    if (comment || row.startsWith('<!--')) {
      // A comment block ends on the line that holds its `-->`, which is the comment's too.
      comment = !row.includes('-->', comment ? 0 : 4);
      continue;
    }
    if (
      row.startsWith('|') &&
      !TABLE_HEAD_LINE.test(row) &&
      !TABLE_RULE_LINE.test(row) &&
      !TABLE_EMPTY_LINE.test(row)
    ) {
      rows.push(row);
    }
  }
  return rows;
}

/** A letter or a digit, of any script. */
const LETTER = /[\p{L}\p{N}]/u;

/**
 * Whether a cell of a revision's table holds text, as a reader sees it: a letter or a digit, of
 * any script, once its HTML comments, tags and entities are taken out, or in a code span, whose
 * text is shown as it is (`` `<br>` `` is text). A dash, `<br>`, `&nbsp;`, `<!-- why -->` or an
 * emoji alone is empty; `` `x` ``, `n/a` and `修正` are text. So is an entity for a letter
 * (`&#65;`), an autolink or an `<img>` alone empty: rows are for words. Whichever opens first
 * wins, as in Markdown. A pass along the cell, with no pattern that backtracks: once no `>` (or
 * `-->`) is left, a `<` is only text.
 *
 * @param {string} cell
 */
export function holdsText(cell) {
  let out = '';
  let code = '';
  let tags = true;
  let comments = true;
  for (let i = 0; i < cell.length;) {
    if (cell[i] === '`') {
      let n = 0;
      while (cell[i + n] === '`') n++;
      const end = findRun(cell, i + n, n);
      if (end !== -1) {
        code += cell.slice(i + n, end);
        i = end + n;
      } else {
        out += cell.slice(i, i + n);
        i += n;
      }
      continue;
    }
    if (comments && cell.startsWith('<!--', i)) {
      const end = cell.indexOf('-->', i + 4);
      if (end !== -1) {
        i = end + 3;
        continue;
      }
      comments = false;
    }
    if (tags && cell[i] === '<' && /[A-Za-z/!?]/.test(cell[i + 1] ?? '')) {
      const end = cell.indexOf('>', i + 1);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
      tags = false;
    }
    out += cell[i++];
  }
  return (
    LETTER.test(code) ||
    LETTER.test(out.replace(/&(?:#\d{1,7}|#x[\da-f]{1,6}|[a-z][a-z\d]{1,31});/gi, ''))
  );
}

/**
 * A row's two cells, What changed and Why, split at each `|` not written `\|`, as GitHub reads
 * them: a cell after the second is not shown, and a missing one is empty.
 *
 * @param {string} row a trimmed line starting `|`
 * @returns {[string, string]}
 */
const rowCells = (row) => {
  const parts = row.split(/(?<!\\)\|/);
  return [parts[1] ?? '', parts[2] ?? ''];
};

/**
 * What is wrong with the rows of the current revision, which names `head`: none has both cells
 * filled, or one has only one (ci#140). A row with neither filled, beside a filled one, is no
 * concern.
 *
 * @param {string[]} rows the revision's rows, its table's frame aside
 * @param {string} head the PR's head sha
 * @returns {string[]}
 */
export function revisionRowProblems(rows, head) {
  const sha = head.slice(0, 7);
  const filled = rows.map((row) => rowCells(row).map(holdsText));
  if (!filled.some(([what, why]) => what && why)) {
    return [
      `fill Revisions' current revision, \`${sha}\`: its table has no row with both cells filled. In the description, write one row for each change this push made, both cells in plain words, such as \`| The cap fails closed | It's the only paid API |\` (each row opens with \`|\`; write a pipe in a cell as \`\\|\`). Do it once this push's \`PR changes\` run has ended: a run still going can write an older copy over your edit`,
    ];
  }
  const half = filled.filter(([what, why]) => what !== why).length;
  if (half > 0) {
    return [
      `fill both cells of every row in Revisions' current revision, \`${sha}\`: ${half === 1 ? '1 row has' : `${half} rows have`} an empty What changed or Why`,
    ];
  }
  return [];
}
/** A change's commit, as a link a reader sees. */
const COMMIT = /\/commit\/[0-9a-f]{7,40}/;
/** A change's slot, the pair the changes tool fills with its commit and files. */
const CHANGE_SLOT = /^pr-changes:change:\d+$/;
/** What the template's example change says. */
const SAMPLE_HEADING = /^The first change, as a goal\b/i;
const SAMPLE_WHY = /^\s*(?:[-*]|\d+\.)?\s*Why this change\.\s*$/im;
/**
 * The plan table's template row: this PR's row with the "What" cell empty,
 * as the HTML table the template has now, or the Markdown one it had.
 */
const SAMPLE_ROW = /<td>\s*<b>\s*<\/b>\s*<\/td>|^\|[^|\n]*\|\s*\*\*this PR\*\*\s*\|\s*\|/im;
const BOX = /\[[ xX]\]\s*No visible UI change/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The revisions marker pair: each marker is the whole of its line (spaces aside), a line ending allowed. */
const REVISIONS_END = '<!-- /pr-changes:revisions -->';
const REVISIONS_START_LINE = /^([ \t]*)<!-- pr-changes:revisions -->[ \t]*\r?$/gm;
const REVISIONS_END_LINE = /^([ \t]*)<!-- \/pr-changes:revisions -->[ \t]*\r?$/gm;

/**
 * The description with every line of fenced code blanked and the rest kept as
 * it was, line endings and offsets included, so a position found in it is a
 * position in the description (CRLF too: a `\r` stays).
 *
 * @param {string} body
 */
export function maskFences(body) {
  const lines = body.split('\n');
  /** @type {string[]} */
  const out = [];
  const blank = (/** @type {string} */ line) => line.replace(/[^\r]/g, ' ');
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE.exec(lines[i]);
    if (!fence) {
      out.push(lines[i]);
      continue;
    }
    // The closing fence: its own character, at least as long, nothing after it. No
    // pattern is built from the opening fence, so nothing in a description is ever
    // read as part of one.
    const closes = (/** @type {string} */ line) => {
      const m = /^ {0,3}(`{3,}|~{3,}) *\r?$/.exec(line);
      return m !== null && m[1][0] === fence[1][0] && m[1].length >= fence[1].length;
    };
    out.push(blank(lines[i]));
    i++;
    while (i < lines.length && !closes(lines[i])) out.push(blank(lines[i++]));
    if (i < lines.length) out.push(blank(lines[i]));
  }
  return out.join('\n');
}

/**
 * Where the revisions marker pair is in a description, as the changes tool
 * and the description check both read it, so that they agree: a marker is the
 * whole of its line (spaces aside) and outside fenced code; a marker quoted
 * in a sentence or shown in a fence is no marker. `at` is the pair, from its
 * start marker to the end of its end marker, when there is exactly one of
 * each in that order, else null (none, or torn or repeated).
 *
 * @param {string} body
 * @returns {{ starts: number[], ends: number[], at: { from: number, to: number } | null }}
 */
export function revisionsPair(body) {
  const masked = maskFences(body);
  /** @param {RegExp} line */
  const find = (line) =>
    [...masked.matchAll(line)].map((m) => /** @type {number} */ (m.index) + m[1].length);
  const starts = find(REVISIONS_START_LINE);
  const ends = find(REVISIONS_END_LINE);
  const clean = starts.length === 1 && ends.length === 1 && starts[0] < ends[0];
  return {
    starts,
    ends,
    at: clean ? { from: starts[0], to: ends[0] + REVISIONS_END.length } : null,
  };
}

/**
 * A description without its fenced code, and nothing else taken out: the
 * Revisions table is inside a tool's block, which renderedLines drops, and
 * its cells hold code spans, which it strips.
 *
 * @param {string | null | undefined} body
 */
function withoutFences(body) {
  const lines = (body ?? '').replace(/\r\n?/g, '\n').split('\n');
  /** @type {string[]} */
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE.exec(lines[i]);
    if (!fence) {
      kept.push(lines[i]);
      continue;
    }
    const closing = new RegExp(`^ {0,3}\\${fence[1][0]}{${fence[1].length},} *$`);
    i++;
    while (i < lines.length && !closing.test(lines[i])) i++;
  }
  return kept.join('\n');
}

/**
 * What a reader sees of a description, as lines: line endings made `\n`;
 * fenced code, HTML comment blocks and the blocks other tools keep between
 * their markers gone, as GitHub's renderer reads blocks (a fence closes with
 * its own character, at least as long; an unclosed fence or a comment that
 * starts a line and never ends runs to the end); and, in what is left, code
 * spans (equal runs of backticks, within one paragraph; a lone backtick is
 * text) and inline comments (an unclosed `<!--` mid-line is text). A line
 * at a time, so nothing backtracks.
 *
 * With `keepTools`, a tool's block stays as one `@@tool:<key>@@` line, so a
 * check can tell a slot is there without reading what a tool wrote in it.
 *
 * @param {string | null | undefined} body
 * `onBlock` hears each complete tool block as it is skipped: its key, the
 * lines between its markers, as written, and the line it stands at.
 *
 * @param {{ keepTools?: boolean, onBlock?: (key: string, inner: string[], at: number) => void }} [options]
 * @returns {string[]}
 */
export function renderedLines(body, { keepTools = false, onBlock } = {}) {
  const lines = (body ?? '').replace(/\r\n?/g, '\n').split('\n');
  /** @type {string[]} */
  const kept = [];
  /** @type {((key: string, after: number) => number) | undefined} */
  let endOf;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const [mark] = fence[1];
      const closing = new RegExp(`^ {0,3}\\${mark}{${fence[1].length},} *$`);
      i++;
      while (i < lines.length && !closing.test(lines[i])) i++;
      kept.push('');
      continue;
    }
    const tool = TOOL_START.exec(line);
    if (tool) {
      endOf ??= endMarkers(lines);
      const j = endOf(tool[1], i);
      if (j < lines.length) {
        onBlock?.(tool[1], lines.slice(i + 1, j), kept.length);
        i = j;
        kept.push(keepTools ? `@@tool:${tool[1]}@@` : '');
        continue;
      }
    }
    if (/^ {0,3}<!--/.test(line)) {
      let j = i;
      while (j < lines.length && !lines[j].includes('-->', j === i ? line.indexOf('<!--') + 4 : 0))
        j++;
      const rest =
        j < lines.length
          ? lines[j].slice(lines[j].indexOf('-->', j === i ? line.indexOf('<!--') + 4 : 0) + 3)
          : '';
      i = j;
      kept.push(rest);
      continue;
    }
    // A literal marker typed by hand is only text.
    kept.push(keepTools ? line.replaceAll('@@', '@ @') : line);
  }
  return inline(kept);
}

/**
 * Where each line that may end a tool's block is, read once: the first line after `after` that is
 * the end marker of `key`, `<!-- /key -->` (spaces aside), or `lines.length` when none is, and in a
 * fence too, as a scan from the start marker would find it. Each start marker scanning the lines after it was quadratic on a body of
 * unclosed ones (`'<!-- x:y -->\n'.repeat(5000)`, ci#157); `after` only grows between calls, so
 * each end's list is read once in all.
 *
 * @param {string[]} lines
 * @returns {(key: string, after: number) => number}
 */
function endMarkers(lines) {
  // Every end marker opens so, and only its key and its close follow: `end` below.
  const open = '<!-- /';
  const end = (/** @type {string} */ key) => `${open}${key} -->`;
  /** @type {Map<string, { at: number[], next: number }>} */
  const ends = new Map();
  lines.forEach((line, n) => {
    const text = line.trim();
    if (!text.startsWith(open)) return;
    const found = ends.get(text);
    if (found) found.at.push(n);
    else ends.set(text, { at: [n], next: 0 });
  });
  return (key, after) => {
    const found = ends.get(end(key));
    if (!found) return lines.length;
    while (found.next < found.at.length && found.at[found.next] <= after) found.next++;
    return found.at[found.next] ?? lines.length;
  };
}

/**
 * Code spans and inline comments gone, a paragraph (lines up to a blank one)
 * at a time.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function inline(lines) {
  /** @type {string[]} */
  const out = [];
  let start = 0;
  for (let i = 0; i <= lines.length; i++) {
    // A tool's marker line ends a paragraph, as the blank line it stands for does.
    const marker = i < lines.length && lines[i].startsWith('@@tool:');
    if (i < lines.length && lines[i].trim() !== '' && !marker) continue;
    const paragraph = lines.slice(start, i);
    out.push(...(paragraph.length ? withoutSpans(paragraph) : []));
    if (i < lines.length) out.push(marker ? lines[i] : '');
    start = i + 1;
  }
  return out;
}

/**
 * A paragraph's lines with its code spans and closed comments removed
 * (newlines kept, so line numbers hold).
 *
 * @param {string[]} paragraph
 * @returns {string[]}
 */
function withoutSpans(paragraph) {
  const text = paragraph.join('\n');
  let out = '';
  // Once no `-->` is left after an unclosed `<!--`, none is after a later one: searching again from
  // each was quadratic on a paragraph of them (ci#157).
  let unclosed = false;
  for (let at = 0; at < text.length;) {
    if (text[at] === '`') {
      let n = 0;
      while (text[at + n] === '`') n++;
      const close = findRun(text, at + n, n);
      if (close === -1) {
        out += text.slice(at, at + n);
        at += n;
      } else {
        out += text.slice(at, close + n).replace(/[^\n]/g, '');
        at = close + n;
      }
    } else if (text.startsWith('<!--', at)) {
      const end = unclosed ? -1 : text.indexOf('-->', at + 4);
      if (end === -1) {
        unclosed = true;
        out += '<';
        at += 1;
      } else {
        out += text.slice(at, end + 3).replace(/[^\n]/g, '');
        at = end + 3;
      }
    } else {
      out += text[at++];
    }
  }
  return out.split('\n');
}

/**
 * Where a run of exactly `n` backticks starts, from `from`, or -1.
 *
 * @param {string} text
 * @param {number} from
 * @param {number} n
 */
function findRun(text, from, n) {
  for (let at = text.indexOf('`', from); at !== -1; at = text.indexOf('`', at)) {
    let len = 0;
    while (text[at + len] === '`') len++;
    if (len === n) return at;
    at += len;
  }
  return -1;
}

/**
 * A heading's text from its line, or null: two hashes and a space, up to
 * three spaces of indent, closing hashes and trailing space dropped.
 *
 * @param {string} line
 * @param {number} level 2 or 3
 */
function headingText(line, level) {
  let at = 0;
  while (line[at] === ' ' && at < 4) at++;
  if (at > 3 || !line.startsWith('#'.repeat(level), at) || line[at + level] !== ' ') return null;
  let end = line.length;
  while (end > at && /\s/.test(line[end - 1])) end--;
  let hashes = end;
  while (hashes > at + level && line[hashes - 1] === '#') hashes--;
  if (hashes < end && line[hashes - 1] === ' ') end = hashes - 1;
  while (end > at && line[end - 1] === ' ') end--;
  const text = line.slice(at + level, end).trim();
  return text === '' ? null : text;
}

/**
 * @param {string} name a heading's text
 * @returns {number} its place in HEADINGS, or -1
 */
const place = (name) => HEADINGS.findIndex((names) => names.includes(name.trim()));

/**
 * What is wrong with a Plan's table: it must be the template's HTML one, so
 * GitHub shades only this PR's row. It shades the even rows of each `<tbody>`,
 * so each step is a `<tbody>` of its own and only this PR's starts with an
 * empty `<tr></tr>`; a Markdown table is one body, and shades every other row.
 *
 * @param {string} plan the Plan section
 * @returns {string[]}
 */
function planTableProblems(plan) {
  if (plan.split('\n').some((l) => /^[ \t]*\|.*\|[ \t]*$/.test(l)) || !/<table\b/i.test(plan)) {
    return [
      "write the Plan as the template's HTML table, not a Markdown one: GitHub shades every other row of a Markdown table, and only this PR's row of the template's",
    ];
  }
  /** @type {string[]} */
  const found = [];
  const bodies = [...plan.matchAll(/<tbody>([\s\S]*?)<\/tbody>/gi)].map((m) => m[1]);
  if (bodies.some((b) => (b.match(/<tr>\s*<td/gi) ?? []).length > 1)) {
    found.push("put each step in its own `<tbody>`, as the template's table does");
  }
  if (bodies.filter((b) => /^\s*<tr>\s*<\/tr>/i.test(b)).length !== 1) {
    found.push(
      "start this PR's `<tbody>`, and only that one, with an empty `<tr></tr>`: it is what shades the row",
    );
  }
  return found;
}

/** A GIF's block: the tool wrote a recording for this scenario. */
const GIF_KEY = /^pr-gif:/;
/** A screen's slot, put under a change for visual review (never its main block). */
const SLOT_KEY = /^describe:visual-review:/;
/** A GIF still a local path: gh didn't attach it. */
const LOCAL_GIF = /\]\(\.\/pr-gif\//;
/** The first line of a block PR GIFs marked stale. */
const STALE_BLOCK = /^\*\*Not updated for `[0-9a-f]{7,40}`: /;
/** A numbered change's heading (from before the tool wrote each change's title). */
const NUMBERED = /^ {0,3}### +\d+\.[ \t]+\S/;

/**
 * What is wrong with the GIF and screen blocks the tools wrote: a GIF that
 * didn't attach, a recording marked stale, a block outside the changes, a
 * marker pair twice. Visual review's own block (`describe:visual-review`)
 * isn't judged: its upload edit (BOT_PR_TOKEN, ci#144) runs this check
 * with the block half written, its table edit runs none, and what it holds
 * can't be told from its summary line.
 *
 * @param {{ key: string, inner: string[], at: number }[]} blocks every complete tool block
 * @param {{ at: number, line: number }[]} found the known headings
 * @param {string[]} lines what a reader sees
 * @returns {string[]}
 */
function pictureProblems(blocks, found, lines) {
  /** @type {string[]} */
  const problems = [];
  const changes = found.find((f) => f.at === 2);
  const after = changes ? found.find((f) => f.line > changes.line && f.at !== 2) : undefined;
  const end = after ? after.line : lines.length;
  const heading = changes ? lines.findIndex((l, i) => i > changes.line && NUMBERED.test(l)) : -1;
  // A change starts at its numbered heading, or at its pair when it has none.
  const slot = changes
    ? blocks.find((b) => CHANGE_SLOT.test(b.key) && b.at > changes.line && b.at < end)
    : undefined;
  const first = Math.min(...[heading, slot?.at ?? -1].filter((at) => at !== -1), Infinity);
  const own = blocks.filter((b) => GIF_KEY.test(b.key) || SLOT_KEY.test(b.key));
  for (const { key, inner, at } of own) {
    const gif = GIF_KEY.test(key);
    const what = gif ? 'GIF' : 'screen';
    if (gif && inner.some((l) => LOCAL_GIF.test(l))) {
      problems.push(
        `the GIF for \`${key.slice(7)}\` didn't attach, so it is still a local path: re-run PR GIFs for it`,
      );
    }
    if (gif && STALE_BLOCK.test(inner.find((l) => l.trim() !== '') ?? '')) {
      problems.push(
        `the GIF for \`${key.slice(7)}\` is marked "Not updated": its latest recording failed, so it shows old behaviour. Re-run PR GIFs for it`,
      );
    }
    if (changes === undefined || first === Infinity || at < first || at >= end) {
      problems.push(
        `put the ${what} block \`${key}\` under the change it belongs to: add an empty \`<!-- ${key} -->\` and \`<!-- /${key} -->\` pair there (a ${what} at the top or the very end belongs to no change), then ${
          gif
            ? 'push or re-run PR GIFs: it moves its own block in (a block you attached by hand is left, so move that one yourself)'
            : 'push: visual review fills it on its next run'
        }`,
      );
    }
  }
  const seen = new Set();
  for (const { key } of own) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (own.filter((b) => b.key === key).length > 1) {
      problems.push(
        `keep one \`${key}\` block: it appears twice, and the tool fills only one of them (an empty pair next to the tool's own block is moved into on the next run of PR GIFs)`,
      );
    }
  }
  return problems;
}

/**
 * What the PR event says about the PR's heads.
 *
 * @typedef {object} PrEvent
 * @property {boolean} [pushed] a push moved the head (`synchronize`)
 */

/**
 * What is wrong with the description's Revisions marker pair, for a PR that has
 * had more than one head.
 *
 * @param {string | null | undefined} body
 * @param {PrEvent} event
 * @returns {string[]}
 */
function revisionsProblems(body, { pushed = false }) {
  // A push is the proof of a second head the event gives: a PR opened, edited,
  // reopened or marked ready has one, whatever its commits.
  if (!pushed) return [];
  const found = revisionsPair(body ?? '');
  if (found.starts.length === 0 && found.ends.length === 0) {
    return [
      'this PR has had more than one head, but its description has no `<!-- pr-changes:revisions -->` and `<!-- /pr-changes:revisions -->` pair, each marker alone on its line and outside code (the template has it, after the checklist): keep it, empty. The changes tool writes the Revisions table only inside it, and puts a missing pair back when a push moves the head',
    ];
  }
  if (!found.at) {
    return [
      'keep exactly one `<!-- pr-changes:revisions -->` and `<!-- /pr-changes:revisions -->` pair, in that order, each marker alone on its line and outside code: the changes tool writes the Revisions table only inside a clean pair',
    ];
  }
  if (currentHead(withoutFences(body)) === null) {
    return [
      "update Revisions: this push moved the PR's head and the table has no current row for it yet (the changes tool writes it, and its edit runs this check again; a fork's author adds the row by hand)",
    ];
  }
  return [];
}

/**
 * What is wrong with a description, each as a sentence that says how to fix it.
 *
 * @param {string | null | undefined} body
 * @param {string} [head] the PR's head sha, when known: Revisions' current row must name it
 * @param {PrEvent} [event] what the PR event says about the PR's heads
 * @returns {string[]}
 */
export function bodyProblems(body, head, event = {}) {
  /** @type {{ key: string, inner: string[], at: number }[]} */
  const blocks = [];
  const lines = renderedLines(body, {
    onBlock: (key, inner, at) => blocks.push({ key, inner, at }),
  });
  // The same lines with each tool's block kept as a marker, line for line.
  const withTools = renderedLines(body, { keepTools: true });
  /** @type {{ at: number, line: number, name: string }[]} the known headings, in the order written */
  const found = [];
  lines.forEach((text, line) => {
    const name = headingText(text, 2);
    if (name !== null && place(name) !== -1) found.push({ at: place(name), line, name });
  });
  /** @type {string[]} */
  const problems = [];
  HEADINGS.forEach((names, at) => {
    const n = found.filter((f) => f.at === at).length;
    const wanted = names.map((name) => `\`## ${name}\``).join(' or ');
    if (n === 0 && !OPTIONAL.includes(names[0])) problems.push(`add the heading ${wanted}`);
    if (n > 1) problems.push(`keep one ${wanted} heading, not ${n}`);
  });
  if (found.some((f, i) => i > 0 && f.at < found[i - 1].at)) {
    problems.push(
      "put the headings in the template's order: Goal, Plan, Changes, Checklist, Revisions",
    );
  }
  /**
   * The lines under a heading, up to the next known one.
   *
   * @param {number} at
   * @param {string[]} [source]
   */
  const section = (at, source = lines) => {
    const from = found.find((f) => f.at === at);
    if (!from) return [];
    const next = found.find((f) => f.line > from.line && f.at !== at);
    return source.slice(from.line + 1, next ? next.line : undefined);
  };
  if (found.some((f) => f.at === 0) && section(0).join('').trim() === '') {
    problems.push(
      'write the goal (or the problem) under the first heading: a sentence of what this gives whom',
    );
  }
  const goal = section(0).join('\n');
  if (found.some((f) => f.at === 0) && goal.trim() !== '' && !ISSUE.test(goal)) {
    problems.push(
      "say the goal's issue: `Closes #N`, or `Part of #N` when the issue is bigger than this PR (`owner/repo#N` or a link will do); or say there is no issue",
    );
  }
  if (
    found.find((f) => f.at === 0)?.name === 'Problem' &&
    !EXAMPLE.test(`${goal}\n${section(2).join('\n')}`)
  ) {
    problems.push(
      'add an `**Example**` paragraph to this bug fix, under the problem or under the change it belongs to: the simplest case that shows it (or `**Example**` and why there is none)',
    );
  }
  problems.push(...pictureProblems(blocks, found, lines));
  if (found.some((f) => f.at === 2)) {
    const changes = section(2);
    const kept = section(2, withTools);
    /** @type {number[]} */
    const headings = [];
    /** @type {{ at: number, n: number }[]} */
    const pairs = [];
    kept.forEach((l, i) => {
      if (NUMBERED.test(l)) headings.push(i);
      const slot = /^@@tool:pr-changes:change:([1-9]\d*)@@$/.exec(l);
      if (slot) pairs.push({ at: i, n: Number(slot[1]) });
    });
    // A change starts at its pair. A numbered heading above it (a description
    // from before) starts it instead, when it is the heading numbered like the
    // pair and comes after the pair before: a numbered sub-heading inside
    // someone's why (`### 1. Steps`) is no change. Without any pair, the
    // headings are the changes, as they were.
    const starts = pairs.length
      ? pairs.map(({ at, n }, i) => {
          const lead = headings.findLast(
            (h) => h < at && h > (pairs[i - 1]?.at ?? -1) && Number(/\d+/.exec(kept[h])?.[0]) === n,
          );
          return { from: lead ?? at, n, led: lead !== undefined };
        })
      : headings.map((from) => ({
          from,
          n: Number(/\d+/.exec(kept[from])?.[0]),
          led: true,
        }));
    // `at` and the lines here index alike, from the line after the Changes heading.
    const base = (found.find((f) => f.at === 2)?.line ?? -1) + 1;
    starts.forEach(({ from, n, led }, i) => {
      const to = starts[i + 1]?.from;
      const part = kept.slice(from, to);
      const slots = blocks.filter(
        (b) => CHANGE_SLOT.test(b.key) && b.at >= base + from && b.at < base + (to ?? kept.length),
      );
      const filled = slots.some((b) => b.inner.join('').trim() !== '');
      if (!filled && !COMMIT.test(part.join('\n'))) {
        problems.push(
          slots.length > 0
            ? `under change ${n}, its \`<!-- pr-changes:change:${n} -->\` pair is empty: the changes tool fills it with the commit and files on the next push, or link the commit yourself`
            : `under change ${n}, add its commit: the empty marker pair \`<!-- pr-changes:change:${n} -->\` with \`<!-- /pr-changes:change:${n} -->\` (the changes tool fills it), or a link to the commit`,
        );
      }
      // The tool writes the title; the why is the author's, under the pair.
      if (!led && !part.slice(1).some((l) => l.trim() !== '' && !l.startsWith('@@tool:'))) {
        problems.push(
          `under change ${n}, write why: bullets (or numbered steps) under its \`<!-- pr-changes:change:${n} -->\` pair, since the changes tool writes only the title, the commit and the files`,
        );
      }
    });
    // With no heading to carry a number, the pair's own number is the change's
    // only identity: the Nth commit goes in the pair numbered N.
    if (
      pairs.length > 0 &&
      starts.every((st) => !st.led) &&
      pairs.some((pr, i) => pr.n !== i + 1)
    ) {
      problems.push(
        `number the change pairs 1, 2, 3… in the order they appear (they are ${pairs.map((pr) => pr.n).join(', ')}): the changes tool puts the Nth commit in the pair numbered N`,
      );
    }
    if (starts.length === 0) {
      problems.push(
        'under `## Changes`, add a change: an empty `<!-- pr-changes:change:1 -->` and `<!-- /pr-changes:change:1 -->` pair, each marker alone on its line (the changes tool writes its title, commit and files), then why in bullets under it',
      );
    }
    const numbered = changes.flatMap((l) => {
      const m = /^ {0,3}### +\d+\.[ \t]+(\S.*)$/.exec(l);
      return m ? [m[1].trimEnd()] : [];
    });
    if (numbered.some((text) => SAMPLE_HEADING.test(text)) || SAMPLE_WHY.test(changes.join('\n'))) {
      problems.push(
        'replace the template\'s sample change (its "Why this change." line, or a heading `### 1. The first change, as a goal`) with your own',
      );
    }
  }
  const plan = section(1).join('\n');
  if (found.find((f) => f.at === 1)?.name === 'Plan') problems.push(...planTableProblems(plan));
  if (SAMPLE_ROW.test(plan)) {
    problems.push(
      "fill in or delete the plan table's template row, or delete the Plan section for a PR that isn't a step of a plan",
    );
  }
  const current = head ? currentRevision(withoutFences(body)) : null;
  if (head && current && !current.head.toLowerCase().includes(head.slice(0, 7).toLowerCase())) {
    problems.push(
      `update Revisions: its current row names another commit than this PR's head, \`${head.slice(0, 7)}\` (add a row for the head, or fix the row)`,
    );
  } else if (head && current?.rows) {
    // Only a `<details>` revision naming the head: a stale one is the problem above.
    problems.push(...revisionRowProblems(current.rows, head));
  }
  problems.push(...revisionsProblems(body, event));
  if (BOX.test(lines.join('\n'))) {
    problems.push(
      'delete the "No visible UI change" box: visual review decides whether a screen changed',
    );
  }
  return problems;
}
