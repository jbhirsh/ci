// Rewrites the baselines on this runner and commits them to the branch:
// empties the baselines folders, runs the app's `command` (settings.mjs),
// which writes them afresh, and commits what changed (baselines.mjs). For
// an app whose screenshots a Linux runner takes itself (Playwright's
// --update-snapshots); sift's come from a CI run instead (from-run.mjs).
//
//   node rewrite.mjs        (from the app's checkout, on the branch)

import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { appConfig, appRoot } from '../lib/app.mjs';
import { branchOf, commit, runIn, wipe } from './baselines.mjs';
import { settings } from './settings.mjs';

/**
 * @param {{ root: string, s: import('./settings.mjs').Settings,
 *   run: import('./baselines.mjs').Run, shell: (command: string) => void,
 *   branch: string, by: string }} options
 * @returns {boolean} whether anything was committed
 */
export function rewrite({ root, s, run, shell, branch, by }) {
  if (!s.command) {
    throw new Error('.github/ci.json: visual-baselines.command is needed to rewrite the baselines');
  }
  wipe(root, s.folders, run);
  shell(s.command);
  return commit({ globs: s.folders, branch, by, run });
}

/** @param {string} [root] */
export function main(root = appRoot()) {
  const run = runIn(root);
  return rewrite({
    root,
    s: settings(appConfig('visual-baselines', root)),
    run,
    shell: (command) => execSync(command, { cwd: root, stdio: 'inherit' }),
    branch: branchOf(process.env),
    by: process.env.REWRITTEN_BY ?? 'visual-baselines',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(main() ? 'Committed the new baselines.' : 'The baselines are already up to date.');
}
