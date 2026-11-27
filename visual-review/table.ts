// The table `Visual changes` writes into a PR's or a mockup issue's
// description (ci#64, ci#87): one row per screen and size, largest change
// first. Pure: the comparison's changes and the attachment links come in,
// Markdown goes out. describe/ puts it between the `describe:visual-review`
// markers, or, a screen at a time, in the slots an author put under the
// changes that made them (ci#80).
//
// A change is big when at least `minor` of the screen's pixels differ (0.1%),
// or the shot is new, gone or resized; otherwise it's minor, and shows where
// it is and a zoom of it (zoom.ts) instead of a screen that looks the same.
// Big rows are `Screen | Before | After | Diff`, the share under the name;
// minor rows are `Screen | Where | Zoom` (the zoom picture holds before, after and diff).
//
// The section is parts (describe/describe.ts says how they're written): the
// summary line (`head`), the two tables' header rows (`header:big`,
// `header:minor`), a part of rows a screen and kind (`big:<state>`,
// `minor:<state>`; no state, for a shot no column takes, named by its path or
// a state a slot can't name), and the fold's label with whether it starts
// open (`fold:open` when every change is minor, `fold:closed` otherwise).
// describe makes each table from its header and rows, so a screen under its
// change and the leftovers in the bot's block alike have one header.
//
// A row is a screen in one of the app's `columns` (phone and desktop, light
// and dark), paired by lib/baselines.ts's rules. A shot no column takes gets
// a row of its own, named by its path.
//
// The pictures are GitHub attachments, uploaded into the description by
// the attach job (attach.ts, ci#144), which swaps each picture's local path
// in the table for its link; at most UPLOAD_LIMIT go up per result: gh attaches at most 50 files a
// command. pick() decides which: one picture a row first (a big row's after,
// a minor row's zoom), then the rest of each row, then the diffs. A picture
// left out says so in its cell.

import path from 'node:path';
import { isScreenState, partMarker } from '../describe/describe.ts';
import { pairBaselines } from '../lib/baselines.ts';
import { WHERE_WIDTH, zoomWidth } from './zoom.ts';
import type { Change } from './compare.ts';
import type { Column } from '../lib/baselines.ts';
import type { Look } from './zoom.ts';

/**
 * Text as HTML, safe in a table cell: a `|` would end the cell, and GitHub
 * still reads Markdown inside HTML, so its marks (code, emphasis, links,
 * escapes) are entities too, and an `@` can't mention anyone.
 */
function html(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\|/g, '&#124;')
    .replace(/[@`*_[\]\\~]/g, (c) => `&#${c.charCodeAt(0)};`)
    .replace(/[\r\n]/g, ' ');
}

/** The most pictures one result uploads. */
const UPLOAD_LIMIT = 50;
/** A picture's width when its column sets none, in pixels. */
export const DEFAULT_WIDTH = 300;

/** A picture to upload: which side of which shot. */
export type Picture = { file: string; side: 'before' | 'after' | 'diff' | 'where' | 'zoom' };

/**
 * One row: its label, and the change it shows. A paired row also has its screen's state and its
 * column's name; a shot no column takes has neither.
 */
export type Line = { label: string; width: number; state?: string; size?: string; change: Change };

/**
 * How far a change goes, for putting the largest first: a new, gone or
 * resized shot is the whole screen.
 */
const weight = (c: Change) => (c.kind !== 'changed' || c.resized ? 2 : (c.ratio ?? 0));

/**
 * Whether a row is a minor one: its change has a look (compare.ts).
 */
export const isMinor = (row: Line) => row.change.look !== undefined;

/**
 * The changes as rows, in the table's order.
 */
export function lines(changes: readonly Change[], columns: readonly Column[]): Line[] {
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
  const out: Line[] = [];
  for (const row of rows) {
    for (const column of columns) {
      const cell = row.cells[column.label];
      if (!cell) continue;
      const change = byFile.get((cell.after ?? cell.before) as string) as Change;
      out.push({
        label: `${row.state}, ${column.label.toLowerCase()}`,
        width: column.width ?? DEFAULT_WIDTH,
        state: row.state,
        size: column.label.toLowerCase(),
        change,
      });
    }
  }
  for (const cell of unpaired) {
    const file = (cell.after ?? cell.before) as string;
    out.push({
      label: file,
      width: DEFAULT_WIDTH,
      change: byFile.get(file) as Change,
    });
  }
  return out.sort(
    (a, b) =>
      weight(b.change) - weight(a.change) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
}

/**
 * The pictures to upload, at most `limit`, in the order that matters: one a
 * row (a big row's after, a minor row's zoom, or its diff when the change is
 * too large to zoom), then the rest of each row, then the diffs.
 */
export function pick(rows: readonly Line[], limit: number = UPLOAD_LIMIT): Picture[] {
  const tiers: Picture[][] = [[], [], []];
  const add = (tier: number, file: string, side: Picture['side']) =>
    tiers[tier].push({ file, side });
  for (const row of rows) {
    const c = row.change;
    const { look } = c;
    if (look) {
      if (look.large) {
        add(0, c.file, 'diff');
        add(1, c.file, 'where');
      } else {
        add(0, c.file, 'zoom');
        add(1, c.file, 'where');
      }
      continue;
    }
    if (c.kind !== 'removed') add(0, c.file, 'after');
    if (c.kind !== 'added') add(1, c.file, 'before');
    if (c.diff) add(2, c.file, 'diff');
  }
  return tiers.flat().slice(0, limit);
}

/**
 * A picture's key in the uploaded links.
 */
export const keyOf = (p: Picture) => `${p.side}:${p.file}`;

/**
 * A share of the screen as a short label: `6.6%`, `0.07%`, `<0.01%`.
 */
export function share(ratio: number) {
  const pct = ratio * 100;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  if (pct >= 0.01) return `${pct.toFixed(2)}%`;
  return '<0.01%';
}

/**
 * The summary line above a table: how many screens, and what they were
 * compared with, the base commit linked.
 */
export function summary({
  count,
  base,
  repo,
  allMinor = false,
}: {
  count: number;
  base: string;
  repo: string;
  allMinor?: boolean;
}) {
  const what =
    count === 0
      ? 'none'
      : `${count} screen${count === 1 ? '' : 's'} changed${allMinor ? ', all minor edge differences' : ''}`;
  return `Visual changes: ${what} · compared with main at [\`${base.slice(0, 7)}\`](https://github.com/${repo}/commit/${base})`;
}

/** The two tables' header rows. */
const HEADERS = {
  big: ['| Screen | Before | After | Diff |', '|---|---|---|---|'],
  minor: ['| Screen | Where | Zoom: before, after, diff |', '|---|---|---|'],
};

/**
 * The section's Markdown: the summary, then the rows as parts.
 *
 * @param input `links`: each uploaded picture's attachment URL, by keyOf;
 *   `minor`: the share that makes a change minor, for the fold's label;
 *   `omitted`: how many more screens changed that `rows` leaves out to fit
 *   (review.ts)
 */
export function renderTable({
  rows,
  links,
  base,
  repo,
  minor,
  omitted = 0,
}: {
  rows: Line[];
  links: Map<string, string>;
  base: string;
  repo: string;
  minor: number;
  omitted?: number;
}) {
  const picture = (row: Line, side: Picture['side'], width: number) => {
    const url = links.get(keyOf({ file: row.change.file, side }));
    if (!url) return 'not shown (too many pictures)';
    return `<img src="${html(url)}" alt="${html(`${row.label}, ${side}`)}" width="${width}">`;
  };
  const name = (row: Line) => {
    const c = row.change;
    const how =
      c.kind === 'added'
        ? 'new'
        : c.kind === 'removed'
          ? 'removed'
          : c.resized
            ? 'resized'
            : share(c.ratio ?? 0);
    return `<b>${html(row.label)}</b><br><sub>${how}</sub>`;
  };
  const bigRow = (row: Line) => {
    const c = row.change;
    const before = c.kind === 'added' ? 'new' : picture(row, 'before', row.width);
    const after = c.kind === 'removed' ? 'removed' : picture(row, 'after', row.width);
    const diff = c.kind === 'changed' && c.diff ? picture(row, 'diff', row.width) : '–';
    return `| ${name(row)} | ${before} | ${after} | ${diff} |`;
  };
  const minorRow = (row: Line) => {
    const look = row.change.look as Look;
    const where = picture(row, 'where', Math.min(WHERE_WIDTH, look.width));
    const zoom = look.large
      ? picture(row, 'diff', row.width)
      : picture(row, 'zoom', zoomWidth(look));
    return `| ${name(row)} | ${where} | ${zoom} |`;
  };

  const count = new Set(rows.map((r) => r.state ?? r.label)).size;
  const smalls = rows.filter(isMinor);
  const out = [
    partMarker('head'),
    summary({ count: count + omitted, base, repo, allMinor: smalls.length === rows.length }),
  ];
  if (smalls.length > 0) {
    // The largest small change, so a reader knows how small "small" is.
    const top = smalls[0] as Line;
    const { look, ratio } = top.change;
    const px = Math.max(1, Math.round((ratio ?? 0) * (look?.width ?? 0) * (look?.height ?? 0)));
    out.push(
      '',
      `The most is ${share(ratio ?? 0)}, about ${px} pixels of a ${look?.width}×${look?.height} screen. Largest first. The outline shows where on the screen.`,
    );
  }
  if (omitted > 0) {
    out.push('', `${omitted} more screen${omitted === 1 ? '' : 's'} changed, not shown.`);
  }
  for (const kind of ['big', 'minor'] as const) {
    const ofKind = rows.filter((r) => isMinor(r) === (kind === 'minor'));
    if (ofKind.length === 0) continue;
    out.push('', partMarker(`header:${kind}`), ...HEADERS[kind]);
    const groups: Map<string, Line[]> = new Map();
    for (const row of ofKind) {
      const key = row.state !== undefined && isScreenState(row.state) ? row.state : '';
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const [state, group] of groups) {
      out.push(
        '',
        partMarker(state ? `${kind}:${state}` : kind),
        ...group.map(kind === 'big' ? bigRow : minorRow),
      );
    }
  }
  const pct = `${Number((minor * 100).toPrecision(2))}%`;
  out.push(
    '',
    partMarker(smalls.length > 0 && smalls.length === rows.length ? 'fold:open' : 'fold:closed'),
    `Minor edge differences (under ${pct})`,
  );
  return out.join('\n');
}
