// Self-test of visual regression's shared parts against an app's checkout,
// its dependencies installed: `node visual-baselines/selftest.mjs <app dir>`.
// Checks that
//   - the app's `visual-baselines` settings parse (an app without them is
//     told so, not failed: it doesn't use the shared parts yet);
//   - its `folders` match folders git tracks, holding PNGs;
//   - it says how a rewrite gets fresh baselines: a `command`, or an
//     `artifact` from one of its workflows;
//   - for a comparison (an `artifact` app): `folders` names one folder, and
//     every baseline compares equal to itself with the app's pixelmatch and
//     pngjs.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig } from '../lib/app.mjs';
import { appPixels, diff } from '../lib/pixels.mjs';
import { knownFiles, matchingFolders, runIn } from './baselines.mjs';
import { shots } from './from-run.mjs';
import { settings, singleFolder } from './settings.mjs';

/**
 * @param {string} root
 * @returns {Promise<string[]>} what to print; throws on the first problem
 */
export async function selftest(root) {
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
  if (!s.command && !s.artifact) {
    throw new Error(
      '.github/ci.json: visual-baselines needs a command or an artifact to rewrite them',
    );
  }
  if (s.command) lines.push(`visual-baselines: rewritten by \`${s.command}\`.`);
  if (!s.artifact) return lines;

  const { workflow, name } = s.artifact;
  if (!existsSync(path.join(root, '.github', 'workflows', workflow))) {
    throw new Error(`visual-baselines.artifact.workflow: no .github/workflows/${workflow}`);
  }
  const folder = path.join(root, singleFolder(s));
  const pixels = await appPixels(root);
  for (const shot of shots(folder)) {
    const png = readFileSync(path.join(folder, shot));
    if (diff(png, png, pixels).ratio !== 0)
      throw new Error(`${shot} doesn't compare equal to itself`);
  }
  lines.push(
    `visual-baselines: rewritten from ${workflow}'s ${name}; compared with up to ${Number((s.ratio * 100).toFixed(4))}% of pixels differing.`,
  );
  return lines;
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
