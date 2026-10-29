// This job's recent history, read for job-summary (summary.mjs) from the
// Actions API: the run it's in, and the job's last completed runs on this
// branch and the repository's default branch, each with its steps' times
// and, from the small artifact each run of the tool leaves
// (job-summary-<job>, its tests' names, times and results), its tests. A
// call that fails leaves that part out: history is never worth failing a
// summary over.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** @typedef {(args: string[]) => string} Gh */
/** @typedef {import('./junit.mjs').TestCase} TestCase */

/**
 * A job's step, as the Actions API gives it.
 *
 * @typedef {object} Step
 * @property {string} name
 * @property {string | null} conclusion
 * @property {string | null} started_at
 * @property {string | null} completed_at
 */

/**
 * A job, as the Actions API gives it.
 *
 * @typedef {object} Job
 * @property {string} name
 * @property {string | null} conclusion
 * @property {string | null} started_at
 * @property {string | null} completed_at
 * @property {string} [html_url]
 * @property {Step[]} [steps]
 */

/**
 * A workflow run, as the Actions API gives it.
 *
 * @typedef {object} Run
 * @property {number} id
 * @property {number} run_number
 * @property {string} html_url
 * @property {string | null} head_branch
 * @property {string} head_sha
 * @property {string} created_at
 * @property {number} [workflow_id]
 * @property {{ full_name: string } | null} [head_repository] where its
 *   commit came from: a fork's, for a fork's pull request
 */

/**
 * A test as a run's record keeps it.
 *
 * @typedef {Pick<TestCase, 'name' | 'seconds' | 'result'>} RecordTest
 */

/**
 * One earlier run of the job.
 *
 * @typedef {object} PastRun
 * @property {Run} run
 * @property {Job} job
 * @property {RecordTest[] | null} tests null when its
 *   record couldn't be read (older than the tool, expired, or not uploaded)
 * @property {boolean} recorded whether the run left a record, and so a report
 * @property {number | null} seconds the job's time when its summary was
 *   written, from its record: the same span as this run's (null without one)
 */

/**
 * What a run's record holds.
 *
 * @typedef {{ tests: PastRun['tests'], seconds: number | null }} RunRecord
 */

/**
 * The artifact a run's record of its tests goes in: one per job, by name.
 *
 * @param {string} job
 */
export function artifactName(job) {
  const slug = job
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `job-summary-${slug || 'job'}`;
}

/**
 * JSON from gh, or null when the call or the parse fails.
 *
 * @template T
 * @param {Gh} gh
 * @param {string[]} args
 * @returns {T | null}
 */
function api(gh, args) {
  try {
    return JSON.parse(gh(['api', ...args]));
  } catch {
    return null;
  }
}

/**
 * The run this is in, the repository's default branch and this attempt's
 * jobs, or why they couldn't be read.
 *
 * @param {Record<string, string | undefined>} env
 * @param {Gh} gh
 * @returns {{ run: Run, defaultBranch: string, jobs: Job[] } | { problem: string }}
 */
export function current(env, gh) {
  const repo = env.GITHUB_REPOSITORY;
  const attempt = env.GITHUB_RUN_ATTEMPT || '1';
  let jobs;
  try {
    jobs = JSON.parse(
      gh([
        'api',
        `repos/${repo}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${attempt}/jobs?per_page=100`,
      ]),
    ).jobs;
    if (!Array.isArray(jobs)) throw new Error('no jobs in the answer');
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return { problem: `the run's jobs couldn't be read (${reason}); the job needs actions: read.` };
  }
  /** @type {Run | null} */
  const run = api(gh, [`repos/${repo}/actions/runs/${env.GITHUB_RUN_ID}`]);
  /** @type {{ default_branch?: string } | null} */
  const repository = api(gh, [`repos/${repo}`]);
  if (!run) return { problem: "this run couldn't be read." };
  return { run, defaultBranch: repository?.default_branch ?? '', jobs };
}

/**
 * The workflow's last completed runs on this run's branch and the default
 * branch from before this one, newest first, at most `count`: a re-run of
 * an old run compares with what came before it, not after. Runs of a
 * fork's commits are left out, as a fork's branch can share a name with
 * this repository's (a fork's `main`).
 *
 * @param {string} repo
 * @param {Run} run
 * @param {string} defaultBranch
 * @param {number} count
 * @param {Gh} gh
 * @returns {Run[]}
 */
export function pastRuns(repo, run, defaultBranch, count, gh) {
  const named = /** @type {(b: string | null) => b is string} */ ((b) => Boolean(b));
  const branches = [...new Set([run.head_branch, defaultBranch].filter(named))];
  /** @type {Map<number, Run>} */
  const found = new Map();
  for (const branch of branches) {
    /** @type {{ workflow_runs?: Run[] } | null} */
    const page = api(gh, [
      `repos/${repo}/actions/workflows/${run.workflow_id}/runs?branch=${encodeURIComponent(branch)}&status=completed&created=${encodeURIComponent(`<${run.created_at}`)}&per_page=${count}`,
    ]);
    for (const r of page?.workflow_runs ?? []) {
      const fork = r.head_repository && r.head_repository.full_name !== repo;
      if (!fork && r.id !== run.id && Date.parse(r.created_at) < Date.parse(run.created_at)) {
        found.set(r.id, r);
      }
    }
  }
  return [...found.values()]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, count);
}

/**
 * The job, by name, in an earlier run's latest attempt.
 *
 * @param {string} repo
 * @param {Run} run
 * @param {string} name
 * @param {Gh} gh
 * @returns {Job | null}
 */
export function pastJob(repo, run, name, gh) {
  /** @type {{ jobs?: Job[] } | null} */
  const data = api(gh, [`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`]);
  return data?.jobs?.find((j) => j.name === name && j.completed_at) ?? null;
}

/**
 * The tests a run's record holds, and the job's time it wrote, or null when
 * it can't be read.
 *
 * @param {string} text the record's JSON
 * @returns {RunRecord | null}
 */
export function parseRecord(text) {
  try {
    /** @type {unknown} */
    const data = JSON.parse(text);
    if (typeof data !== 'object' || data === null) return null;
    const seconds =
      'seconds' in data && typeof data.seconds === 'number' && data.seconds >= 0
        ? data.seconds
        : null;
    if (!('tests' in data) || !Array.isArray(data.tests)) {
      return seconds === null ? null : { tests: null, seconds };
    }
    const tests = data.tests
      .filter(
        (t) =>
          typeof t === 'object' &&
          t !== null &&
          typeof t.name === 'string' &&
          typeof t.seconds === 'number' &&
          ['passed', 'failed', 'skipped', 'passed on re-run'].includes(t.result),
      )
      .map((t) => ({ name: t.name, seconds: t.seconds, result: t.result }));
    return { tests, seconds };
  } catch {
    return null;
  }
}

/**
 * Downloads a run's record with gh, returning its JSON, or null.
 *
 * @param {Gh} gh
 * @param {string} repo
 * @param {number} runId
 * @param {string} name
 * @returns {string | null}
 */
export function downloadRecord(gh, repo, runId, name) {
  const dir = mkdtempSync(path.join(tmpdir(), 'job-summary-'));
  try {
    gh(['run', 'download', String(runId), '--repo', repo, '--name', name, '--dir', dir]);
    const file = readdirSync(dir).find((f) => f.endsWith('.json'));
    return file ? readFileSync(path.join(dir, file), 'utf8') : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The job's last `count` completed runs, newest first, each with its job
 * and, where its record could be read, its tests. It stops looking once
 * `until` has passed, keeping what it has read: each call has its own time
 * limit, but a slow API could otherwise hold the job past its own.
 *
 * @param {string} repo
 * @param {Run} run
 * @param {string} defaultBranch
 * @param {string} name the job's name
 * @param {number} count
 * @param {Gh} gh
 * @param {(runId: number, artifact: string) => string | null} [record]
 * @param {number} [until] milliseconds
 * @param {() => number} [clock]
 * @returns {PastRun[]}
 */
export function history(
  repo,
  run,
  defaultBranch,
  name,
  count,
  gh,
  record,
  until = Infinity,
  clock = Date.now,
) {
  const read = record ?? ((id, artifact) => downloadRecord(gh, repo, id, artifact));
  /** @type {PastRun[]} */
  const past = [];
  for (const r of pastRuns(repo, run, defaultBranch, count, gh)) {
    if (clock() > until) break;
    const job = pastJob(repo, r, name, gh);
    if (!job) continue;
    const text = read(r.id, artifactName(name));
    const kept = text === null ? null : parseRecord(text);
    past.push({
      run: r,
      job,
      tests: kept?.tests ?? null,
      recorded: kept !== null,
      seconds: kept?.seconds ?? null,
    });
  }
  return past;
}
