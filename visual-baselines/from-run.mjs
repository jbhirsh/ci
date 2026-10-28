// Rewrites the baselines from the screenshots a CI run took of this commit,
// for an app whose screenshots no Linux runner can take (sift's, on the iOS
// Simulator): finds the run of `artifact.workflow` on this commit, downloads
// its `artifact.name`, puts its PNGs in the baselines folder (settings.mjs)
// and commits what changed (baselines.mjs).
//
// A baseline the run didn't take stops it: a screenshot job that stopped
// early must not delete baselines. To drop a screen, delete its baseline in
// the PR by hand.
//
//   node from-run.mjs        (from the app's checkout, on the branch; gh
//                             reads GH_TOKEN, which needs actions: read)

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig, appRoot } from '../lib/app.mjs';
import { branchOf, commit, runIn } from './baselines.mjs';
import { isShotName, settings, singleFolder } from './settings.mjs';

/**
 * The PNGs directly in a folder, by name.
 *
 * @param {string} dir
 */
export function shots(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.png'))
    .sort();
}

/**
 * Downloads `name` from the newest finished run of `workflow` on `sha` that
 * has it (a run that failed on E2E still has its screenshots; a newer one
 * that skipped them doesn't), returning the run's id.
 *
 * @param {{ run: import('./baselines.mjs').Run, workflow: string, name: string,
 *   sha: string, temp: string }} options
 */
export function downloadLatest({ run, workflow, name, sha, temp }) {
  const ids = run('gh', [
    'run',
    'list',
    '--workflow',
    workflow,
    '--commit',
    sha,
    '--status',
    'completed',
    '--limit',
    '10',
    '--json',
    'databaseId',
    '--jq',
    '.[].databaseId',
  ])
    .split('\n')
    .filter(Boolean);
  let last = '';
  for (const id of ids) {
    try {
      run('gh', ['run', 'download', id, '--name', name, '--dir', temp]);
      return id;
    } catch (error) {
      // Most likely no such artifact on this run: try the one before. The
      // last reason goes in the error, in case it was something else (a
      // token without actions: read).
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(
    `no finished ${workflow} run on ${sha.slice(0, 7)} has ${name}: run this once one has taken the screenshots${last ? ` (last: ${last.trim()})` : ''}`,
  );
}

/**
 * @param {{ root: string, s: import('./settings.mjs').Settings,
 *   run: import('./baselines.mjs').Run, sha: string, branch: string, by: string,
 *   temp: string }} options
 * @returns {boolean} whether anything was committed
 */
export function fromRun({ root, s, run, sha, branch, by, temp }) {
  const folder = singleFolder(s);
  if (!s.artifact) {
    throw new Error('.github/ci.json: visual-baselines.artifact is needed to rewrite from a run');
  }
  const { workflow, name } = s.artifact;
  const id = downloadLatest({ run, workflow, name, sha, temp });
  const fresh = shots(temp);
  const bad = fresh.filter((shot) => !isShotName(shot));
  if (bad.length > 0) throw new Error(`not a screenshot name: ${bad.join(', ')}`);
  if (fresh.length === 0) throw new Error(`${name} from run ${id} holds no screenshots`);
  const target = path.join(root, folder);
  const missing = shots(target).filter((shot) => !fresh.includes(shot));
  if (missing.length > 0) {
    throw new Error(
      `run ${id} took no ${missing.join(', ')}: rerun its screenshots, or delete those baselines by hand to drop them`,
    );
  }
  mkdirSync(target, { recursive: true });
  for (const shot of fresh) copyFileSync(path.join(temp, shot), path.join(target, shot));
  return commit({ globs: s.folders, branch, by, run });
}

/** @param {string} [root] */
export function main(root = appRoot()) {
  const run = runIn(root);
  return fromRun({
    root,
    s: settings(appConfig('visual-baselines', root)),
    run,
    sha: run('git', ['rev-parse', 'HEAD']).trim(),
    branch: branchOf(process.env),
    by: process.env.REWRITTEN_BY ?? 'visual-baselines',
    temp: mkdtempSync(path.join(tmpdir(), 'visual-baselines-')),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(main() ? 'Committed the new baselines.' : 'The baselines are already up to date.');
}
