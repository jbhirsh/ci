// Whether to retake the README's screenshots on this push to main: when a
// file they show (settings.mjs: `shows`, less `ignore`) changed since the
// last run of this workflow that finished, or the run was started by hand,
// or there's no finished run to count from (or its commit is gone from
// history). Counting from the last finished run, not the push's parent,
// means a UI push whose run a later push cancelled is still caught.
//
//   node decide.mjs        sets the `capture` output to true or false
//
// Runs in the app's checkout, which needs its whole history (fetch-depth
// 0). Reads the last finished run with `gh` (GH_TOKEN with actions read),
// for the workflow GITHUB_WORKFLOW_REF names, on main.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { appConfig, appRoot } from '../lib/app.mjs';
import { pick } from '../visuals/match.mjs';
import { settings } from './settings.mjs';

/**
 * The workflow file a run belongs to, from GITHUB_WORKFLOW_REF
 * (`owner/repo/.github/workflows/readme-screenshots.yml@refs/heads/main`).
 *
 * @param {string | undefined} ref
 */
export function workflowFile(ref) {
  const match = /\/\.github\/workflows\/([^/@]+)@/.exec(ref ?? '');
  if (!match) throw new Error(`GITHUB_WORKFLOW_REF names no workflow: ${ref}`);
  return match[1];
}

/**
 * The verdict, and why.
 *
 * @param {{ event: string, since: string | null, changed: string[] | null,
 *   settings: import('./settings.mjs').Settings }} input
 *   `since` is the last finished run's commit; `changed` the files changed
 *   since it (null when that commit isn't in the history)
 * @returns {{ capture: boolean, reason: string, shown: string[] }}
 */
export function decide({ event, since, changed, settings: s }) {
  if (event !== 'push') return { capture: true, reason: `run by ${event}`, shown: [] };
  if (!since) return { capture: true, reason: 'no finished run to count from', shown: [] };
  if (changed === null) {
    return { capture: true, reason: `${since.slice(0, 7)} isn't in the history`, shown: [] };
  }
  const shown = pick(changed, { include: s.shows, exclude: s.ignore });
  return shown.length > 0
    ? { capture: true, reason: `what they show changed since ${since.slice(0, 7)}`, shown }
    : { capture: false, reason: `nothing they show changed since ${since.slice(0, 7)}`, shown };
}

/**
 * @typedef {(command: string, args: string[]) => string} Run runs a command
 *   in the app's checkout, returning stdout; throws when it fails
 */

/**
 * The files changed between `since` and HEAD, or null when `since` isn't a
 * commit in the history.
 *
 * @param {string} since
 * @param {Run} run
 * @returns {string[] | null}
 */
export function changedSince(since, run) {
  try {
    run('git', ['cat-file', '-e', `${since}^{commit}`]);
  } catch {
    return null;
  }
  return run('git', ['diff', '--name-only', since, 'HEAD']).split('\n').filter(Boolean);
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {Run} run
 * @param {string} root
 */
export function main(env, run, root) {
  const s = settings(appConfig('readme-screenshots', root));
  const event = env.GITHUB_EVENT_NAME ?? 'local';
  let since = null;
  if (event === 'push') {
    since =
      run('gh', [
        'run',
        'list',
        '--repo',
        env.GITHUB_REPOSITORY ?? '',
        '--workflow',
        workflowFile(env.GITHUB_WORKFLOW_REF),
        '--branch',
        'main',
        '--status',
        'success',
        '--limit',
        '1',
        '--json',
        'headSha',
        '--jq',
        '.[0].headSha // empty',
      ]).trim() || null;
  }
  const verdict = decide({
    event,
    since,
    changed: since ? changedSince(since, run) : [],
    settings: s,
  });
  setOutput('capture', String(verdict.capture));
  return [
    `readme-screenshots: ${verdict.capture ? 'retake' : 'keep'} them: ${verdict.reason}.`,
    ...verdict.shown.map((file) => `  ${file}`),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = appRoot();
  /** @type {Run} */
  const run = (command, args) =>
    execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  for (const line of main(process.env, run, path.resolve(root))) console.log(line);
}
