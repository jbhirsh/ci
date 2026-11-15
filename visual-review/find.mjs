// Which reviews an event calls for (ci#64), as the matrix the review job
// runs: each a PR's or a mockup's screenshot run (review.mjs's Target).
// Every trigger lands here, and none waits on a clock:
//
//   - the screenshot workflow finished:
//       on a PR: that PR's review;
//       a push to main: every open PR whose `Visual changes` waits for
//         main's shots of that commit, and every mockup run built on it;
//       a run by hand (a mockup): its review;
//   - another workflow finished on a PR (the GIF bot's), a person edited
//     the description, or auto-merge was turned on or off
//     (pull_request_target): the PR's review again, from its newest
//     finished screenshot run, since its pictures or auto-merge changed.
//
// It runs main's code and reads the event and the API only.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { appConfig, appRoot } from '../lib/app.mjs';
import { ghApi } from '../lib/comment.mjs';
import { newest, pages, statusFrom } from '../lib/github.mjs';
import { pullOfRun } from '../lib/run-pr.mjs';
import { settings } from './settings.mjs';
import { CONTEXT } from './status.mjs';

/**
 * The run, as far as this reads it.
 *
 * @typedef {{ id: number, event: string, head_sha: string, head_branch?: string | null,
 *   path?: string, status?: string }} Run
 */

/**
 * A PR, as far as this reads it.
 *
 * @typedef {{ number: number, state: string, head: { sha: string,
 *   repo: { full_name: string } | null }, base?: { ref: string } }} Pull
 */

/**
 * The newest finished pull_request run of the screenshot workflow on a
 * commit, or null.
 *
 * @param {import('../lib/comment.mjs').Api} api
 * @param {string} repo
 * @param {string} workflow
 * @param {string} sha
 */
export function latestRun(api, repo, workflow, sha) {
  const got = /** @type {{ workflow_runs?: Run[] }} */ (
    api(
      'GET',
      `repos/${repo}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${sha}&status=completed&per_page=10`,
    )
  );
  return newest(got.workflow_runs ?? [])?.id ?? null;
}

/**
 * The reviews an event calls for.
 *
 * @param {{ name: string, payload: Record<string, unknown>, repo: string, main: string,
 *   workflow: string, api: import('../lib/comment.mjs').Api, log: (line: string) => void }} event
 * @returns {import('./review.mjs').Target[]}
 */
export function targets({ name, payload, repo, main, workflow, api, log }) {
  /**
   * @param {number} number
   * @param {string} sha
   */
  const forPr = (number, sha) => {
    const run = latestRun(api, repo, workflow, sha);
    if (run === null) {
      log(
        `#${number}: no finished screenshot run on ${sha.slice(0, 7)} yet; its finish starts a review`,
      );
      return [];
    }
    return [{ kind: /** @type {const} */ ('pr'), number, run }];
  };

  if (name === 'pull_request_target') {
    const pr = /** @type {Pull} */ (payload.pull_request);
    if (pr.state !== 'open' || pr.head.repo?.full_name !== repo || pr.base?.ref !== main) return [];
    return forPr(pr.number, pr.head.sha);
  }
  if (name !== 'workflow_run') throw new Error(`visual-review doesn't run on ${name}`);
  const run = /** @type {Run} */ (payload.workflow_run);
  const ours = (run.path ?? '').endsWith(`/${workflow}`);
  if (run.event === 'pull_request') {
    const found = pullOfRun(run, repo, api);
    if ('why' in found) {
      log(found.why);
      return [];
    }
    // A PR into another branch has no main shots to compare with.
    if (found.pull.base?.ref !== main) return [];
    return ours
      ? [{ kind: 'pr', number: found.pull.number, run: run.id }]
      : forPr(found.pull.number, run.head_sha);
  }
  if (!ours || run.head_branch !== main) return [];
  if (run.event === 'workflow_dispatch') return [{ kind: 'issue', run: run.id }];
  if (run.event !== 'push') return [];

  // Main's shots of this commit are in: settle whatever waited on them.
  const short = run.head_sha.slice(0, 7);
  /** @type {import('./review.mjs').Target[]} */
  const out = [];
  const pulls = /** @type {Pull[]} */ (
    pages(api, `repos/${repo}/pulls?state=open&base=${encodeURIComponent(main)}`)
  );
  for (const pr of pulls) {
    if (pr.head.repo?.full_name !== repo) continue;
    const waiting = statusFrom(api, repo, pr.head.sha, CONTEXT);
    if (waiting?.state === 'pending' && waiting.description.endsWith(` of ${short}`)) {
      out.push(...forPr(pr.number, pr.head.sha));
    }
  }
  const mockups = /** @type {{ workflow_runs?: Run[] }} */ (
    api(
      'GET',
      `repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&head_sha=${run.head_sha}&status=completed&per_page=20`,
    )
  );
  for (const m of mockups.workflow_runs ?? []) out.push({ kind: 'issue', run: m.id });
  return out;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {import('../lib/comment.mjs').Api} [api]
 */
export function main(env, api = ghApi) {
  const s = settings(appConfig('visual-review', appRoot()));
  if (!s) throw new Error('.github/ci.json has no visual-review key');
  const payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  const found = targets({
    name: env.GITHUB_EVENT_NAME ?? '',
    payload,
    repo: env.GITHUB_REPOSITORY ?? '',
    main: env.DEFAULT_BRANCH ?? 'main',
    workflow: s.workflow,
    api,
    log: console.log,
  });
  setOutput('targets', JSON.stringify(found));
  setOutput('any', String(found.length > 0));
  // describe's job runs once per PR; a mockup's issue is described in its
  // review job, since nothing else writes an issue's description.
  const prs = [...new Set(found.flatMap((t) => (t.kind === 'pr' ? [t.number] : [])))];
  setOutput('prs', JSON.stringify(prs));
  return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env);
}
