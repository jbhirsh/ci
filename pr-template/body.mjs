// Whether a PR's description is in the shared shape (ci#79), for an app with
// `visuals.sharedTemplate`. The master is `.github/pull_request_template.md`;
// structure.mjs checks a template against it, and this reads a description the
// author, or a tool, has written from it. Shape only, never the words: a
// description passes with any text in its sections.
//
// What it requires, in what a reader sees (code, HTML comments and the
// blocks other tools keep between their markers are not read, so a heading
// quoted in a fence or a table a tool wrote counts for nothing):
//   - the headings Goal (or Problem), Plan (or Solution; optional, for a PR
//     that is not a step of a plan), Changes, Checklist and Revisions, each
//     once, in that order;
//   - words under Goal or Problem;
//   - under Changes, at least one numbered change: `### 1. The change`;
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
 * What a reader sees of a description, as lines: line endings made `\n`;
 * fenced code, HTML comment blocks and the blocks other tools keep between
 * their markers gone, as GitHub's renderer reads blocks (a fence closes with
 * its own character, at least as long; an unclosed fence or a comment that
 * starts a line and never ends runs to the end); and, in what is left, code
 * spans (equal runs of backticks, within one paragraph; a lone backtick is
 * text) and inline comments (an unclosed `<!--` mid-line is text). A line
 * at a time, so nothing backtracks.
 *
 * @param {string | null | undefined} body
 * @returns {string[]}
 */
export function renderedLines(body) {
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
        kept.push('');
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
    kept.push(line);
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
    if (i < lines.length && lines[i].trim() !== '') continue;
    const paragraph = lines.slice(start, i);
    out.push(...(paragraph.length ? withoutSpans(paragraph) : []));
    if (i < lines.length) out.push('');
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
 * What is wrong with a description, each as a sentence that says how to fix it.
 *
 * @param {string | null | undefined} body
 * @returns {string[]}
 */
export function bodyProblems(body) {
  const lines = renderedLines(body);
  /** @type {{ at: number, line: number }[]} the known headings, in the order written */
  const found = [];
  lines.forEach((text, line) => {
    const name = headingText(text, 2);
    if (name !== null && place(name) !== -1) found.push({ at: place(name), line });
  });
  /** @type {string[]} */
  const problems = [];
  HEADINGS.forEach((names, at) => {
    const n = found.filter((f) => f.at === at).length;
    const wanted = names.map((name) => `\`## ${name}\``).join(' or ');
    if (n === 0 && names[0] !== 'Plan') problems.push(`add the heading ${wanted}`);
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
   */
  const section = (at) => {
    const from = found.find((f) => f.at === at);
    if (!from) return [];
    const next = found.find((f) => f.line > from.line && f.at !== at);
    return lines.slice(from.line + 1, next ? next.line : undefined);
  };
  if (found.some((f) => f.at === 0) && section(0).join('').trim() === '') {
    problems.push(
      'write the goal (or the problem) under the first heading: a sentence of what this gives whom',
    );
  }
  if (found.some((f) => f.at === 2)) {
    const changes = section(2);
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
  if (SAMPLE_ROW.test(section(1).join('\n'))) {
    problems.push(
      "fill in or delete the plan table's template row, or delete the Plan section for a PR that isn't a step of a plan",
    );
  }
  if (BOX.test(lines.join('\n'))) {
    problems.push(
      'delete the "No visible UI change" box: visual review decides whether a screen changed',
    );
  }
  return problems;
}
