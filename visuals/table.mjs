// The PR's before/after table, from its changed baselines paired by state
// (lib/baselines.mjs): the Markdown of the comment comment.mjs keeps on the
// PR when the app's `visuals.fromBaselines` is on. Pure.
//
// One row per state, one cell per column (phone and desktop, light and
// dark), each cell the baseline before → after: before at the merge base
// (what the files API diffs the PR against), after at the PR's head. Both
// are linked by commit SHA on raw.githubusercontent.com, which serves a
// public repository's files to anyone signed in or not; a commit a
// force-push drops stays served through refs/pull/<n>/head, and main is
// never rewritten, so a link keeps showing what it showed. The table is
// rewritten on each push. A new baseline shows "(new)" before, a deleted one
// "(removed)" after, and a column with no change for the state "—". Changed
// baselines no column takes are listed as links, folded away. The comment
// stays under GitHub's limit, ending "and N more" when the rest won't fit.

import { MAX_CHARS } from '../lib/comment.mjs';

// The most the comment may hold, GitHub's limit as every bot comment keeps it.
export { MAX_CHARS };

/** The first line of the comment, to find it again. */
export const MARKER = '<!-- pr-visuals:table -->';
/** A cell's picture width when its column sets none, in pixels. */
export const DEFAULT_WIDTH = 300;

/**
 * Text as HTML, safe in a table cell: a `|` would end the cell, and GitHub
 * still reads Markdown inside HTML, so its marks (code, emphasis, links,
 * escapes) are entities too, and an `@` can't mention anyone.
 *
 * @param {string} text
 */
function html(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\|/g, '&#124;')
    .replace(/[@`*_[\]\\~]/g, (c) => `&#${c.charCodeAt(0)};`)
    .replace(/[\r\n]/g, ' ');
}

/**
 * A repository path as a URL path, each segment encoded (a lone surrogate,
 * which encodeURIComponent refuses, as U+FFFD; Node's toWellFormed is
 * beyond the ES2023 library this repo type-checks against).
 *
 * @param {string} file
 */
function encodePath(file) {
  return file
    .split('/')
    .map((part) => encodeURIComponent(part.replace(/\p{Cs}/gu, '\uFFFD')))
    .join('/');
}

/**
 * A file's raw URL at a commit.
 *
 * @param {string} repo
 * @param {string} sha
 * @param {string} file
 */
export function rawUrl(repo, sha, file) {
  return `https://raw.githubusercontent.com/${repo}/${sha}/${encodePath(file)}`;
}

/**
 * @typedef {object} TableInput
 * @property {import('../lib/baselines.mjs').Row[]} rows
 * @property {import('../lib/baselines.mjs').Changed[]} unpaired
 * @property {import('../lib/baselines.mjs').Column[]} columns
 * @property {string} repo owner/name
 * @property {string} base the merge base's SHA
 * @property {string} head the PR head's SHA
 */

/**
 * The comment's Markdown, or null when no baseline changed (the comment
 * then goes).
 *
 * @param {TableInput} input
 * @returns {string | null}
 */
export function renderTable({ rows, unpaired, columns, repo, base, head }) {
  if (rows.length === 0 && unpaired.length === 0) return null;
  const count = rows.reduce((n, r) => n + Object.keys(r.cells).length, 0) + unpaired.length;
  /**
   * @param {string} sha
   * @param {string} file
   * @param {number} width
   */
  const img = (sha, file, width) =>
    `<img src="${rawUrl(repo, sha, file)}" alt="${html(file)}" width="${width}">`;
  /**
   * @param {import('../lib/baselines.mjs').Changed | undefined} c
   * @param {number} width
   */
  const cell = (c, width) => {
    if (!c) return '—';
    const before = c.before ? img(base, c.before, width) : '(new)';
    const after = c.after ? img(head, c.after, width) : '(removed)';
    return `${before} → ${after}`;
  };
  const head7 = head.slice(0, 7);
  const intro = [
    MARKER,
    '### Visual changes',
    '',
    `From the ${count} baseline${count === 1 ? '' : 's'} this PR changed: before at \`${base.slice(0, 7)}\` (the merge base), after at \`${head7}\` (this PR's head). Rewritten on each push.`,
  ];
  /** @type {string[]} */
  const table = [];
  if (rows.length > 0) {
    table.push(
      '',
      `| State | ${columns.map((c) => c.label).join(' | ')} |`,
      `|---|${columns.map(() => '---|').join('')}`,
    );
  }
  const lines = rows.map((r) => {
    const label = `<code>${html(r.state)}</code>${r.folder ? ` (${html(r.folder)})` : ''}`;
    const cells = columns.map((c) => cell(r.cells[c.label], c.width ?? DEFAULT_WIDTH));
    return `| ${label} | ${cells.join(' | ')} |`;
  });
  const links = unpaired.map((c) => {
    const [sha, file] = c.after ? [head, c.after] : [base, /** @type {string} */ (c.before)];
    const note = c.after ? (c.before ? '' : ' (new)') : ' (removed)';
    return `- <a href="https://github.com/${repo}/blob/${sha}/${encodePath(file)}">${html(file)}</a>${note}`;
  });

  // Room for the "and N more" line and the details' wrapping.
  const budget = MAX_CHARS - 400;
  let size = [...intro, ...table].join('\n').length;
  /** @type {string[]} */
  const kept = [];
  let left = 0;
  for (const [i, line] of lines.entries()) {
    if (left === 0 && size + line.length + 1 <= budget) {
      kept.push(line);
      size += line.length + 1;
    } else left += Object.keys(rows[i].cells).length;
  }
  /** @type {string[]} */
  const keptLinks = [];
  for (const link of links) {
    if (left === 0 && size + link.length + 1 <= budget) {
      keptLinks.push(link);
      size += link.length + 1;
    } else left += 1;
  }
  const out = [...intro, ...table, ...kept];
  if (keptLinks.length > 0) {
    const n = unpaired.length;
    // Cut short, it says how many it lists; "And N more" counts the rest.
    const listed = keptLinks.length < n ? `${keptLinks.length} of ${n}` : `${n}`;
    out.push(
      '',
      '<details>',
      `<summary>${listed} changed baseline${n === 1 ? '' : 's'} in no column</summary>`,
      '',
      ...keptLinks,
      '',
      '</details>',
    );
  }
  if (left > 0) {
    out.push('', `And ${left} more changed baseline${left === 1 ? '' : 's'}: see Files changed.`);
  }
  return out.join('\n');
}
