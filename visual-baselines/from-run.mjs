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
// With `verify` set, the rewrite is all-or-nothing instead (carry.mjs): it
// waits for the head commit's checks, adds the baselines to that commit and
// carries its results over. `verify.command` runs with
// VISUAL_BASELINES_FRESH naming the folder holding the run's screenshots,
// for a comparison of them with the amended baselines (compare.mjs, as
// verify-check.mjs's COMPARE_COMMAND runs it).
//
//   node from-run.mjs        (from the app's checkout, on the branch; gh
//                             reads GH_TOKEN, which needs actions: read)

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig, appRoot } from '../lib/app.mjs';
import { branchOf, commit, push, report, runIn } from './baselines.mjs';
import { amendAndCarry, gitHubFromEnv } from './carry.mjs';
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
 *   temp: string, shell?: (command: string, env: Record<string, string>) => void,
 *   github?: () => import('./carry.mjs').GitHub }} options
 *   `shell` runs `verify.command`, and `github` is the API side, both read
 *   only with `verify`
 * @returns {boolean} whether anything was pushed
 */
export function fromRun({
  root,
  s,
  run,
  sha,
  branch,
  by,
  temp,
  shell = (command, env) =>
    execSync(command, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } }),
  github = () => gitHubFromEnv(process.env),
}) {
  const folder = singleFolder(s);
  const { artifact, verify } = s;
  if (!artifact) {
    throw new Error('.github/ci.json: visual-baselines.artifact is needed to rewrite from a run');
  }
  const write = () => copyShots({ root, folder, artifact, run, sha, temp });
  if (verify) {
    return amendAndCarry({
      verify,
      globs: s.folders,
      branch,
      run,
      check: () => shell(verify.command, { VISUAL_BASELINES_FRESH: temp }),
      write,
      github: github(),
    });
  }
  write();
  if (!commit({ globs: s.folders, by, run })) return false;
  push({ branch, run });
  return true;
}

/**
 * Downloads the run's screenshots into `temp` and copies them into the
 * baselines folder; throws when the run took none, or missed a baseline.
 *
 * @param {{ root: string, folder: string, artifact: { workflow: string, name: string },
 *   run: import('./baselines.mjs').Run, sha: string, temp: string }} options
 */
function copyShots({ root, folder, artifact, run, sha, temp }) {
  const { workflow, name } = artifact;
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
  process.exitCode = report(main);
}
