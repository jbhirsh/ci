// The visual baselines a pull request changed, paired by state into rows of
// columns (phone and desktop, light and dark), for the tools that show or
// judge them: visuals' before/after table (ci#33) and Claude Review's look at
// the layout (ci#32). Both read the same setting, `visual-baselines.columns`
// (visual-baselines/settings.mjs says what it holds), so a PR's table and its
// review see the same pairs.
//
// The input is the pull request files API's entries (`filename`, `status`,
// `previous_filename`); a caller with git instead adapts its name-status to
// them. A changed baseline is a PNG under one of `visual-baselines.folders`.
//
// Pairing goes by basename. A column's `file` is a basename pattern holding
// `{state}` once (one or more characters, never a `/`), anchored at both
// ends, or an ordered list of them where the first that matches wins: fog's
// phone shots are `curated-mobile-mobile-linux.png` beside
// `trip-planning-mobile-linux.png`, so its phone column tries
// `{state}-mobile-mobile-linux.png` before `{state}-mobile-linux.png`. A
// baseline goes to the first column that matches it. Rows are keyed by state
// across every folder, so a phone shot in one snapshot folder pairs with the
// desktop shot in another; only when one (column, state) matches files in
// two folders does the state make a row per folder, labelled by it. A
// changed baseline no column matches (another engine) is `unpaired`.
//
// Pure: no git, no network. Names come from a PR, so nothing here trusts
// them beyond matching; a caller that puts a state into text it hands on
// checks its characters itself.

import path from 'node:path';
import { matchesAny } from './match.mjs';

/**
 * A pull request files API entry, as far as this reads it.
 *
 * @typedef {object} FileEntry
 * @property {string} filename
 * @property {string} status added, removed, modified, renamed, copied, changed or unchanged
 * @property {string} [previous_filename] a rename's old path
 */

/**
 * One column of the table: its label, the basename patterns that pick its
 * baselines (first match wins), and the width its pictures show at, if set.
 *
 * @typedef {object} Column
 * @property {string} label
 * @property {string[]} file
 * @property {number} [width]
 */

/**
 * A changed baseline: its path before the PR (null for a new one) and after
 * it (null for a deleted one, or one moved out of the folders), the files
 * API's status ("removed" for one moved out), and its folder
 * (the one matching `folders`, of the after path when there is one).
 *
 * @typedef {object} Changed
 * @property {string | null} before
 * @property {string | null} after
 * @property {string} status
 * @property {string} folder
 */

/**
 * One state's row: its cells by column label, in the columns' order, and the
 * folder when the state makes a row per folder.
 *
 * @typedef {object} Row
 * @property {string} state
 * @property {string} [folder]
 * @property {Record<string, Changed>} cells
 */

/** The placeholder a column's pattern holds once. */
export const STATE = '{state}';

/**
 * The folder among a path's ancestors that matches the globs (the deepest),
 * or null.
 *
 * @param {string} file
 * @param {string[]} folders
 */
function folderOf(file, folders) {
  const parts = file.split('/');
  for (let i = parts.length - 1; i >= 1; i--) {
    const dir = parts.slice(0, i).join('/');
    if (matchesAny(dir, folders)) return dir;
  }
  return null;
}

/**
 * Whether a path names a PNG.
 *
 * @param {string | null} file
 * @returns {file is string}
 */
const isPng = (file) => file !== null && file.toLowerCase().endsWith('.png');

/**
 * The baselines among a PR's changed files, in `folders` order then path
 * order. The options may be the whole `visual-baselines` settings: only
 * `folders` is read.
 *
 * @param {readonly FileEntry[]} files
 * @param {{ folders: string[] }} options
 * @returns {Changed[]}
 */
export function changedBaselines(files, { folders }) {
  /** @type {Changed[]} */
  const changed = [];
  for (const entry of files) {
    // Listed but not changed: nothing to show.
    if (entry.status === 'unchanged') continue;
    const removed = entry.status === 'removed';
    const moved = entry.status === 'renamed' && entry.previous_filename;
    const after = removed ? null : entry.filename;
    const before =
      entry.status === 'added' || entry.status === 'copied'
        ? null
        : moved
          ? /** @type {string} */ (entry.previous_filename)
          : entry.filename;
    const afterFolder = isPng(after) ? folderOf(after, folders) : null;
    if (afterFolder !== null) {
      changed.push({ before, after, status: entry.status, folder: afterFolder });
      continue;
    }
    // Moved out of the folders: a deletion, as far as the baselines go.
    const beforeFolder = isPng(before) ? folderOf(before, folders) : null;
    if (beforeFolder !== null) {
      changed.push({ before, after: null, status: 'removed', folder: beforeFolder });
    }
  }
  /** @param {Changed} c */
  const rank = (c) => {
    const i = folders.findIndex((glob) => matchesAny(c.folder, [glob]));
    return i === -1 ? folders.length : i;
  };
  /** @param {Changed} c */
  const key = (c) => /** @type {string} */ (c.after ?? c.before);
  return changed.sort(
    (a, b) => rank(a) - rank(b) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0),
  );
}

/**
 * A pattern as an anchored regular expression capturing its state.
 *
 * @param {string} pattern
 */
function patternRegex(pattern) {
  const [head, tail] = pattern.split(STATE);
  /** @param {string} s */
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escape(head)}([^/]+)${escape(tail)}$`);
}

/**
 * The state a basename holds under a pattern, or null when it doesn't match.
 *
 * @param {string} pattern a basename holding `{state}` once
 * @param {string} name a basename
 */
export function stateOf(pattern, name) {
  const match = patternRegex(pattern).exec(name);
  return match ? match[1] : null;
}

/**
 * The basename a pattern gives a state: stateOf's inverse.
 *
 * @param {string} pattern
 * @param {string} state
 */
export function fillPattern(pattern, state) {
  return pattern.replace(STATE, () => state);
}

/**
 * The column a baseline goes to, and its state there: the first column with
 * a pattern that matches, that column's first such pattern.
 *
 * @param {string} name a basename
 * @param {readonly Column[]} columns
 * @returns {{ label: string, state: string } | null}
 */
export function columnOf(name, columns) {
  for (const column of columns) {
    for (const pattern of column.file) {
      const state = stateOf(pattern, name);
      if (state !== null) return { label: column.label, state };
    }
  }
  return null;
}

/**
 * The changed baselines as rows by state, in the order their first baseline
 * comes, and the ones no column takes.
 *
 * @param {readonly Changed[]} changed changedBaselines' list
 * @param {readonly Column[]} columns
 * @returns {{ rows: Row[], unpaired: Changed[] }}
 */
export function pairBaselines(changed, columns) {
  /** @type {Map<string, { label: string, change: Changed }[]>} */
  const byState = new Map();
  /** @type {Changed[]} */
  const unpaired = [];
  for (const change of changed) {
    const found = columnOf(
      path.posix.basename(/** @type {string} */ (change.after ?? change.before)),
      columns,
    );
    if (!found) {
      unpaired.push(change);
      continue;
    }
    const cells = byState.get(found.state) ?? [];
    // Two of one folder's names on one (column, state), as two of a column's
    // patterns can give: the first keeps the cell, the next is listed apart.
    if (cells.some((c) => c.label === found.label && c.change.folder === change.folder)) {
      unpaired.push(change);
      continue;
    }
    cells.push({ label: found.label, change });
    byState.set(found.state, cells);
  }
  /** @param {{ label: string, change: Changed }[]} cells in the columns' order */
  const cellsOf = (cells) =>
    Object.fromEntries(
      columns
        .flatMap((c) => cells.filter((cell) => cell.label === c.label))
        .map((cell) => [cell.label, cell.change]),
    );
  /** @type {Row[]} */
  const rows = [];
  for (const [state, cells] of byState) {
    const labels = cells.map((c) => c.label);
    if (new Set(labels).size === labels.length) {
      rows.push({ state, cells: cellsOf(cells) });
      continue;
    }
    // One (column, state) in two folders: a row per folder.
    const folders = [...new Set(cells.map((c) => c.change.folder))];
    for (const folder of folders) {
      rows.push({ state, folder, cells: cellsOf(cells.filter((c) => c.change.folder === folder)) });
    }
  }
  return { rows, unpaired };
}
