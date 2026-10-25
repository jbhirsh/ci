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
// with pixelmatch and decoded with pngjs from the app's node_modules
// (importFromApp), so the app lists both among its devDependencies.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { appConfig, appRoot, importFromApp } from '../lib/app.mjs';
import { CHANGED_RATIO, isShotName, settings } from './settings.mjs';

/**
 * @typedef {{ width: number, height: number, data: Uint8Array }} Image
 * @typedef {object} Pixels
 * @property {(png: Buffer) => Image} read decodes a PNG
 * @property {(a: Uint8Array, b: Uint8Array, out: null, width: number, height: number,
 *   options: { threshold: number }) => number} match counts the pixels that differ
 */

/**
 * pixelmatch and pngjs, from the app.
 *
 * @param {string} root
 * @returns {Promise<Pixels>}
 */
export async function appPixels(root) {
  const pixelmatch = /** @type {{ default: Pixels['match'] }} */ (
    await importFromApp('pixelmatch', root)
  );
  const pngjs = /** @type {{ PNG: { sync: { read: Pixels['read'] } } }} */ (
    await importFromApp('pngjs', root)
  );
  return { read: (png) => pngjs.PNG.sync.read(png), match: pixelmatch.default };
}

/**
 * The share of pixels that differ between two PNGs, or 1 when their sizes
 * differ (a different framing is a change however it looks).
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @param {Pixels} pixels
 */
export function diffRatio(a, b, pixels) {
  const before = pixels.read(a);
  const after = pixels.read(b);
  if (before.width !== after.width || before.height !== after.height) return 1;
  if (before.width * before.height === 0) return 1;
  const differing = pixels.match(before.data, after.data, null, before.width, before.height, {
    threshold: 0.1,
  });
  return differing / (before.width * before.height);
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
