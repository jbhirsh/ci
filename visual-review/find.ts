// Which reviews an event calls for (ci#64), as the matrix the review job
// runs: each a PR's or a mockup's screenshot run (review.ts's Target).
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
//     An edit that changed only the contents of visual review's own block
//     and slots is the attach job's upload (ci#144) and calls for nothing
//     (ownEdit): otherwise each upload would start a review of its own.
//
// A mockup's target carries its issue's number, read from its shots'
// manifest, so the attach job's concurrency group (keyed on the number) is
// known when the job starts. It runs main's code and reads the event, the
// API and that manifest only.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { appConfig, appRoot } from '../lib/app.mjs';
import { ghApi } from '../lib/comment.mjs';
import { newest, pages, statusFrom } from '../lib/github.mjs';
import { pullOfRun } from '../lib/run-pr.mjs';
import { MANIFEST, parseManifest } from '../visual-shots/shots.mjs';
import { outsideOwnBlocks } from './record.ts';
import { settings } from './settings.ts';
import { CONTEXT } from './status.ts';

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
 * Downloads a run's visual-shots artifact into `dir`: 'none' when the run
 * has none, 'expired' when it's gone; any other failure throws, never
 * passing for "no shots".
 *
 * @param {{ api: import('../lib/comment.mjs').Api, gh: (args: string[]) => string,
 *   repo: string, runId: number, dir: string }} options gh: with the Actions token
 * @returns {'ok' | 'none' | 'expired'}
 */
export function downloadShots({ api, gh, repo, runId, dir }) {
  const found = /** @type {{ expired: boolean }[]} */ (
    pages(api, `repos/${repo}/actions/runs/${runId}/artifacts?name=visual-shots`, 'artifacts')
  );
  if (found.length === 0) return 'none';
  if (found.every((a) => a.expired)) return 'expired';
  gh(['run', 'download', String(runId), '--repo', repo, '--name', 'visual-shots', '--dir', dir]);
  return 'ok';
}

/**
 * Whether a pull_request_target event is an edit of the description that
 * changed only the contents of visual review's block and slots (record.ts):
 * the attach job's own upload. A retarget, a title edit, a slot added or
 * removed, or any change to the rest still calls for a review.
 *
 * @param {Record<string, unknown>} payload
 */
export function ownEdit(payload) {
  const changes = /** @type {{ body?: { from?: unknown }, base?: unknown } | undefined} */ (
    payload.changes
  );
  if (payload.action !== 'edited' || !changes?.body || changes.base) return false;
  const was = changes.body.from;
  const now = /** @type {{ body?: unknown }} */ (payload.pull_request).body;
  // GitHub sends null for an empty description.
  const text = (/** @type {unknown} */ v) => (v === null ? '' : v);
  const [from, to] = [text(was), text(now)];
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  return outsideOwnBlocks(from) === outsideOwnBlocks(to);
}

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
 *   workflow: string, api: import('../lib/comment.mjs').Api, log: (line: string) => void,
 *   mockupIssue: (run: number) => number | null }} event
 *   mockupIssue: the issue a run by hand's shots are a mockup for, from their
 *   manifest, or null when they're none
 * @returns {import('./review.ts').Target[]}
 */
export function targets({ name, payload, repo, main, workflow, api, log, mockupIssue }) {
  /** @param {number} run */
  const mockup = (run) => {
    /** @type {number | null} */
    let number;
    try {
      number = mockupIssue(run);
    } catch (error) {
      // One mockup's shots that can't be read fail only that mockup, never
      // the PRs settled by the same push.
      log(
        `::warning::run ${run}: its shots' manifest couldn't be read (${/** @type {Error} */ (error).message}): no mockup review`,
      );
      return [];
    }
    if (number === null) {
      log(`run ${run}: a run by hand that is no mockup: nothing to do`);
      return [];
    }
    return [{ kind: /** @type {const} */ ('issue'), number, run }];
  };
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
    if (ownEdit(payload)) {
      log(`#${pr.number}: only visual review's own block changed: nothing to review`);
      return [];
    }
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
  if (run.event === 'workflow_dispatch') return mockup(run.id);
  if (run.event !== 'push') return [];

  // Main's shots of this commit are in: settle whatever waited on them.
  const short = run.head_sha.slice(0, 7);
  /** @type {import('./review.ts').Target[]} */
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
  for (const m of mockups.workflow_runs ?? []) out.push(...mockup(m.id));
  return out;
}

/**
 * The issue a run's shots are a mockup for, from their manifest, or null.
 *
 * @param {{ api: import('../lib/comment.mjs').Api, gh: (args: string[]) => string,
 *   repo: string, run: number }} options
 */
export function mockupIssue({ api, gh, repo, run }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mockup-'));
  try {
    const got = downloadShots({ api, gh, repo, runId: run, dir });
    // Expired shots were a mockup's, maybe: say so, rather than "no mockup".
    if (got === 'expired') throw new Error('its shots have expired');
    if (got === 'none') return null;
    return parseManifest(JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'))).mockupIssue;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** gh with the job's token (GH_TOKEN), returning what it printed. */
const realGh = (/** @type {string[]} */ args) =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 300_000,
  });

/**
 * @param {Record<string, string | undefined>} env
 * @param {import('../lib/comment.mjs').Api} [api]
 * @param {(args: string[]) => string} [gh]
 */
export function main(env, api = ghApi, gh = realGh) {
  const s = settings(appConfig('visual-review', appRoot()));
  if (!s) throw new Error('.github/ci.json has no visual-review key');
  const payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  const repo = env.GITHUB_REPOSITORY ?? '';
  const found = targets({
    name: env.GITHUB_EVENT_NAME ?? '',
    payload,
    repo,
    main: env.DEFAULT_BRANCH ?? 'main',
    workflow: s.workflow,
    api,
    log: console.log,
    mockupIssue: (run) => mockupIssue({ api, gh, repo, run }),
  });
  setOutput('targets', JSON.stringify(found));
  setOutput('any', String(found.length > 0));
  return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env);
}
