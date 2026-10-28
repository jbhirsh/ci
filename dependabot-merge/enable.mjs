// Turns on auto-merge (rebase) for a Dependabot npm PR, once. It runs where
// a PR's checks finish, never as a check on the PR, so PRs list no "Enable
// auto-merge" row: in the apps it's a step of autofix (../autofix/
// action.yml), which runs whenever a check on a bot's PR completes; here,
// .github/workflows/dependabot-merge.yml runs it when CI completes. Either
// fires again and again, so it acts only on an open Dependabot npm PR that
// has never had auto-merge set: a person who turns it off on one PR doesn't
// see it switched back on.
//
//   node enable.mjs   (env: GITHUB_REPOSITORY; PR_NUMBER, or HEAD_BRANCH to
//                      look it up; GH_TOKEN for gh)

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** @typedef {(args: string[]) => string} Gh */

/** Dependabot's npm branches; github-actions bumps are merged by hand. */
export const NPM_BRANCH = 'dependabot/npm_and_yarn/';

/**
 * @typedef {object} Pr
 * @property {string} state
 * @property {{ login: string }} author
 * @property {string} headRefName
 * @property {unknown} autoMergeRequest null when auto-merge is off
 */

/**
 * Whether to turn auto-merge on, and why (not).
 *
 * @param {Pr} pr
 * @param {string[]} events the PR's timeline event names
 * @returns {{ enable: boolean, reason: string }}
 */
export function decide(pr, events) {
  if (pr.state !== 'OPEN') return { enable: false, reason: 'the PR is not open' };
  if (!/^(app\/)?dependabot(\[bot\])?$/.test(pr.author.login)) {
    return { enable: false, reason: 'not a Dependabot PR' };
  }
  if (!pr.headRefName.startsWith(NPM_BRANCH)) {
    return { enable: false, reason: 'not an npm bump (those are merged by hand)' };
  }
  if (pr.autoMergeRequest) return { enable: false, reason: 'auto-merge is already on' };
  if (events.includes('auto_merge_enabled') || events.includes('auto_merge_disabled')) {
    return { enable: false, reason: 'auto-merge was set on it before; it stays as it is' };
  }
  return { enable: true, reason: 'turning auto-merge on' };
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {Gh} gh
 * @returns {string} what it did
 */
export function enable(env, gh) {
  const repo = env.GITHUB_REPOSITORY ?? '';
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set');
  let number = env.PR_NUMBER ?? '';
  if (!number && env.HEAD_BRANCH) {
    number = gh([
      'pr',
      'list',
      '--repo',
      repo,
      '--head',
      env.HEAD_BRANCH,
      '--state',
      'open',
      '--json',
      'number',
      '--jq',
      '.[0].number // empty',
    ]).trim();
  }
  if (!number) return 'no open PR for this run';
  /** @type {Pr} */
  const pr = JSON.parse(
    gh([
      'pr',
      'view',
      number,
      '--repo',
      repo,
      '--json',
      'state,author,headRefName,autoMergeRequest',
    ]),
  );
  const events = gh([
    'api',
    `repos/${repo}/issues/${number}/timeline`,
    '--paginate',
    '--jq',
    '.[].event',
  ])
    .split('\n')
    .filter(Boolean);
  const { enable: on, reason } = decide(pr, events);
  if (on) gh(['pr', 'merge', number, '--repo', repo, '--auto', '--rebase']);
  return `#${number}: ${reason}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(enable(process.env, (args) => execFileSync('gh', args, { encoding: 'utf8' })));
}
