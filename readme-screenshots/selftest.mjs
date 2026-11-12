// Self-test of the README screenshot bot against an app's checkout, its
// dependencies installed: `node readme-screenshots/selftest.mjs <app dir>`.
// Checks that
//   - the app's `readme-screenshots` settings parse (or the defaults);
//   - its screenshots folder holds PNGs, each a name the bot may write;
//   - every `shows` glob the app sets names a file git tracks;
//   - decide.mjs's rules run over the app's recent history (printed);
//   - pngjs reads every screenshot, and pixelmatch finds one wholly
//     different from one of another size.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig } from '../lib/app.mjs';
import { PIXELS, readPng } from '../lib/pixels.mjs';
import { matchesAny } from '../lib/match.mjs';
import { diffRatio } from './compare.mjs';
import { changedSince, decide } from './decide.mjs';
import { isShotName, settings } from './settings.mjs';

/** How far back decide's rules are tried. */
export const DEPTH = 20;

/**
 * @param {string} root
 * @returns {Promise<string[]>} what to print; throws on the first problem
 */
export async function selftest(root) {
  const config = appConfig('readme-screenshots', root);
  const s = settings(config);
  const docs = path.join(root, s.dir);
  if (!existsSync(docs)) throw new Error(`readme-screenshots.dir: no ${s.dir}`);
  const shots = readdirSync(docs)
    .filter((name) => name.endsWith('.png'))
    .sort();
  if (shots.length === 0) throw new Error(`no PNGs in ${s.dir}`);
  const bad = shots.filter((name) => !isShotName(name));
  if (bad.length > 0) throw new Error(`screenshot names the bot can't write: ${bad.join(', ')}`);
  const lines = [`readme-screenshots: ${shots.length} screenshots in ${s.dir}.`];

  /** @type {import('./decide.mjs').Run} */
  const run = (command, args) =>
    execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const tracked = run('git', ['ls-files']).split('\n').filter(Boolean);
  // Only globs the app chose: the defaults are a guess at a web app's layout.
  const chosen = config.shows === undefined ? [] : s.shows;
  const stale = chosen.filter((glob) => !tracked.some((file) => matchesAny(file, [glob])));
  if (stale.length > 0) {
    throw new Error(`readme-screenshots.shows names no tracked file: ${stale.join(', ')}`);
  }
  const commits = run('git', ['rev-list', '--max-count', String(DEPTH + 1), 'HEAD'])
    .split('\n')
    .filter(Boolean);
  const since = commits.at(-1) ?? '';
  const verdict = decide({ event: 'push', since, changed: changedSince(since, run), settings: s });
  lines.push(`readme-screenshots: over the last ${commits.length - 1} commits: ${verdict.reason}.`);

  const images = shots.map((name) => ({
    name,
    png: readFileSync(path.join(docs, name)),
    size: readPng(path.join(docs, name)),
  }));
  const other = images.find(
    (i) => i.size.width !== images[0].size.width || i.size.height !== images[0].size.height,
  );
  if (other && diffRatio(images[0].png, other.png, PIXELS) !== 1) {
    throw new Error(`${images[0].name} and ${other.name} differ in size but not in the comparison`);
  }
  return [...lines, `readme-screenshots: compared ${images.length} screenshots with pixelmatch.`];
}

/**
 * Runs the self-test on the app at `argv[0]` and returns the exit code.
 *
 * @param {string[]} argv
 * @param {(line: string) => void} [log]
 * @returns {Promise<number>}
 */
export async function cli(argv, log = console.log) {
  try {
    for (const line of await selftest(path.resolve(argv[0] ?? '.'))) log(line);
    return 0;
  } catch (error) {
    log(`readme-screenshots self-test failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await cli(process.argv.slice(2));
}
