// When Claude autofix may act on a PR's head, decided from the head's
// workflow runs, with no list of workflows to keep in step. Nothing here
// waits: autofix runs on every `completed` of the workflows its stub lists,
// so each run asks whether the moment has come and, if not, exits having
// done nothing. The completion that makes it true starts the run that acts.
//
// - CI fixer (`pending`): acts only once no pull-request run on the head is
//   still going, so its one attempt per head sees every failure, a slow
//   workflow's included (on fog-and-frontier #235 the Smoke gate failed
//   after a fix had already started without it). Left out: autofix's own
//   runs, and the workflows the app exempts (`autofix.exempt` in
//   `.github/ci.json`, read from the default branch), which don't wake
//   autofix, so waiting for one could wait for a completion that starts
//   nothing. check-triggers.mjs, a step of each app's CI, makes sure every
//   other pull-request workflow is in the stub's list, so the last of them
//   to finish always wakes a run. Only `pull_request` runs count: they're
//   the ones whose completion starts the autofix job (its `if:`), so a run
//   from another event (a push to the bot's branch, a deployment) can't
//   hold it up. A workflow with no run on the head doesn't either.
// - Review fixer (`green`): acts once ci.yml and claude-review.yml are both
//   green on the head; whichever listed workflow finishes last does it.
//
// A re-run keeps its run's id and updates its status; a new run of the same
// workflow on the head has a higher id and replaces the older one.
//
// CLI, run from the app's checkout with GH_TOKEN, GITHUB_REPOSITORY and
// HEAD_SHA set; prints its answer on stdout (empty: go ahead):
//   node gate.mjs pending   (WORKFLOW_REF: autofix's own, BASE_REF) the
//                           workflows still running on the head
//   node gate.mjs green <file>...   the named workflow files not yet green
//                           on the head, as `file (status/conclusion)`

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { appRoot } from '../lib/app.mjs';
import { autofixSettings } from './settings.mjs';

/**
 * A workflow run as the REST API returns it, the fields read here.
 *
 * @typedef {object} Run
 * @property {number} id
 * @property {string} name the workflow's `name:`
 * @property {string} path e.g. `.github/workflows/ci.yml`
 * @property {string} event
 * @property {string} status
 * @property {string | null} conclusion
 */

/**
 * The stub's repo-relative path, from `github.workflow_ref`
 * (`owner/repo/.github/workflows/claude-autofix.yml@refs/heads/main`).
 *
 * @param {string} ref
 * @returns {string}
 */
export function workflowPath(ref) {
  const match = /^[^/@]+\/[^/@]+\/(\.github\/workflows\/[^@]+)@/.exec(ref);
  if (!match) throw new Error(`not a workflow ref: ${ref}`);
  return match[1];
}

/**
 * Workflow runs from the API's JSON: a page (`{ workflow_runs }`), or the
 * array of pages `gh api --paginate --slurp` prints. Throws on anything
 * else, and on a run missing a field this module reads.
 *
 * @param {unknown} json
 * @returns {Run[]}
 */
export function runsFromApi(json) {
  const pages = Array.isArray(json) ? json : [json];
  return pages.flatMap((page) => {
    const runs =
      typeof page === 'object' && page !== null
        ? /** @type {Record<string, unknown>} */ (page).workflow_runs
        : undefined;
    if (!Array.isArray(runs)) throw new Error('expected a page of workflow runs');
    return runs.map((run) => {
      if (typeof run !== 'object' || run === null)
        throw new Error('a workflow run must be an object');
      const r = /** @type {Record<string, unknown>} */ (run);
      const conclusion = r.conclusion;
      if (
        typeof r.id !== 'number' ||
        typeof r.name !== 'string' ||
        typeof r.path !== 'string' ||
        typeof r.event !== 'string' ||
        typeof r.status !== 'string' ||
        (conclusion !== null && typeof conclusion !== 'string')
      ) {
        throw new Error(`workflow run ${String(r.id)} is missing a field`);
      }
      return {
        id: r.id,
        name: r.name,
        path: r.path,
        event: r.event,
        status: r.status,
        conclusion: /** @type {string | null} */ (conclusion),
      };
    });
  });
}

/**
 * The latest `pull_request` run of each workflow, keyed by `key` (its name
 * or its file).
 *
 * @param {Run[]} runs
 * @param {(run: Run) => string} key
 * @returns {Map<string, Run>}
 */
export function latestRuns(runs, key) {
  /** @type {Map<string, Run>} */
  const latest = new Map();
  for (const run of runs) {
    if (run.event !== 'pull_request') continue;
    const k = key(run);
    const seen = latest.get(k);
    if (!seen || run.id > seen.id) latest.set(k, run);
  }
  return latest;
}

/**
 * The workflows whose latest `pull_request` run on the head hasn't
 * finished, by name, leaving out autofix's own (by its file) and the
 * exempt ones. Empty means the CI fixer may go.
 *
 * @param {Run[]} runs the head's runs
 * @param {{ self: string, exempt: string[] }} skip `self`: autofix's
 *   workflow file; `exempt`: workflow names
 * @returns {string[]}
 */
export function pendingWorkflows(runs, { self, exempt }) {
  const counted = runs.filter((run) => run.path !== self && !exempt.includes(run.name));
  return [...latestRuns(counted, (run) => run.path).values()]
    .filter((run) => run.status !== 'completed')
    .map((run) => run.name)
    .sort();
}

/**
 * The named workflow files whose latest run on the head isn't
 * completed/success (no run counts as not green), each with its state.
 * Empty means the review fixer may go.
 *
 * @param {Run[]} runs the head's runs
 * @param {string[]} files e.g. `ci.yml`
 * @returns {string[]}
 */
export function notGreen(runs, files) {
  const latest = latestRuns(runs, (run) => run.path.replace(/^.*\//, ''));
  return files.flatMap((file) => {
    const run = latest.get(file);
    if (!run) return [`${file} (no run)`];
    if (run.status === 'completed' && run.conclusion === 'success') return [];
    return [`${file} (${run.status}/${run.conclusion ?? 'none'})`];
  });
}

/**
 * @param {string} name
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function required(name, env) {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * The CLI, minus process handling and the API call.
 *
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 * @param {{ root: string, fetchRuns: (repo: string, sha: string) => unknown }} io
 * @returns {string}
 */
export function main(args, env, { root, fetchRuns }) {
  const [mode, ...files] = args;
  if (mode !== 'pending' && mode !== 'green') {
    throw new Error('usage: gate.mjs pending | gate.mjs green <workflow file>...');
  }
  if (mode === 'green' && files.length === 0) throw new Error('green needs workflow files');
  /** @type {{ self: string, exempt: string[] }} */
  let skip = { self: '', exempt: [] };
  if (mode === 'pending') {
    const ref = `origin/${env.BASE_REF || 'main'}`;
    skip = {
      self: workflowPath(required('WORKFLOW_REF', env)),
      exempt: Object.keys(autofixSettings({ root, ref }).exempt),
    };
  }
  const repo = required('GITHUB_REPOSITORY', env);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error(`GITHUB_REPOSITORY must be owner/name, not ${repo}`);
  const sha = required('HEAD_SHA', env);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`HEAD_SHA must be a commit SHA, not ${sha}`);
  const runs = runsFromApi(fetchRuns(repo, sha));
  return (mode === 'pending' ? pendingWorkflows(runs, skip) : notGreen(runs, files)).join(', ');
}

/* c8 ignore start: the CLI's lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  /** @type {(repo: string, sha: string) => unknown} */
  const fetchRuns = (repo, sha) =>
    JSON.parse(
      execFileSync(
        'gh',
        [
          'api',
          '--paginate',
          '--slurp',
          `repos/${repo}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100`,
        ],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      ),
    );
  console.log(main(process.argv.slice(2), process.env, { root: appRoot(), fetchRuns }));
}
/* c8 ignore stop */
