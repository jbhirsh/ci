// What a PR's description says about each change (ci#79): under Changes the
// author places an empty pair `<!-- pr-changes:change:N -->` …
// `<!-- /pr-changes:change:N -->` for each change, and this fills it from git
// alone with the nth commit: its title, a line `**N. <subject>** [`sha`](link)`
// (the number is the pair's own, the subject is bold and the commit link comes
// last), then a closed dropdown "N files changed +a −d" that opens on each file,
// linked to its diff (`#diff-<sha256 of the path>`), with its counts. The
// author writes only why, in bullets under the pair: there is no heading to
// write, since the title is this tool's. A description from before (a numbered
// `### N.` heading above its pair, and a line `[`sha`](link) subject` in it) is
// rewritten the same way on the next run, as the whole block is, and the
// heading stays the author's.
//
// The counts (`+81 −37`) are green and red through a small picture of the
// numbers, not text: GitHub strips HTML colour, and the GitHub app shows
// math (`$\color…$`) as raw source (counts.ts says what the pictures are
// and why). This module doesn't know about images: it takes `pair(added,
// removed)`, the markup of a pair, so it stays pure.
//
// The rules, so a reader can predict the output:
//   - commits map to changes by position: the nth commit by someone other
//     than a bot, or a merge, fills slot n. When the counts differ no commit
//     is guessed at: every slot says so instead (a warning line, so a reader
//     of the PR sees it, and no stale commit stays), and the author fixes
//     the slots or the commits;
//   - only a placed slot is written: a clean pair, once, outside a code
//     fence and another tool's block, with no other tool's marker inside it,
//     and never appended when it is missing;
//   - a commit's subject is a stranger's text: it is escaped (Markdown,
//     HTML, an @mention, math, a reference, a link), and a body over BUDGET
//     characters steps down, each step only when the one before is too long
//     (chooseLevel): pictures in the title and on every file line; pictures
//     in the title only, plain counts on the file lines; a plain line of the
//     totals, no file lists; and then nothing is written (`tooLong`), rather
//     than hit GitHub's limit and fail the write;
//   - the same inputs give the same description, so a rerun changes nothing.
//
// Pure: commits and a description in, a description out. run.ts reads and
// writes GitHub.

import { createHash } from 'node:crypto';
import { blocksFor } from '../lib/blocks.ts';

export const blocks = blocksFor('pr-changes', {
  named: 'a change numbered',
  where: 'a PR description',
});

/** A description longer than this has its file lists left out (GitHub's limit is 65,536). */
export const BUDGET = 60_000;

/** Another tool's marker, which a placed slot must not hold. */
const ANY_MARKER = /<!-- \/?[a-z][a-z0-9-]*:[^\s<>]+ -->/;

/** One commit of the PR. */
export type Commit = {
  sha: string;
  subject: string;
  files: { path: string; added: number; removed: number }[];
};

/**
 * Where the PR's diff of a file is, by GitHub's anchor for its path.
 */
export const anchor = (path: string) => `#diff-${createHash('sha256').update(path).digest('hex')}`;

/**
 * Bidirectional controls and zero-width characters: they would reorder or hide
 * what a reader sees of a stranger's text, or leave a space the eye can't see
 * inside the bold's closing stars.
 */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * Text that is safe as one line of Markdown: nothing in it makes a tag, a
 * link, emphasis, a table cell or a mention.
 */
export function escape(text: string) {
  return (
    text
      .replace(INVISIBLE, '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c)
      .replace(/[\\`*_[\]|~$]/g, (c) => `\\${c}`)
      // A zero-width space after what makes a mention, an issue reference or a link.
      .replace(/[@#]/g, (c) => `${c}\u200b`)
      .replace(/:\/\//g, ':\u200b//')
      // `www.` makes a link on its own, without a scheme.
      .replace(/www\./gi, (m) => `${m.slice(0, 3)}\u200b.`)
  );
}

/**
 * A path as inline code: fenced by more backticks than it holds.
 */
function code(path: string) {
  // No `<`, so a path can't hold a marker that would make its own slot look torn.
  const clean = path.replace(/[\r\n]+/g, ' ').replace(/</g, '‹');
  const longest = Math.max(0, ...(clean.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${clean.startsWith('`') || clean.endsWith('`') ? ` ${clean} ` : clean}${fence}`;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The steps a long description steps down through, best first: `full` (pictures in the title and on
 * every file line), `titles` (pictures in the title, plain counts on the file lines) and `totals`
 * (a plain line, no file lists).
 */
export type Level = 'full' | 'titles' | 'totals';
export const LEVELS = ['full', 'titles', 'totals'] as const;

/** A pair's markup: given the added and removed counts. */
export type Pair = (added: number, removed: number) => string;

/** The plain text of a pair, for a pair with no picture. */
export const plain = (added: number, removed: number) => `+${added} −${removed}`;

/**
 * What goes between a slot's markers for one commit.
 *
 * @param commit
 * @param options `n` is the change's number, from its marker; `pair` is the
 *   markup of a pair (default: plain text); `level` says how much to show
 *   (default `full`)
 */
export function renderChange(
  commit: Commit,
  {
    repo,
    number,
    n,
    level = 'full',
    pair = plain,
  }: { repo: string; number: number; n: number; level?: Level; pair?: Pair },
): string {
  const added = commit.files.reduce((sum, f) => sum + f.added, 0);
  const removed = commit.files.reduce((sum, f) => sum + f.removed, 0);
  // Trimmed before it is escaped, and never empty: a space inside the bold's
  // closing `**` (or nothing between the stars) makes GitHub show the stars.
  const subject = escape(commit.subject.replace(INVISIBLE, '').trim()) || '(no subject)';
  const line = `**${n}. ${subject}** [\`${commit.sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${commit.sha})`;
  if (commit.files.length === 0) return line;
  const label = count(commit.files.length, 'file');
  if (level === 'totals') return [line, '', `${label} changed ${plain(added, removed)}`].join('\n');
  const onFile = level === 'full' ? pair : plain;
  return [
    line,
    '',
    `<details><summary>${label} changed ${pair(added, removed)}</summary>`,
    '',
    ...commit.files.map(
      (f) =>
        `- [${code(f.path)}](https://github.com/${repo}/pull/${number}/files${anchor(f.path)}) ${onFile(f.added, f.removed)}`,
    ),
    '',
    '</details>',
  ].join('\n');
}

/**
 * Where text is that a marker doesn't count in: inside a code fence, or
 * inside another tool's block (describe rewrites it, so a slot there would
 * be wiped).
 */
export function shielded(body: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let open = -1;
  let fence = '';
  let at = 0;
  for (const line of body.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m && open === -1) {
      open = at;
      fence = m[1][0];
    } else if (m && open !== -1 && m[1][0] === fence) {
      out.push({ from: open, to: at + line.length });
      open = -1;
    }
    at += line.length + 1;
  }
  if (open !== -1) out.push({ from: open, to: body.length });
  for (const m of body.matchAll(/<!-- ([a-z][a-z0-9-]*):([^\s<>]+) -->/g)) {
    if (m[1] === 'pr-changes') continue;
    const end = `<!-- /${m[1]}:${m[2]} -->`;
    const to = body.indexOf(end, m.index);
    if (to !== -1) out.push({ from: m.index as number, to: to + end.length });
  }
  return out;
}

/**
 * Where a block of this tool is in a description, outside any code fence: a
 * description may show the markers as an example, and that isn't a block.
 */
export function ownBlock(body: string, key: string): { from: number; to: number } | null {
  const at = blocks.find(body, key);
  if (!at) return null;
  return shielded(body).some((r) => r.from <= at.from && at.to <= r.to) ? null : at;
}

/**
 * The description with a block of this tool set to `text`: in place of its
 * own, or after the rest when it has none (an example in a fence is left as
 * it is).
 */
export function putBlock(body: string, key: string, text: string) {
  const { start, end } = blocks.markers(key);
  const marked = `${start}\n${text}\n${end}`;
  const at = ownBlock(body, key);
  if (at) return body.slice(0, at.from) + marked + body.slice(at.to);
  return body.trimEnd() ? `${body.trimEnd()}\n\n${marked}\n` : `${marked}\n`;
}

/**
 * The description without a block of this tool, nor the blank line that kept
 * it apart from what came before.
 */
export function dropBlock(body: string, key: string) {
  const at = ownBlock(body, key);
  if (!at) return body;
  const head = body.slice(0, at.from).trimEnd();
  const tail = body.slice(at.to).replace(/^\n+/, '');
  return head && tail ? `${head}\n\n${tail}` : head || tail;
}

/**
 * The numbers of the change slots a description has placed, in order: a
 * clean pair, once, outside a code fence and another tool's block, with no
 * other tool's marker inside it.
 */
export function placed(body: string): number[] {
  const keys = blocks.keys(body).filter((key) => /^change:[1-9]\d*$/.test(key));
  const covered = shielded(body);
  return [...new Set(keys)]
    .filter((key) => {
      const { start, end } = blocks.markers(key);
      if (body.split(start).length !== 2 || body.split(end).length !== 2) return false;
      const at = blocks.find(body, key);
      if (!at) return false;
      if (covered.some((r) => r.from <= at.from && at.to <= r.to)) return false;
      return !ANY_MARKER.test(body.slice(at.from + start.length, at.to - end.length));
    })
    .map((key) => Number(key.slice('change:'.length)))
    .sort((a, b) => a - b);
}

/**
 * Whether the slots and the commits match: one slot per commit, numbered from 1.
 */
const matches = (slots: readonly number[], commits: number) =>
  slots.length === commits && slots.every((n, i) => n === i + 1);

/**
 * The description with each placed slot written by `text`.
 */
const writeAll = (body: string, slots: readonly number[], text: (n: number) => string) =>
  slots.reduce((acc, n) => blocks.write(acc, `change:${n}`, text(n)), body);

/**
 * The best level at which the slots, filled with `pair`'s markup, fit in
 * BUDGET with `reserve` characters to spare (what the run adds besides: the
 * index of uploaded pictures), or null when none does.
 *
 * @param body
 * @param commits
 * @param where
 * @param options `pair` should make the longest markup a pair can have, so the
 *   choice holds whatever links come
 */
export function chooseLevel(
  body: string,
  commits: readonly Commit[],
  where: { repo: string; number: number },
  { pair, reserve = 0 }: { pair: Pair; reserve?: number },
): Level | null {
  const slots = placed(body);
  if (!matches(slots, commits.length)) return null;
  for (const level of LEVELS) {
    const out = writeAll(body, slots, (n) =>
      renderChange(commits[n - 1], { ...where, n, level, pair }),
    );
    if (out.length + (level === 'totals' ? 0 : reserve) <= BUDGET) return level;
  }
  return null;
}

/**
 * The description with each placed slot filled from its commit.
 *
 * @param body
 * @param commits the PR's commits by someone other than a bot, oldest first
 * @param where
 * @param options `pair` makes a pair's markup (default plain text); `level` is
 *   the step to write at; without one the best that fits is chosen
 * @returns `problem` says what went wrong (the slots don't match the commits,
 *   or the description would be too long), or is null; the body then has the
 *   problem in each slot, or is unchanged when it is too long
 */
export function fill(
  body: string,
  commits: readonly Commit[],
  where: { repo: string; number: number },
  { level, pair = plain, reserve = 0 }: { level?: Level; pair?: Pair; reserve?: number } = {},
): { body: string; problem: string | null } {
  const slots = placed(body);
  if (slots.length === 0) return { body, problem: null };
  if (!matches(slots, commits.length)) {
    const problem = `the description places change slots ${slots.join(', ')} for ${count(commits.length, 'commit')}: put one slot per commit, numbered from 1, so the nth commit goes under the nth change`;
    return { body: writeAll(body, slots, () => `> ⚠️ **pr-changes:** ${problem}.`), problem };
  }
  const chosen = level ?? chooseLevel(body, commits, where, { pair, reserve });
  if (chosen === null) {
    return {
      body,
      problem: `the description would be over ${BUDGET} characters even with plain totals only: too long to write`,
    };
  }
  const out = writeAll(body, slots, (n) =>
    renderChange(commits[n - 1], { ...where, n, level: chosen, pair }),
  );
  return { body: out, problem: null };
}
