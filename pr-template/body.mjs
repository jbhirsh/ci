// Whether a PR's description is in the shared shape (ci#79), for an app with
// `visuals.sharedTemplate`. The master is `.github/pull_request_template.md`;
// structure.mjs checks a template against it, and this reads a description the
// author, or a tool, has written from it. Shape only, never the words: a
// description passes with any text in its sections.
//
// What it requires, in what a reader sees (code, HTML comments and the
// blocks other tools keep between their markers are not read, so a heading
// quoted in a fence or a table a tool wrote counts for nothing):
//   - the headings Goal (or Problem) and Changes, then Revisions, each once,
//     in the template's order, with Plan (or Solution) after Goal and
//     Checklist before Revisions where a PR has them: both are optional, Plan
//     for a PR that is not a step of a plan;
//   - words under Goal or Problem that say `Closes #N` or `Part of #N` (or a
//     link to the issue), or that there is no issue;
//   - under a Problem (a bug fix), an `**Example**` paragraph, there or under
//     one of its changes;
//   - under a Plan, the template's HTML table, each step its own `<tbody>` and
//     only this PR's starting with an empty `<tr></tr>`, so that GitHub shades
//     only this PR's row (a Markdown table shades every other row);
//   - under Changes, at least one numbered change: `### 1. The change`, each
//     with its commit: a `pr-changes:change:N` marker pair or a commit link;
//   - Revisions' current row (its Rev cell says `(current)`) naming the PR's
//     head, when the head is given: a push makes it stale, and the check fails
//     until the row is updated (a description with no current row passes). It
//     reads the raw description, fenced code aside, since the table sits in a
//     tool's block; the tool must write it with a person's token, or its edit
//     starts no new run of this check.
//   - none of the template's own placeholders left in: the sample change
//     heading, its "Why this change." line, the plan table's empty row;
//   - no `No visible UI change` box, which this template doesn't have.
// Text after Revisions is fine: visual review's fingerprint and PR GIFs'
// blocks go at the very end.
//
// Pure: a description in, what is wrong with it out. check-body.mjs decides
// which PRs this holds (not a draft, a closed PR, Dependabot's, a bot's).

import { HEADINGS } from './structure.mjs';

/** A tool's marker alone on its line: `<!-- x:y -->`, and `<!-- /x:y -->` ends its block. */
const TOOL_START = /^ *<!-- ([a-z][a-z0-9-]*:[^\s<>]+) -->\s*$/;
/** The headings a description may leave out, by their first name. */
const OPTIONAL = ['Plan', 'Checklist'];
/** The goal's last words: an issue it closes or is part of, or that there is none. */
const ISSUE =
  /\b(?:closes|part of)\s+\[?(?:(?:[\w.-]{1,100}\/[\w.-]{1,100})?#\d+|https?:\/\/\S{1,200}\/issues\/\d+)|\bno issues?\b/i;
/** A bug fix's example: a bold paragraph, as the template says. */
const EXAMPLE = /^ {0,3}\*\*Example:?\*\*/m;
/** Revisions' current row: its Rev cell says `(current)`; the next cell is its head. */
const CURRENT_ROW = /^\|[^|\n]*\(current\)[^|\n]*\|([^|\n]*)\|/m;
/** A change's commit, as a tool's marker pair or a link. */
const COMMIT = /@@tool:pr-changes:change:\d+@@|\/commit\/[0-9a-f]{7,40}/;
/** What the template's example change says. */
const SAMPLE_HEADING = /^The first change, as a goal\b/i;
const SAMPLE_WHY = /^Why this change\.\s*$/im;
/**
 * The plan table's template row: this PR's row with the "What" cell empty,
 * as the HTML table the template has now, or the Markdown one it had.
 */
const SAMPLE_ROW = /<td>\s*<b>\s*<\/b>\s*<\/td>|^\|[^|\n]*\|\s*\*\*this PR\*\*\s*\|\s*\|/im;
const BOX = /\[[ xX]\]\s*No visible UI change/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

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
 * @param {{ keepTools?: boolean }} [options]
 * @returns {string[]}
 */
export function renderedLines(body, { keepTools = false } = {}) {
  const lines = (body ?? '').replace(/\r\n?/g, '\n').split('\n');
  /** @type {string[]} */
  const kept = [];
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
      const end = `<!-- /${tool[1]} -->`;
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== end) j++;
      if (j < lines.length) {
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
      const end = text.indexOf('-->', at + 4);
      if (end === -1) {
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

/**
 * What is wrong with a description, each as a sentence that says how to fix it.
 *
 * @param {string | null | undefined} body
 * @param {string} [head] the PR's head sha, when known: Revisions' current row must name it
 * @returns {string[]}
 */
export function bodyProblems(body, head) {
  const lines = renderedLines(body);
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
  if (found.some((f) => f.at === 2)) {
    const changes = section(2);
    const kept = section(2, withTools);
    /** @type {number[]} */
    const starts = [];
    kept.forEach((l, i) => {
      if (/^ {0,3}### +\d+\.[ \t]+\S/.test(l)) starts.push(i);
    });
    starts.forEach((from, i) => {
      const part = kept.slice(from, starts[i + 1]);
      if (!COMMIT.test(part.join('\n'))) {
        const n = /\d+/.exec(part[0])?.[0];
        problems.push(
          `under change ${n}, add its commit: the empty marker pair \`<!-- pr-changes:change:${n} -->\` with \`<!-- /pr-changes:change:${n} -->\`, or a link to the commit`,
        );
      }
    });
    const numbered = changes.flatMap((l) => {
      const m = /^ {0,3}### +\d+\.[ \t]+(\S.*)$/.exec(l);
      return m ? [m[1].trimEnd()] : [];
    });
    if (numbered.length === 0) {
      problems.push(
        'under `## Changes`, add a numbered change heading such as `### 1. The first change`',
      );
    }
    if (numbered.some((text) => SAMPLE_HEADING.test(text)) || SAMPLE_WHY.test(changes.join('\n'))) {
      problems.push(
        'replace the template\'s sample change (`### 1. The first change, as a goal`, "Why this change.") with your own',
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
  const row = head ? CURRENT_ROW.exec(withoutFences(body)) : null;
  if (head && row && !row[1].toLowerCase().includes(head.slice(0, 7).toLowerCase())) {
    problems.push(
      `update Revisions: its current row names another commit than this PR's head, \`${head.slice(0, 7)}\` (add a row for the head, or fix the row)`,
    );
  }
  if (BOX.test(lines.join('\n'))) {
    problems.push(
      'delete the "No visible UI change" box: visual review decides whether a screen changed',
    );
  }
  return problems;
}
