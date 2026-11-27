// Pairing shots into the rows of visual review's before/after table, by
// state, across columns (phone and desktop, light and dark): the columns
// setting's parser (`parseColumns`, read by visual-review/settings.ts as
// `visual-review.columns`) and the pairing of changed shots into rows
// (`pairBaselines`, used by visual-review/table.ts). Once the committed
// baselines these were first written for (ci#32, ci#33) went, this file kept
// only that logic; the name stayed.
//
// A caller hands pairBaselines its shots as `Changed` entries: a path before
// the PR (null for a new shot) and after it (null for a removed one).
//
// Pairing goes by basename. A column's `file` is a basename pattern holding
// `{state}` once (one or more characters, never a `/`), anchored at both
// ends, or an ordered list of them where the first that matches wins: fog's
// phone shots are `curated-mobile-mobile-linux.png` beside
// `trip-planning-mobile-linux.png`, so its phone column tries
// `{state}-mobile-mobile-linux.png` before `{state}-mobile-linux.png`. A
// shot goes to the first column that matches it. Rows are keyed by state
// across every folder, so a phone shot in one folder pairs with the desktop
// shot in another; only when one (column, state) matches files in two
// folders does the state make a row per folder, labelled by it. A shot no
// column matches (another engine) is `unpaired`.
//
// Pure: no git, no network. Names come from a PR, so nothing here trusts
// them beyond matching; a caller that puts a state into text it hands on
// checks its characters itself.

import path from 'node:path';

/**
 * One column of the table: its label, the basename patterns that pick its shots (first match wins),
 * and the width its pictures show at, if set.
 */
export type Column = {
  label: string;
  file: string[];
  width?: number;
};

/**
 * A changed shot: its path before the PR (null for a new one) and after it (null for a removed
 * one), its status, and its folder.
 */
export type Changed = {
  before: string | null;
  after: string | null;
  status: string;
  folder: string;
};

/**
 * One state's row: its cells by column label, in the columns' order, and the folder when the state
 * makes a row per folder.
 */
export type Row = {
  state: string;
  folder?: string;
  cells: Record<string, Changed>;
};

/** The placeholder a column's pattern holds once. */
const STATE = '{state}';

/**
 * A pattern as an anchored regular expression capturing its state.
 */
function patternRegex(pattern: string) {
  const [head, tail] = pattern.split(STATE);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escape(head)}([^/]+)${escape(tail)}$`);
}

/**
 * The state a basename holds under a pattern, or null when it doesn't match.
 *
 * @param pattern a basename holding `{state}` once
 * @param name a basename
 */
export function stateOf(pattern: string, name: string) {
  const match = patternRegex(pattern).exec(name);
  return match ? match[1] : null;
}

/**
 * The column a shot goes to, and its state there: the first column with
 * a pattern that matches, that column's first such pattern.
 *
 * @param name a basename
 * @param columns
 */
export function columnOf(
  name: string,
  columns: readonly Column[],
): { label: string; state: string } | null {
  for (const column of columns) {
    for (const pattern of column.file) {
      const state = stateOf(pattern, name);
      if (state !== null) return { label: column.label, state };
    }
  }
  return null;
}

/**
 * The changed shots as rows by state, in the order their first shot comes,
 * and the ones no column takes.
 */
export function pairBaselines(
  changed: readonly Changed[],
  columns: readonly Column[],
): { rows: Row[]; unpaired: Changed[] } {
  const byState: Map<string, { label: string; change: Changed }[]> = new Map();
  const unpaired: Changed[] = [];
  for (const change of changed) {
    const found = columnOf(path.posix.basename((change.after ?? change.before) as string), columns);
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
  /** @param cells in the columns' order */
  const cellsOf = (cells: { label: string; change: Changed }[]) =>
    Object.fromEntries(
      columns
        .flatMap((c) => cells.filter((cell) => cell.label === c.label))
        .map((cell) => [cell.label, cell.change]),
    );
  const rows: Row[] = [];
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

/**
 * A `columns` setting, checked: undefined when absent. `key` names it in
 * errors (visual-review.columns).
 */
export function parseColumns(value: unknown, key: string): Column[] | undefined {
  if (value === undefined) return undefined;
  const fail = (why: string) => {
    throw new Error(`.github/ci.json: ${key} ${why}`);
  };
  if (!Array.isArray(value) || value.length === 0) fail('must list { label, file } columns');
  const out: Column[] = [];
  for (const raw of value as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fail('must list { label, file } columns');
    }
    const c = raw as Record<string, unknown>;
    const unknown = Object.keys(c).filter((k) => !['label', 'file', 'width'].includes(k));
    if (unknown.length > 0) fail(`has an unknown key: ${unknown.join(', ')}`);
    // A label heads a Markdown table's column.
    if (
      typeof c.label !== 'string' ||
      !/^[^|\n\r<>`]+$/.test(c.label) ||
      c.label.trim() !== c.label
    ) {
      fail('labels must be text, with no | < > ` or line break');
    }
    const label = c.label as string;
    if (out.some((o) => o.label === label)) fail(`repeats the label ${label}`);
    const files = typeof c.file === 'string' ? [c.file] : c.file;
    if (
      !Array.isArray(files) ||
      files.length === 0 ||
      !files.every(
        (f) =>
          typeof f === 'string' &&
          f.split('{state}').length === 2 &&
          !f.includes('/') &&
          f.toLowerCase().endsWith('.png'),
      )
    ) {
      fail(`${label}'s file must be a .png basename holding {state} once, or a list of them`);
    }
    if (c.width !== undefined && !(Number.isInteger(c.width) && Number(c.width) > 0)) {
      fail(`${label}'s width must be a whole number of pixels`);
    }
    out.push({
      label,
      file: files as string[],
      ...(c.width === undefined ? {} : { width: c.width as number }),
    });
  }
  return out;
}
