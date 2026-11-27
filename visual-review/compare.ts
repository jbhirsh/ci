// The comparison behind `Visual changes` (ci#64): a PR's screenshots
// against main's of the commit the PR is built on, each a folder tree of
// PNGs as visual-shots uploaded it. Shots pair by their path in the tree. A
// pair that differs in more than `ratio` of its pixels, or in size, has
// changed; a shot only the PR has is new; one only main has is gone.
//
// Both trees come from artifacts, and the PR's from the PR's own code, so
// every path is checked here, where it enters: a shot's path is folders and
// a file name of letters, digits, `.`, `_` and `-`, ending `.png`, and no
// part is `.` or `..`. Anything else stops the comparison rather than being
// skipped, since a PR that hides a screen behind an odd name must not pass.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { diff } from '../lib/pixels.ts';
import { lookAt } from './zoom.ts';
import type { Pixels } from '../lib/pixels.ts';
import type { Look } from './zoom.ts';

/** The most a shot may weigh, as GitHub caps an attached image. */
export const MAX_SHOT_BYTES = 10 * 1024 * 1024;
/** The most shots a tree may hold: far beyond any app's, an artifact's bound. */
export const MAX_SHOTS = 1000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Whether a path in a shots tree is one this takes.
 *
 * @param file posix, relative
 */
export function isShotPath(file: string) {
  const parts = file.split('/');
  return (
    file.endsWith('.png') &&
    parts.every((p) => /^[A-Za-z0-9._-]+$/.test(p) && p !== '.' && p !== '..')
  );
}

/**
 * Every PNG under a folder, as sorted posix paths relative to it. Throws on
 * a path isShotPath refuses, or on a link: a shot is a plain file.
 */
export function shotsIn(root: string) {
  const found: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const file = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(file);
      else if (!entry.isFile()) throw new Error(`not a plain file in the screenshots: ${file}`);
      else if (!entry.name.endsWith('.png')) continue;
      else if (!isShotPath(file)) throw new Error(`not a screenshot's name: ${file}`);
      else found.push(file);
    }
  };
  walk('');
  if (found.length > MAX_SHOTS) throw new Error(`more than ${MAX_SHOTS} screenshots`);
  return found.sort();
}

/** One shot that isn't the same in both. */
export type Change = {
  /** its path in the trees */
  file: string;
  kind: 'changed' | 'added' | 'removed';
  /** the share of pixels that differ (1: resized) */
  ratio?: number;
  /** pixelmatch's picture of the difference */
  diff?: Buffer;
  /** the two shots differ in size */
  resized?: true;
  /** where a change under `minor` is */
  look?: Look;
  /** the PR's shot's SHA-256, '' when it's gone */
  after: string;
};

/**
 * The PR's shots against main's.
 *
 * @param options `before`: main's tree; `after`: the PR's; `minor`: the share
 *   under which a change is small (0.001), and gets a look (zoom.ts)
 * @returns in path order
 */
export function compareShots({
  before,
  after,
  ratio,
  minor = 0.001,
  pixels,
}: {
  before: string;
  after: string;
  ratio: number;
  minor?: number;
  pixels: Pixels;
}): Change[] {
  const main = shotsIn(before);
  const pr = shotsIn(after);
  const read = (root: string, file: string) => {
    const bytes = readFileSync(path.join(root, file));
    if (bytes.length > MAX_SHOT_BYTES) throw new Error(`${file} is over 10 MB`);
    if (!bytes.subarray(0, 8).equals(PNG)) throw new Error(`${file} is not a PNG`);
    return bytes;
  };
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const changes: Change[] = [];
  for (const file of [...new Set([...main, ...pr])].sort()) {
    if (!pr.includes(file)) {
      changes.push({ file, kind: 'removed', after: '' });
      continue;
    }
    const b = read(after, file);
    if (!main.includes(file)) {
      changes.push({ file, kind: 'added', after: sha(b) });
      continue;
    }
    const d = diff(read(before, file), b, pixels, { withImage: true, maskBelow: minor });
    if (d.ratio <= ratio) continue;
    // Where a small change is comes with the first pass, but only for one.
    const look = d.mask ? lookAt(d.mask, d.width ?? 0, d.height ?? 0) : null;
    changes.push({
      file,
      kind: 'changed',
      ratio: d.ratio,
      after: sha(b),
      ...(d.image ? { diff: d.image } : {}),
      ...(d.resized ? { resized: true } : {}),
      ...(look ? { look } : {}),
    });
  }
  return changes;
}
