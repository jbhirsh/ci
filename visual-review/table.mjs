// The table `Visual changes` writes into a PR's or a mockup issue's
// description (ci#64): one row per screen and size, before and after shown
// inline, the diffs folded below. Pure: the comparison's changes and the
// attachment links come in, Markdown goes out. describe/ puts it between
// the `describe:visual-review` markers.
//
// A row is a screen in one of the app's `columns` (phone and desktop, light
// and dark), paired by lib/baselines.mjs's rules, so the two sizes of one
// screen sit next to each other. A shot no column takes gets a row of its
// own, named by its path.
//
// The pictures are GitHub attachments, uploaded first (review.mjs),
// and at most UPLOAD_LIMIT go up per result: gh attaches at most 50 files a
// command. pick() decides which: before and after for each change first, in
// row order, then the diffs. A picture left out says so in its cell.

import path from 'node:path';
import { pairBaselines } from '../lib/baselines.mjs';
import { html } from '../visuals/table.mjs';

/** The most pictures one result uploads. */
const UPLOAD_LIMIT = 50;
/** A picture's width when its column sets none, in pixels. */
export const DEFAULT_WIDTH = 300;

/**
 * A picture to upload: which side of which shot.
 *
 * @typedef {{ file: string, side: 'before' | 'after' | 'diff' }} Picture
 */

/**
 * One row: its label, and the change it shows.
 *
 * @typedef {{ label: string, width: number,
 *   change: import('./compare.mjs').Change }} Line
 */

/**
 * The changes as rows, in the table's order.
 *
 * @param {readonly import('./compare.mjs').Change[]} changes
 * @param {readonly import('../lib/baselines.mjs').Column[]} columns
 * @returns {Line[]}
 */
export function lines(changes, columns) {
  const byFile = new Map(changes.map((c) => [c.file, c]));
  const { rows, unpaired } = pairBaselines(
    changes.map((c) => ({
      before: c.kind === 'added' ? null : c.file,
      after: c.kind === 'removed' ? null : c.file,
      status: c.kind,
      folder: path.posix.dirname(c.file),
    })),
    columns,
  );
  /** @type {Line[]} */
  const out = [];
  for (const row of rows) {
    for (const column of columns) {
      const cell = row.cells[column.label];
      if (!cell) continue;
      const change = /** @type {import('./compare.mjs').Change} */ (
        byFile.get(/** @type {string} */ (cell.after ?? cell.before))
      );
      out.push({
        label: `${row.state}, ${column.label.toLowerCase()}`,
        width: column.width ?? DEFAULT_WIDTH,
        change,
      });
    }
  }
  for (const cell of unpaired) {
    const file = /** @type {string} */ (cell.after ?? cell.before);
    out.push({
      label: file,
      width: DEFAULT_WIDTH,
      change: /** @type {import('./compare.mjs').Change} */ (byFile.get(file)),
    });
  }
  return out;
}

/**
 * The pictures to upload, at most `limit`: before and after for each row in
 * order, then the diffs.
 *
 * @param {readonly Line[]} rows
 * @param {number} [limit]
 * @returns {Picture[]}
 */
export function pick(rows, limit = UPLOAD_LIMIT) {
  /** @type {Picture[]} */
  const sides = rows.flatMap(({ change: c }) => [
    ...(c.kind === 'added' ? [] : [{ file: c.file, side: /** @type {const} */ ('before') }]),
    ...(c.kind === 'removed' ? [] : [{ file: c.file, side: /** @type {const} */ ('after') }]),
  ]);
  /** @type {Picture[]} */
  const diffs = rows
    .filter(({ change: c }) => c.diff)
    .map(({ change: c }) => ({ file: c.file, side: 'diff' }));
  return [...sides, ...diffs].slice(0, limit);
}

/**
 * A picture's key in the uploaded links.
 *
 * @param {Picture} p
 */
export const keyOf = (p) => `${p.side}:${p.file}`;

/**
 * The block's Markdown.
 *
 * @param {{ rows: Line[], links: Map<string, string>, base: string }} input
 *   `links`: each uploaded picture's attachment URL, by keyOf
 */
export function renderTable({ rows, links, base }) {
  const count = rows.length;
  /**
   * @param {Line} row
   * @param {'before' | 'after' | 'diff'} side
   */
  const cell = (row, side) => {
    const { change } = row;
    if (side === 'before' && change.kind === 'added') return 'new';
    if (side === 'after' && change.kind === 'removed') return 'removed';
    const url = links.get(keyOf({ file: change.file, side }));
    if (!url) return 'not shown (too many pictures)';
    return `<img src="${html(url)}" alt="${html(`${row.label}, ${side}`)}" width="${row.width}">`;
  };
  const out = [
    `### Visual changes: ${count} screen${count === 1 ? '' : 's'}, compared with main at \`${base.slice(0, 7)}\``,
    '',
    '| Screen | Before | After |',
    '|---|---|---|',
    ...rows.map((r) => `| ${html(r.label)} | ${cell(r, 'before')} | ${cell(r, 'after')} |`),
  ];
  const withDiff = rows.filter((r) => r.change.kind === 'changed' && r.change.diff);
  if (withDiff.length > 0) {
    out.push(
      '',
      '<details><summary>Show diffs</summary>',
      '',
      '| Screen | Diff |',
      '|---|---|',
      ...withDiff.map((r) => `| ${html(r.label)} | ${cell(r, 'diff')} |`),
      '',
      '</details>',
    );
  }
  return out.join('\n');
}
