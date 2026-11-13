// Self-test of visual regression's shared parts against an app's checkout,
// its dependencies installed: `node visual-baselines/selftest.mjs <app dir>`.
// Checks that
//   - the app's `visual-baselines` settings parse (an app without them is
//     told so, not failed: it doesn't use the shared parts yet);
//   - its `folders` match folders git tracks, holding PNGs;
//   - with `columns` set: each column picks at least one tracked baseline, so
//     a renamed project can't quietly empty the PR's table, and how many
//     states pair is logged (not a failure: a phone suite may cover fewer);
//   - it says how a rewrite gets fresh baselines: a `command`, or an
//     `artifact` from one of its workflows;
//   - for a comparison (an `artifact` app): `folders` names one folder, and
//     pngjs reads every baseline;
//   - with `verify` set: its command is what its check's job runs
//     (verify-check.mjs);
//   - with a scripts/vercel-ignore.mjs in the app, whatever its settings: it
//     skips the baselines bot's amend on a preview and builds everything
//     else (vercel-ignore.mjs's cases).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig } from '../lib/app.mjs';
import { changedBaselines, pairBaselines } from '../lib/baselines.mjs';
import { readPng } from '../lib/pixels.mjs';
import { knownFiles, matchingFolders, runIn } from './baselines.mjs';
import { shots } from './from-run.mjs';
import { settings, singleFolder } from './settings.mjs';
import { checkVerify } from './verify-check.mjs';
import { checkIgnore } from './vercel-ignore.mjs';

/**
 * @param {string} root
 * @returns {Promise<string[]>} what to print; throws on the first problem
 */
export async function selftest(root) {
  const ignore = checkIgnore(root);
  const lines = await baselines(root);
  return ignore ? [...lines, ignore] : lines;
}

/**
 * The checks of the app's `visual-baselines` settings.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function baselines(root) {
  const config = appConfig('visual-baselines', root);
  if (Object.keys(config).length === 0) {
    return ['visual-baselines: no settings; the app uses no shared visual regression yet.'];
  }
  const s = settings(config);
  const tracked = knownFiles(runIn(root)).filter((file) => file.endsWith('.png'));
  const folders = matchingFolders(tracked, s.folders);
  if (folders.length === 0) {
    throw new Error(`visual-baselines.folders (${s.folders.join(', ')}) holds no PNGs git knows`);
  }
  const count = tracked.filter((file) => folders.some((f) => file.startsWith(`${f}/`))).length;
  const lines = [`visual-baselines: ${count} baselines in ${folders.join(', ')}.`];
  if (s.columns) lines.push(pairing(tracked, s.folders, s.columns));
  if (!s.command && !s.artifact) {
    throw new Error(
      '.github/ci.json: visual-baselines needs a command or an artifact to rewrite them',
    );
  }
  if (s.command) lines.push(`visual-baselines: rewritten by \`${s.command}\`.`);
  if (s.verify) lines.push(checkVerify(root, s.verify));
  if (!s.artifact) return lines;

  const { workflow, name } = s.artifact;
  if (!existsSync(path.join(root, '.github', 'workflows', workflow))) {
    throw new Error(`visual-baselines.artifact.workflow: no .github/workflows/${workflow}`);
  }
  const folder = path.join(root, singleFolder(s));
  for (const shot of shots(folder)) readPng(path.join(folder, shot));
  lines.push(
    `visual-baselines: rewritten from ${workflow}'s ${name}; compared with up to ${Number((s.ratio * 100).toFixed(4))}% of pixels differing.`,
  );
  return lines;
}

/**
 * How the tracked baselines pair under `columns`, as a log line; throws when
 * a column picks none.
 *
 * @param {string[]} tracked the tracked PNGs
 * @param {string[]} folders
 * @param {import('../lib/baselines.mjs').Column[]} columns
 */
export function pairing(tracked, folders, columns) {
  const all = changedBaselines(
    tracked.map((filename) => ({ filename, status: 'added' })),
    { folders },
  );
  const { rows } = pairBaselines(all, columns);
  const empty = columns.filter((c) => !rows.some((row) => row.cells[c.label]));
  if (empty.length > 0) {
    throw new Error(
      `visual-baselines.columns: ${empty.map((c) => c.label).join(', ')} picks no tracked baseline (${empty.map((c) => c.file.join(' or ')).join('; ')})`,
    );
  }
  const states = new Set(rows.map((row) => row.state)).size;
  const whole = rows.filter((row) => columns.every((c) => row.cells[c.label])).length;
  return `visual-baselines: ${states} states in ${columns.map((c) => c.label).join(' / ')}, ${whole} with every column.`;
}

/** @param {string[]} argv */
export async function cli(argv) {
  const [dir] = argv;
  if (!dir) throw new Error('usage: selftest.mjs <app dir>');
  for (const line of await selftest(path.resolve(dir))) console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cli(process.argv.slice(2));
}
