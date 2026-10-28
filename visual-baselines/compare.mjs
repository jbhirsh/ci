// Compares freshly taken screenshots with the committed baselines, for an
// app whose screenshots don't come from a runner that compares them itself
// (Playwright does, in BoardGames and fog-and-frontier; sift's come from the
// iOS Simulator). Each PNG in <fresh dir> is matched with its namesake in
// the baselines folder (settings.mjs): one differing in more than `ratio` of
// its pixels, or in size, has changed; one with no baseline is new; a
// baseline with no screenshot is missing. Any of these fails, and lands in
// <out dir> as <name>.actual.png and, for a change, <name>.diff.png
// (pixelmatch paints the differing pixels red), for the job to upload.
//
//   node compare.mjs <fresh dir> <out dir>
//
// The fix for an intended change is a rewrite of the baselines on the
// branch (the app's visual-baselines.yml).

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { summary } from '../lib/actions.mjs';
import { appConfig, appRoot } from '../lib/app.mjs';
import { appPixels, diff } from '../lib/pixels.mjs';
import { shots } from './from-run.mjs';
import { isShotName, settings, singleFolder } from './settings.mjs';

/**
 * @typedef {object} Result
 * @property {{ name: string, ratio: number, resized?: true }[]} changed
 * @property {string[]} added screenshots with no baseline
 * @property {string[]} missing baselines with no screenshot
 */

/**
 * @param {{ fresh: string, baselines: string, out: string, ratio: number,
 *   pixels: import('../lib/pixels.mjs').Pixels }} options
 * @returns {Result}
 */
export function compare({ fresh, baselines, out, ratio, pixels }) {
  const taken = shots(fresh);
  const bad = taken.filter((name) => !isShotName(name));
  if (bad.length > 0) throw new Error(`not a screenshot name: ${bad.join(', ')}`);
  const expected = shots(baselines);
  mkdirSync(out, { recursive: true });
  /** @type {Result} */
  const result = {
    changed: [],
    added: taken.filter((name) => !expected.includes(name)),
    missing: expected.filter((name) => !taken.includes(name)),
  };
  const keep = (/** @type {string} */ name) =>
    copyFileSync(path.join(fresh, name), path.join(out, name.replace(/\.png$/, '.actual.png')));
  for (const name of result.added) keep(name);
  for (const name of taken.filter((n) => expected.includes(n))) {
    const d = diff(
      readFileSync(path.join(baselines, name)),
      readFileSync(path.join(fresh, name)),
      pixels,
      { withImage: true },
    );
    if (d.ratio <= ratio) continue;
    result.changed.push(d.resized ? { name, ratio: 1, resized: true } : { name, ratio: d.ratio });
    keep(name);
    if (d.image) writeFileSync(path.join(out, name.replace(/\.png$/, '.diff.png')), d.image);
  }
  return result;
}

/**
 * The job summary's report, empty when everything matched.
 *
 * @param {Result} result
 * @param {number} ratio
 */
export function report({ changed, added, missing }, ratio) {
  if (changed.length + added.length + missing.length === 0) return '';
  const lines = ['### Visual regression', ''];
  // Three decimals: one pixel of an iPhone screenshot is 0.00003%, so a
  // change shows as at least 0.001%.
  const percent = (/** @type {number} */ r) =>
    `${r > 0 && r < 0.00001 ? '<0.001' : (r * 100).toFixed(3)}%`;
  for (const { name, ratio: r, resized } of changed) {
    lines.push(
      `- \`${name}\` changed: ${resized ? 'a different size' : `${percent(r)} of its pixels`}`,
    );
  }
  for (const name of added) lines.push(`- \`${name}\` is new: it has no baseline`);
  for (const name of missing) lines.push(`- \`${name}\` wasn't taken`);
  lines.push(
    '',
    `Allowed: ${percent(ratio)} of a screenshot's pixels. The \`visual-diffs\` artifact holds each screenshot as taken and, for a change, its diff. If the change is meant, run visual-baselines.yml on this branch to rewrite the baselines.`,
  );
  return lines.join('\n');
}

/**
 * @param {string[]} argv
 * @param {string} [root]
 */
export async function main(argv, root = appRoot()) {
  const [fresh, out] = argv;
  if (!fresh || !out) throw new Error('usage: compare.mjs <fresh dir> <out dir>');
  const s = settings(appConfig('visual-baselines', root));
  const result = compare({
    fresh: path.resolve(fresh),
    baselines: path.join(root, singleFolder(s)),
    out: path.resolve(out),
    ratio: s.ratio,
    pixels: await appPixels(root),
  });
  const text = report(result, s.ratio);
  if (text) summary(text);
  return { result, text };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { text } = await main(process.argv.slice(2));
  if (text) {
    console.error(text);
    process.exit(1);
  }
  console.log('Every screenshot matches its baseline.');
}
