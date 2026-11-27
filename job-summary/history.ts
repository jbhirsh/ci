// This job's recent history, read for job-summary (summary.ts) from the
// Actions API: the run it's in, and the job's last completed runs on this
// branch and the repository's default branch, each with its steps' times
// and, from the small artifact each run of the tool leaves
// (job-summary-<job>, its tests' names, times and results), its tests. A
// call that fails leaves that part out: history is never worth failing a
// summary over.
//
// A probe's measurements (measures.ts) have a history of their own: main's
// runs of this run's event only (the `only` option), read only for a job
// given the measurements input. BoardGames' probe runs on
// deployment_status, while its scheduled runs on main, which have no probe
// job, would otherwise crowd them out.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseRecorded } from './measures.ts';
import type { TestCase } from './junit.ts';
import type { Recorded } from './measures.ts';

export type Gh = (args: string[]) => string;

/** A job's step, as the Actions API gives it. */
export type Step = {
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
};

/** A job, as the Actions API gives it. */
export type Job = {
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url?: string;
  steps?: Step[];
};

/** A workflow run, as the Actions API gives it. */
export type Run = {
  id: number;
  run_number: number;
  html_url: string;
  head_branch: string | null;
  head_sha: string;
  created_at: string;
  workflow_id?: number;
  /** where its commit came from: a fork's, for a fork's pull request */
  head_repository?: { full_name: string } | null;
};

/** A test as a run's record keeps it. */
export type RecordTest = Pick<TestCase, 'name' | 'seconds' | 'result'>;

/** One earlier run of the job. */
export type PastRun = {
  run: Run;
  job: Job;
  /** null when its record couldn't be read (older than the tool, expired, or not uploaded) */
  tests: RecordTest[] | null;
  /** whether the run left a record, and so a report */
  recorded: boolean;
  /**
   * the job's time when its summary was written, from its record: the same span as this run's (null
   * without one)
   */
  seconds: number | null;
  /** its measurements, from its record, only when it kept some */
  measurements?: Recorded;
};

/** What a run's record holds: measurements only when it kept some. */
export type RunRecord = {
  tests: PastRun['tests'];
  seconds: number | null;
  measurements?: Recorded;
};

/**
 * Which earlier runs to read, in place of this run's branch and the
 * default branch, of any event: measurements' history (summary.ts).
 */
export type Only = {
  /** the runs' event ("deployment_status") */
  event?: string;
  branches?: string[];
};

/**
 * The artifact a run's record of its tests goes in: one per job, by name.
 */
export function artifactName(job: string) {
  const slug = job
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `job-summary-${slug || 'job'}`;
}

/**
 * JSON from gh, or null when the call or the parse fails.
 */
function api<T>(gh: Gh, args: string[]): T | null {
  try {
    return JSON.parse(gh(['api', ...args]));
  } catch {
    return null;
  }
}

/**
 * The run this is in, the repository's default branch and this attempt's
 * jobs, or why they couldn't be read.
 */
export function current(
  env: Record<string, string | undefined>,
  gh: Gh,
): { run: Run; defaultBranch: string; jobs: Job[] } | { problem: string } {
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
  const run: Run | null = api(gh, [`repos/${repo}/actions/runs/${env.GITHUB_RUN_ID}`]);
  const repository: { default_branch?: string } | null = api(gh, [`repos/${repo}`]);
  if (!run) return { problem: "this run couldn't be read." };
  return { run, defaultBranch: repository?.default_branch ?? '', jobs };
}

/**
 * The workflow's last completed runs on this run's branch and the default
 * branch from before this one, newest first, at most `count`: a re-run of
 * an old run compares with what came before it, not after. Runs of a
 * fork's commits are left out, as a fork's branch can share a name with
 * this repository's (a fork's `main`).
 */
export function pastRuns(
  repo: string,
  run: Run,
  defaultBranch: string,
  count: number,
  gh: Gh,
  only: Only = {},
): Run[] {
  const named = (b: string | null): b is string => Boolean(b);
  const branches = [...new Set((only.branches ?? [run.head_branch, defaultBranch]).filter(named))];
  const event = only.event ? `&event=${encodeURIComponent(only.event)}` : '';
  const found: Map<number, Run> = new Map();
  for (const branch of branches) {
    const page: { workflow_runs?: Run[] } | null = api(gh, [
      `repos/${repo}/actions/workflows/${run.workflow_id}/runs?branch=${encodeURIComponent(branch)}${event}&status=completed&created=${encodeURIComponent(`<${run.created_at}`)}&per_page=${count}`,
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
 */
export function pastJob(repo: string, run: Run, name: string, gh: Gh): Job | null {
  const data: { jobs?: Job[] } | null = api(gh, [
    `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
  ]);
  return data?.jobs?.find((j) => j.name === name && j.completed_at) ?? null;
}

/**
 * The tests a run's record holds, the job's time it wrote and its
 * measurements, if it kept any, or null when it can't be read.
 *
 * @param text the record's JSON
 */
export function parseRecord(text: string): RunRecord | null {
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data !== 'object' || data === null) return null;
    const seconds =
      'seconds' in data && typeof data.seconds === 'number' && data.seconds >= 0
        ? data.seconds
        : null;
    const measurements = 'measurements' in data ? parseRecorded(data.measurements) : null;
    const kept = measurements ? { measurements } : {};
    if (!('tests' in data) || !Array.isArray(data.tests)) {
      return seconds === null && !measurements ? null : { tests: null, seconds, ...kept };
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
    return { tests, seconds, ...kept };
  } catch {
    return null;
  }
}

/**
 * Downloads a run's record with gh, returning its JSON, or null.
 */
export function downloadRecord(gh: Gh, repo: string, runId: number, name: string): string | null {
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
 * @param repo
 * @param run
 * @param defaultBranch
 * @param name the job's name
 * @param count
 * @param gh
 * @param record
 * @param until milliseconds
 * @param clock
 * @param only which runs, in place of this branch's and the default branch's
 */
export function history(
  repo: string,
  run: Run,
  defaultBranch: string,
  name: string,
  count: number,
  gh: Gh,
  record?: (runId: number, artifact: string) => string | null,
  until: number = Infinity,
  clock: () => number = Date.now,
  only: Only = {},
): PastRun[] {
  const read = record ?? ((id, artifact) => downloadRecord(gh, repo, id, artifact));
  const past: PastRun[] = [];
  for (const r of pastRuns(repo, run, defaultBranch, count, gh, only)) {
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
      ...(kept?.measurements ? { measurements: kept.measurements } : {}),
    });
  }
  return past;
}
