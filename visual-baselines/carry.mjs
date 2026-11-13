// The all-or-nothing rewrite, for an app that sets `verify` (settings.mjs):
// rather than add a commit holding only pictures, which runs the PR's whole
// CI and a Vercel preview again on code its head commit (A) already tested,
// the rewrite adds the new baselines to A itself and carries A's results
// over (#51). In order:
//
//  1. The checks to read: the `main` branch rule's required checks
//     (`GET rules/branches/main`, which the Actions token can read; never
//     `/protection`, which needs admin), those tied to GitHub Actions or to
//     any app. A check tied to another app (Semgrep's) is left to that app,
//     which reacts to the push itself.
//     A rule that keeps none stops it: there would be nothing to carry, and
//     the PR's own runs on A′ would be cancelled (step 9). So does A
//     changing a file in .github/workflows/: GitHub refuses the Actions
//     token's push of any commit that does, and A′ would.
//  2. Their newest results on A: the check run with the highest id of that
//     name (and app), so a re-run supersedes the run it replaced, or a
//     commit status of that name. This run's own check runs are left out.
//     A status counts only from Vercel (its context starts `Vercel`), which
//     reports on A′ itself (step 8); any other would be missing on A′.
//  3. While any of them other than `verify.check` is queued or running, or
//     hasn't reported while anything else on A still is, it polls every
//     30 s for up to 15 minutes, then stops. One that hasn't reported once
//     all is still gets 2 more minutes: a smoke test starts only once its
//     preview has deployed.
//  4. Any of them concluding anything but success, skipped or neutral, or
//     never reporting, stops it, naming the check, before anything changes.
//  5. The rewrite writes the baselines, and baselines.mjs amends A with
//     them alone (A′): A's message and author, github-actions[bot] as the
//     committer, which is how the apps' Vercel ignoreCommand knows it. Every
//     file A′ changes must be in a baselines folder.
//  6. `verify.command`, exactly what `verify.check`'s job runs, runs on A′.
//     If it fails, nothing is pushed.
//  7. A′ is force-pushed with a lease on A: if anyone pushed since, git
//     refuses and nothing is posted.
//  8. `verify.check` is posted onto A′ with step 6's result, and each of
//     A's other kept check runs, "Carried over from <A>" with a link to A's
//     run. Commit statuses aren't posted: Vercel's is the one, and Vercel
//     reports success on A′ itself, its build skipped.
//  9. The Actions token's push queues the PR's pull_request workflows on A′
//     as awaiting approval (BoardGames; fog-and-frontier queued none); those
//     runs are cancelled, so the PR shows no approval prompt. If posting
//     fails, they're left, and the error says to approve them: their runs
//     report on A′ themselves.
//
// The job needs contents write (the push), checks write (step 8) and
// actions write (step 9). Every API body is built by JSON.stringify
// (lib/comment.mjs's ghApi), never spliced from text.

import { ghApi } from '../lib/comment.mjs';
import { commit, matchingFolders, push } from './baselines.mjs';

/** The GitHub Actions app, which the rule names for checks Actions reports. */
export const ACTIONS_APP = 15368;
/** The branch whose rule lists the required checks: every app's default. */
export const RULE_BRANCH = 'main';
/** The conclusions that let a PR merge. */
export const PASSED = ['success', 'skipped', 'neutral'];
/** How long A's checks may keep running, and how often they're read. */
export const WAIT_MS = 15 * 60_000;
export const POLL_MS = 30_000;
/** How long a check that never reported is waited for once all is still. */
export const QUIET_MS = 2 * 60_000;
/** Commit statuses whose app reports on A′ itself (Vercel's, #51 step 1). */
export const SELF_REPORTING = /^Vercel\b/;
/** How long the held runs on A′ are looked for, and how often. */
export const HELD_POLLS = 6;
export const HELD_POLL_MS = 10_000;
/** The most pages of check runs or statuses read on one commit. */
const PAGES = 30;

/**
 * A required check: its name, and the app it's tied to (null: any).
 *
 * @typedef {{ context: string, app: number | null }} Required
 */

/**
 * A check run on A, the fields read here.
 *
 * @typedef {object} CheckRun
 * @property {number} id
 * @property {string} name
 * @property {string} status queued, in_progress, completed, …
 * @property {string | null} conclusion
 * @property {string} url its page, linked from the carried result
 * @property {number | null} app
 * @property {string[]} links every URL it gives, to tell this run's own
 */

/**
 * A commit status on A: its context, state and link.
 *
 * @typedef {{ context: string, state: string, url: string }} Status
 */

/**
 * What to do about A's checks: carry these runs over, wait for these
 * names (or, `missing`, names that never reported, with nothing else to
 * wait for), or refuse for these reasons.
 *
 * @typedef {{ kind: 'ready', carry: CheckRun[] }
 *   | { kind: 'wait', waiting: string[] }
 *   | { kind: 'missing', reasons: string[] }
 *   | { kind: 'refuse', reasons: string[] }} Decision
 */

/**
 * The API, the run and the clock: what the GitHub side of the rewrite
 * needs.
 *
 * @typedef {object} GitHub
 * @property {import('../lib/comment.mjs').Api} api
 * @property {string} repo owner/name
 * @property {string} runId this run's id, to leave its own check runs out
 * @property {string} runUrl this run's page
 * @property {string} workflow this workflow's name
 * @property {(ms: number) => void} sleep
 * @property {() => number} now
 * @property {(line: string) => void} log
 */

/**
 * An object's field, or undefined.
 *
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function field(value, key) {
  return typeof value === 'object' && value !== null
    ? /** @type {Record<string, unknown>} */ (value)[key]
    : undefined;
}

/**
 * The required checks that matter here, from the rules the API returns for
 * a branch (any number of rulesets' rules): those tied to GitHub Actions or
 * to any app, each once. Throws on anything but a list of rules.
 *
 * @param {unknown} rules
 * @returns {Required[]}
 */
export function requiredFromRules(rules) {
  if (!Array.isArray(rules)) throw new Error('expected the branch rules, as a list');
  /** @type {Map<string, Required>} */
  const kept = new Map();
  for (const rule of rules) {
    if (field(rule, 'type') !== 'required_status_checks') continue;
    const checks = field(field(rule, 'parameters'), 'required_status_checks');
    if (!Array.isArray(checks)) throw new Error('a required_status_checks rule lists no checks');
    for (const check of checks) {
      const context = field(check, 'context');
      const app = field(check, 'integration_id') ?? null;
      if (typeof context !== 'string' || (app !== null && typeof app !== 'number')) {
        throw new Error('a required check has no name, or an app id that is not a number');
      }
      if (app !== null && app !== ACTIONS_APP) continue;
      kept.set(`${context}\0${app}`, { context, app });
    }
  }
  return [...kept.values()];
}

/**
 * Check runs from one page of `commits/{sha}/check-runs`. Throws on a page
 * of anything else.
 *
 * @param {unknown} page
 * @returns {CheckRun[]}
 */
export function checkRunsFromApi(page) {
  const runs = field(page, 'check_runs');
  if (!Array.isArray(runs)) throw new Error('expected a page of check runs');
  return runs.map((run) => {
    const id = field(run, 'id');
    const name = field(run, 'name');
    const status = field(run, 'status');
    const conclusion = field(run, 'conclusion') ?? null;
    if (
      typeof id !== 'number' ||
      typeof name !== 'string' ||
      typeof status !== 'string' ||
      (conclusion !== null && typeof conclusion !== 'string')
    ) {
      throw new Error('a check run is missing its id, name or status');
    }
    const links = [field(run, 'html_url'), field(run, 'details_url')].filter(
      (u) => typeof u === 'string' && u !== '',
    );
    const app = field(field(run, 'app'), 'id');
    return {
      id,
      name,
      status,
      conclusion: /** @type {string | null} */ (conclusion),
      url: /** @type {string | undefined} */ (links[0]) ?? '',
      app: typeof app === 'number' ? app : null,
      links: /** @type {string[]} */ (links),
    };
  });
}

/**
 * Commit statuses from one page of `commits/{sha}/status` (the newest per
 * context). Throws on a page of anything else.
 *
 * @param {unknown} page
 * @returns {Status[]}
 */
export function statusesFromApi(page) {
  const statuses = field(page, 'statuses');
  if (!Array.isArray(statuses)) throw new Error('expected a page of commit statuses');
  return statuses.map((s) => {
    const context = field(s, 'context');
    const state = field(s, 'state');
    if (typeof context !== 'string' || typeof state !== 'string') {
      throw new Error('a commit status is missing its context or state');
    }
    const url = field(s, 'target_url');
    return { context, state, url: typeof url === 'string' ? url : '' };
  });
}

/**
 * Whether a check run is this workflow run's own (a job of it).
 *
 * @param {CheckRun} run
 * @param {string} runId
 */
export function isOwn(run, runId) {
  return run.links.some((link) => link.includes(`/actions/runs/${runId}/`));
}

/**
 * Decides from A's check runs and statuses whether the rewrite can go
 * ahead. `verifyCheck` is neither waited for nor carried: the rewrite runs
 * it itself.
 *
 * @param {{ required: Required[], runs: CheckRun[], statuses: Status[],
 *   verifyCheck: string, runId: string }} options
 * @returns {Decision}
 */
export function decide({ required, runs, statuses, verifyCheck, runId }) {
  const others = runs.filter((run) => !isOwn(run, runId));
  const moving =
    others.some((run) => run.status !== 'completed') || statuses.some((s) => s.state === 'pending');
  /** @type {CheckRun[]} */
  const carry = [];
  /** @type {string[]} */
  const waiting = [];
  /** @type {string[]} */
  const failed = [];
  /** @type {string[]} */
  const missing = [];
  const seen = new Set();
  for (const { context, app } of required) {
    if (context === verifyCheck) continue;
    const newest = others
      .filter((run) => run.name === context && (app === null || run.app === app))
      .reduce(
        (/** @type {CheckRun | null} */ best, run) => (best && best.id > run.id ? best : run),
        null,
      );
    // A context the rule names twice (for two apps) is read once per run.
    if (newest && seen.has(newest.id)) continue;
    if (newest) {
      seen.add(newest.id);
      if (newest.status !== 'completed') waiting.push(context);
      else if (PASSED.includes(newest.conclusion ?? '')) carry.push(newest);
      else failed.push(`\`${context}\` ${newest.conclusion ?? newest.status} (${newest.url})`);
      continue;
    }
    const status = app === null ? statuses.find((s) => s.context === context) : undefined;
    if (status?.state === 'pending') waiting.push(context);
    else if (status?.state === 'success') {
      if (!SELF_REPORTING.test(context)) {
        failed.push(
          `\`${context}\` is a commit status, which this can't carry over (only Vercel's report on the new commit themselves)`,
        );
      }
    } else if (status) failed.push(`\`${context}\` ${status.state} (${status.url})`);
    else if (moving) waiting.push(context);
    else missing.push(`\`${context}\` never ran`);
  }
  // A context the rule names for two apps is reported once.
  const once = (/** @type {string[]} */ list) => [...new Set(list)];
  if (failed.length > 0) return { kind: 'refuse', reasons: once(failed) };
  if (waiting.length > 0) return { kind: 'wait', waiting: once(waiting) };
  if (missing.length > 0) return { kind: 'missing', reasons: once(missing) };
  return { kind: 'ready', carry };
}

/**
 * Reads pages of a list until one comes back short.
 *
 * @template T
 * @param {(page: number) => T[]} read
 * @returns {T[]}
 */
function allPages(read) {
  /** @type {T[]} */
  const out = [];
  for (let page = 1; page <= PAGES; page++) {
    const items = read(page);
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

/**
 * The required checks the rewrite reads (step 1).
 *
 * @param {GitHub} github
 */
export function readRequired({ api, repo }) {
  const rules = allPages((page) => {
    const got = api('GET', `repos/${repo}/rules/branches/${RULE_BRANCH}?per_page=100&page=${page}`);
    if (!Array.isArray(got)) throw new Error('expected the branch rules, as a list');
    return got;
  });
  return requiredFromRules(rules);
}

/**
 * A commit's check runs and statuses, every page.
 *
 * @param {GitHub} github
 * @param {string} sha
 */
export function readResults({ api, repo }, sha) {
  const runs = allPages((page) =>
    checkRunsFromApi(
      api('GET', `repos/${repo}/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}`),
    ),
  );
  const statuses = allPages((page) =>
    statusesFromApi(api('GET', `repos/${repo}/commits/${sha}/status?per_page=100&page=${page}`)),
  );
  return { runs, statuses };
}

/**
 * Waits for A's required checks (steps 1 to 4), returning the runs to carry
 * over; throws, naming the checks, when one failed or never ran, or when
 * they're still running after WAIT_MS.
 *
 * @param {GitHub} github
 * @param {string} sha A
 * @param {string} verifyCheck
 */
export function awaitChecks(github, sha, verifyCheck) {
  const short = sha.slice(0, 7);
  const required = readRequired(github);
  if (required.every(({ context }) => context === verifyCheck)) {
    throw new Error(
      `The ${RULE_BRANCH} branch rule requires no check GitHub Actions reports but ${verifyCheck}, so there's nothing to carry over: take verify out of visual-baselines in .github/ci.json, or require the checks`,
    );
  }
  const deadline = github.now() + WAIT_MS;
  /** @type {number | null} */
  let quiet = null;
  for (;;) {
    const decision = decide({
      required,
      ...readResults(github, sha),
      verifyCheck,
      runId: github.runId,
    });
    if (decision.kind === 'ready') return decision.carry;
    if (decision.kind === 'missing') quiet ??= github.now();
    else quiet = null;
    if (
      decision.kind === 'refuse' ||
      (decision.kind === 'missing' && github.now() - /** @type {number} */ (quiet) >= QUIET_MS)
    ) {
      throw new Error(
        `Can't update the baselines yet: ${decision.reasons.join('; ')} on ${short}. Fix or re-run that first, then run this again.`,
      );
    }
    const names =
      decision.kind === 'wait'
        ? decision.waiting
        : decision.reasons.map((r) => r.split(' never')[0]);
    if (github.now() >= deadline) {
      throw new Error(
        `${short}'s checks are still running: ${names.join(', ')}. Run this again once they've finished.`,
      );
    }
    github.log(`Waiting for ${names.join(', ')} on ${short}.`);
    github.sleep(POLL_MS);
  }
}

/**
 * Stops when A changes a file in .github/workflows/: GitHub refuses the
 * Actions token's push of a commit that does, and A′, A with the
 * baselines, would.
 *
 * @param {GitHub} github
 * @param {string} sha A
 */
export function noWorkflows({ api, repo }, sha) {
  const files = allPages((page) => {
    const got = field(
      api('GET', `repos/${repo}/commits/${sha}?per_page=100&page=${page}`),
      'files',
    );
    if (!Array.isArray(got)) throw new Error("expected the commit's files");
    return got;
  });
  const workflows = files
    .map((f) => String(field(f, 'filename')))
    .filter((name) => name.startsWith('.github/workflows/'));
  if (workflows.length > 0) {
    throw new Error(
      `${sha.slice(0, 7)} changes ${workflows.join(', ')}, and the new baselines would be added to it, which this workflow's token may not push. Push a commit on top of it (an empty one will do: git commit --allow-empty), wait for its checks, then run this again.`,
    );
  }
}

/**
 * The commit `branch` is at on the remote.
 *
 * @param {import('./baselines.mjs').Run} run
 * @param {string} branch
 */
function remoteHead(run, branch) {
  return run('git', ['ls-remote', 'origin', `refs/heads/${branch}`]).split(/\s/)[0];
}

/**
 * Stops unless `branch` is still at `sha`: once someone pushed, this run's
 * results are for a commit that's no longer the PR's.
 *
 * @param {import('./baselines.mjs').Run} run
 * @param {string} branch
 * @param {string} sha
 */
export function stillHead(run, branch, sha) {
  const head = remoteHead(run, branch);
  if (head !== sha) {
    throw new Error(
      `${branch} has moved on from ${sha.slice(0, 7)} (it's at ${head ? head.slice(0, 7) : 'nothing'}): run this again on its new head`,
    );
  }
}

/**
 * The check runs to post onto A′ (step 8): `verify.check`, passed here, and
 * each run carried over from A.
 *
 * @param {{ sha: string, from: string, carry: CheckRun[],
 *   verify: import('./settings.mjs').Verify, workflow: string, runUrl: string }} options
 *   `sha`: A′; `from`: A
 * @returns {Record<string, unknown>[]}
 */
export function posts({ sha, from, carry, verify, workflow, runUrl }) {
  const short = from.slice(0, 7);
  const by = `[${workflow}](${runUrl})`;
  return [
    {
      name: verify.check,
      head_sha: sha,
      status: 'completed',
      conclusion: 'success',
      details_url: runUrl,
      output: {
        title: 'Passed on this commit',
        summary: `${by} ran \`${verify.command}\` on this commit, once it had written the new visual baselines into it, and it passed.`,
      },
    },
    ...carry.map((run) => ({
      name: run.name,
      head_sha: sha,
      status: 'completed',
      conclusion: run.conclusion,
      ...(run.url ? { details_url: run.url } : {}),
      output: {
        title: `Carried over from ${short}`,
        summary: `[${run.name}](${run.url}) concluded ${run.conclusion} on ${short}. This commit is ${short} with new visual baselines and nothing else, so ${by} carried that result over.`,
      },
    })),
  ];
}

/**
 * Cancels the pull_request runs the push queued on `sha` awaiting approval
 * (step 9), looking for a minute as they appear, returning their ids. A
 * cancel that fails is a warning: a held run blocks nothing, it only shows.
 *
 * @param {GitHub} github
 * @param {string} sha
 */
export function cancelHeld({ api, repo, sleep, log }, sha) {
  const done = new Set();
  for (let poll = 0; poll < HELD_POLLS; poll++) {
    if (poll > 0) sleep(HELD_POLL_MS);
    const page = api(
      'GET',
      `repos/${repo}/actions/runs?head_sha=${sha}&event=pull_request&status=action_required&per_page=100`,
    );
    const runs = field(page, 'workflow_runs');
    const ids = (Array.isArray(runs) ? runs : [])
      .map((run) => field(run, 'id'))
      .filter((id) => typeof id === 'number' && !done.has(id));
    for (const id of ids) {
      done.add(id);
      try {
        api('POST', `repos/${repo}/actions/runs/${id}/cancel`);
      } catch (error) {
        log(
          `::warning::Couldn't cancel held run ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // They're queued together on the push: once some have come, a look
    // that finds no more ends it.
    if (done.size > 0 && ids.length === 0) break;
  }
  return [...done];
}

/**
 * Why the push of the amended commit failed (git's own words are in the
 * log above): someone pushed since A, or GitHub refused it.
 *
 * @param {import('./baselines.mjs').Run} run
 * @param {string} branch
 * @param {string} sha A
 */
export function pushRefused(run, branch, sha) {
  /** @type {string} */
  let head;
  try {
    head = remoteHead(run, branch);
  } catch {
    head = '';
  }
  if (head && head !== sha) {
    return `${branch} has moved on from ${sha.slice(0, 7)} (it's at ${head.slice(0, 7)}), so nothing was pushed: run this again on its new head`;
  }
  return `GitHub refused the push to ${branch} (git's message is above), so nothing was pushed`;
}

/**
 * The all-or-nothing rewrite (steps 1 to 9): waits for A's checks, has
 * `write` put the new baselines in the checkout, amends A with them, runs
 * `verify.command`, force-pushes and posts the results. Returns false,
 * having pushed nothing, when the baselines didn't change; throws, having
 * pushed nothing, when it can't go ahead.
 *
 * @param {{ verify: import('./settings.mjs').Verify, globs: string[], branch: string,
 *   run: import('./baselines.mjs').Run, check: () => void, write: () => void,
 *   github: GitHub }} options `check`: runs `verify.command`
 */
export function amendAndCarry({ verify, globs, branch, run, check, write, github }) {
  const sha = run('git', ['rev-parse', 'HEAD']).trim();
  const short = sha.slice(0, 7);
  stillHead(run, branch, sha);
  noWorkflows(github, sha);
  const carry = awaitChecks(github, sha, verify.check);
  // Waiting may have taken minutes: stop now rather than after the rewrite.
  stillHead(run, branch, sha);

  write();
  if (!commit({ globs, by: '', run, amend: true })) return false;
  const changed = run('git', ['diff', '--name-only', '-z', sha, 'HEAD'])
    .split('\0')
    .filter(Boolean);
  const outside = changed.filter((file) => matchingFolders([file], globs).length === 0);
  if (outside.length > 0) {
    throw new Error(
      `the amended commit changes more than the baselines (${outside.join(', ')}): nothing was pushed`,
    );
  }

  github.log(`Running ${verify.check}'s \`${verify.command}\` on the amended commit.`);
  try {
    check();
  } catch {
    throw new Error(
      `${verify.check} failed on ${short} with the new baselines (its output is above): nothing was pushed`,
    );
  }

  try {
    push({ branch, run, lease: sha });
  } catch {
    throw new Error(pushRefused(run, branch, sha));
  }
  const amended = run('git', ['rev-parse', 'HEAD']).trim();
  for (const body of posts({
    sha: amended,
    from: sha,
    carry,
    verify,
    workflow: github.workflow,
    runUrl: github.runUrl,
  })) {
    try {
      github.api('POST', `repos/${github.repo}/check-runs`, body);
    } catch (error) {
      // A′ is the PR's head now, without its results: the held runs, once
      // approved, report them on A′ themselves.
      throw new Error(
        `Pushed ${amended.slice(0, 7)} (${short} with the new baselines), but couldn't post ${String(body.name)} onto it (${error instanceof Error ? error.message.trim() : String(error)}). Approve the workflows awaiting approval on the PR, which run its checks on ${amended.slice(0, 7)}, or push a commit on top.`,
        { cause: error },
      );
    }
  }
  github.log(
    `Pushed ${amended.slice(0, 7)} (${short} with the new baselines); posted ${verify.check} and carried ${carry.length} checks over.`,
  );
  const held = cancelHeld(github, amended);
  github.log(`Cancelled ${held.length} runs held for approval on ${amended.slice(0, 7)}.`);
  return true;
}

/** Waits without spinning: the scripts are synchronous throughout. */
function sleepSync(/** @type {number} */ ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The GitHub side from the workflow's environment (GH_TOKEN, which gh
 * reads, and the run's own variables).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {GitHub}
 */
export function gitHubFromEnv(env) {
  const repo = env.GITHUB_REPOSITORY ?? '';
  const runId = env.GITHUB_RUN_ID ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(runId)) {
    throw new Error(
      'visual-baselines.verify carries checks over in GitHub Actions only (GITHUB_REPOSITORY and GITHUB_RUN_ID)',
    );
  }
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  return {
    api: ghApi,
    repo,
    runId,
    runUrl: `${server}/${repo}/actions/runs/${runId}`,
    workflow: env.GITHUB_WORKFLOW || 'visual-baselines',
    sleep: sleepSync,
    now: Date.now,
    log: (line) => console.log(line),
  };
}
