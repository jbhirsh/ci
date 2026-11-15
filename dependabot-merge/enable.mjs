// Turns on auto-merge (rebase) for a Dependabot npm PR, once. It runs where
// a PR's checks finish, never as a check on the PR, so PRs list no "Enable
// auto-merge" row: in the apps it's a step of autofix (../autofix/
// action.yml), which runs whenever a check on a bot's PR completes; here,
// .github/workflows/dependabot-merge.yml runs it when CI completes. Either
// fires again and again, so it acts only on an open Dependabot npm PR that
// has never had auto-merge set: a person who turns it off on one PR doesn't
// see it switched back on.
//
// In an app that uses visual review (a `visual-review` key in main's
// .github/ci.json, ci#64), it also waits for the `Visual changes` status on
// the PR's head to find no change: a bump that moves a screen must not be
// set to merge itself before anyone sees it. visual-review calls this again
// once it has posted that status, so the wait is for that event, not a
// clock. main's settings are read through the API, since this runs before
// anything is checked out.
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
 * @property {string} [headRefOid] the head commit
 */

/** The descriptions of `Visual changes` that let a PR merge itself. */
const NO_VISUAL_CHANGE = ['No visual changes', 'No screens taken'];

/**
 * Whether to turn auto-merge on, and why (not).
 *
 * @param {Pr} pr
 * @param {string[]} events the PR's timeline event names
 * @param {string | null} [visual] in an app with visual review, the
 *   `Visual changes` description on the head (null: none yet); undefined
 *   in an app without it
 * @returns {{ enable: boolean, reason: string }}
 */
export function decide(pr, events, visual) {
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
  if (visual !== undefined && !NO_VISUAL_CHANGE.includes(visual ?? '')) {
    return {
      enable: false,
      reason: visual
        ? `Visual changes says "${visual}"; a person merges it`
        : 'waiting for Visual changes on its head',
    };
  }
  return { enable: true, reason: 'turning auto-merge on' };
}

/**
 * The `Visual changes` description on a commit, when main's settings use
 * visual review: undefined when they don't, null before the status.
 *
 * @param {string} repo
 * @param {string} sha
 * @param {Gh} gh
 */
function visualStatus(repo, sha, gh) {
  /** @type {string} */
  let text;
  try {
    text = gh(['api', `repos/${repo}/contents/.github/ci.json`, '--jq', '.content']).trim();
  } catch (error) {
    // A repository with no .github/ci.json (this one) uses no visual review.
    if (
      /\b404\b|Not Found/.test(
        `${/** @type {Error} */ (error).message}${String(/** @type {{ stderr?: unknown }} */ (error).stderr ?? '')}`,
      )
    ) {
      return undefined;
    }
    throw error;
  }
  if (!text) return undefined;
  /** @type {unknown} */
  const config = JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
  if (typeof config !== 'object' || config === null || !('visual-review' in config)) {
    return undefined;
  }
  const found = gh([
    'api',
    `repos/${repo}/commits/${sha}/statuses`,
    '--jq',
    // Only the Actions token's: anyone with statuses write can post one.
    '[.[] | select(.context == "Visual changes" and .creator.login == "github-actions[bot]")][0].description // ""',
  ]).trim();
  return found || null;
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
      'state,author,headRefName,autoMergeRequest,headRefOid',
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
  const visual = pr.headRefOid ? visualStatus(repo, pr.headRefOid, gh) : undefined;
  const { enable: on, reason } = decide(pr, events, visual);
  if (on) gh(['pr', 'merge', number, '--repo', repo, '--auto', '--rebase']);
  return `#${number}: ${reason}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(enable(process.env, (args) => execFileSync('gh', args, { encoding: 'utf8' })));
}
