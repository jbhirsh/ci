// Which freshly taken README screenshots replace the README's: each PNG in
// <fresh dir> is compared with its namesake in the app's screenshots folder
// (settings.mjs: `dir`) and copied to <out dir> when it's new, a different
// size, or more than CHANGED_RATIO of its pixels differ, so anti-aliasing
// noise between runs never opens a PR.
//
//   node compare.mjs <fresh dir> <out dir>
//
// Lists the replacements on stderr and sets the `changed` output to
// them (space-separated). The README's folder itself is left alone: the job
// holding the token writes them there (publish.mjs). Pixels are compared
// as lib/pixels.mjs says, so the app lists pixelmatch and pngjs among its
// devDependencies.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { appConfig, appRoot } from '../lib/app.mjs';
import { appPixels, diff } from '../lib/pixels.mjs';
import { CHANGED_RATIO, isShotName, settings } from './settings.mjs';

/** @typedef {import('../lib/pixels.mjs').Pixels} Pixels */

export { appPixels };

/**
 * The share of pixels that differ between two PNGs, or 1 when their sizes
 * differ (lib/pixels.mjs's diff).
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @param {Pixels} pixels
 */
export function diffRatio(a, b, pixels) {
  return diff(a, b, pixels).ratio;
}

/**
 * Whether a fresh shot replaces the README's (undefined: there's none yet).
 *
 * @param {Buffer | undefined} existing
 * @param {Buffer} shot
 * @param {Pixels} pixels
 */
export function shouldReplace(existing, shot, pixels) {
  return existing === undefined || diffRatio(existing, shot, pixels) > CHANGED_RATIO;
}

/**
 * Copies each fresh shot that should replace the README's into `out`, and
 * returns their names, sorted.
 *
 * @param {{ fresh: string, docs: string, out: string, pixels: Pixels }} dirs
 */
export function compare({ fresh, docs, out, pixels }) {
  mkdirSync(out, { recursive: true });
  const names = readdirSync(fresh)
    .filter((name) => name.endsWith('.png'))
    .sort();
  const bad = names.filter((name) => !isShotName(name));
  if (bad.length > 0) throw new Error(`not a screenshot name: ${bad.join(', ')}`);
  /** @type {string[]} */
  const replaced = [];
  for (const name of names) {
    const target = path.join(docs, name);
    const shot = readFileSync(path.join(fresh, name));
    if (!shouldReplace(existsSync(target) ? readFileSync(target) : undefined, shot, pixels))
      continue;
    copyFileSync(path.join(fresh, name), path.join(out, name));
    replaced.push(name);
  }
  return replaced;
}

/**
 * @param {string[]} argv
 * @param {string} [root]
 */
export async function main(argv, root = appRoot()) {
  const [fresh, out] = argv;
  if (!fresh || !out) throw new Error('usage: compare.mjs <fresh dir> <out dir>');
  const { dir } = settings(appConfig('readme-screenshots', root));
  const replaced = compare({
    fresh: path.resolve(fresh),
    docs: path.join(root, dir),
    out: path.resolve(out),
    pixels: await appPixels(root),
  });
  setOutput('changed', replaced.join(' '));
  return replaced;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const replaced = await main(process.argv.slice(2));
  console.error(`readme-screenshots: ${replaced.length} replaced`);
  for (const name of replaced) console.error(`  ${name}`);
}
