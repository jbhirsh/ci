// Rewrites the baselines on this runner and commits them to the branch:
// empties the baselines folders, runs the app's `command` (settings.mjs),
// which writes them afresh, and commits what changed (baselines.mjs). For
// an app whose screenshots a Linux runner takes itself (Playwright's
// --update-snapshots); sift's come from a CI run instead (from-run.mjs).
//
// Emptying the folders drops a baseline no test takes any more, but it
// also writes every screenshot again, and a fresh one is rarely the same
// bytes: anti-aliasing moves a few pixels from run to run. So each baseline
// the first run wrote again, differently, gets its committed version back,
// and the command runs a second time. Playwright's --update-snapshots
// (mode "changed", its default) then rewrites only the screenshots that
// fail the comparison the app's tests make, and the commit holds the
// screenshots that really moved, new ones, and the ones no test takes gone.
//
// With `verify` set, the rewrite is all-or-nothing instead: it waits for
// the head commit's checks, adds the baselines to that commit and carries
// its results over (carry.mjs). Without it, it adds a commit, as before.
//
//   node rewrite.mjs        (from the app's checkout, on the branch)

import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { appConfig, appRoot } from '../lib/app.mjs';
import { branchOf, commit, push, report, restoreRewritten, runIn, wipe } from './baselines.mjs';
import { amendAndCarry, gitHubFromEnv } from './carry.mjs';
import { settings } from './settings.mjs';

/**
 * @param {{ root: string, s: import('./settings.mjs').Settings,
 *   run: import('./baselines.mjs').Run, shell: (command: string) => void,
 *   branch: string, by: string, github?: () => import('./carry.mjs').GitHub }} options
 *   `github`: the API side, read only with `verify`
 * @returns {boolean} whether anything was pushed
 */
export function rewrite({
  root,
  s,
  run,
  shell,
  branch,
  by,
  github = () => gitHubFromEnv(process.env),
}) {
  const { command, verify } = s;
  if (!command) {
    throw new Error('.github/ci.json: visual-baselines.command is needed to rewrite the baselines');
  }
  const write = () => {
    wipe(root, s.folders, run);
    shell(command);
    // Only a baseline written again differently can be noise; the command's
    // own comparison decides which of those really changed.
    if (restoreRewritten(s.folders, run).length > 0) shell(command);
  };
  if (verify) {
    return amendAndCarry({
      verify,
      globs: s.folders,
      branch,
      run,
      check: () => shell(verify.command),
      write,
      github: github(),
    });
  }
  write();
  if (!commit({ globs: s.folders, by, run })) return false;
  push({ branch, run });
  return true;
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
  process.exitCode = report(main);
}
