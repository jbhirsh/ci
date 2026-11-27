// Everything job-summary shows about a run, worked out once: the report
// page (report.html) reads it as JSON, and the run's summary (render.ts)
// is written from it. summary.ts gathers the inputs; this is pure.
//
// Times are seconds. Earlier runs are listed oldest first, and every list
// of per-run values (a step's times, a test's results) lines up with them,
// this run's value apart. A test's file, line and snippet come from
// source.ts, its usual time and flakiness from trends.ts.

import { KEEP_DAYS } from './report.ts';
import { jobSeconds, stepTrends, testTrends, usual } from './trends.ts';
import type { TestCase } from './junit.ts';
import type { Job, PastRun, Run } from './history.ts';
import type { Outcome, StepRow } from './trends.ts';
import type { Located } from './source.ts';

/** One CPU sample: seconds into the job, the load average, % busy. */
export type Sample = { t: number; load: number; busy: number };

/** What the model is made from. */
export type Input = {
  /** owner/name */
  repo: string;
  workflow: string;
  job: string;
  /** what a test is called */
  noun: string;
  /** milliseconds */
  now: number;
  /** this run */
  run: Run | null;
  /** this job */
  current: Job | null;
  /** this job's */
  steps: StepRow[];
  /** why there are no steps or history ('' when there are) */
  problem: string;
  /** one per test, null without reports */
  tests: TestCase[] | null;
  /** newest first */
  past: PastRun[];
  /** by test name */
  located: Map<string, Located>;
  /** files each commit changed, oldest run first, this one last */
  changed: (Set<string> | null)[];
  /** an earlier run's report page */
  reportOf: (runId: number) => string;
  notes: [string, string][];
  load: Sample[];
  /** the settle wait's limit, % busy */
  settle: number | null;
};

/** A test in the model. */
export type ModelTest = {
  /** its full name, the key across runs */
  name: string;
  /** its file's folder, with a trailing slash */
  folder: string;
  /** its file's name ('' for a Maestro flow) */
  file: string;
  /** the describe blocks around it, joined by " › " */
  block: string;
  title: string;
  /** its file in the repository ('' when not found) */
  path: string;
  line: number;
  seconds: number;
  usual: number | null;
  result: TestCase['result'];
  slower: boolean;
  flaky: boolean;
  /** a failure's whole message ('' otherwise) */
  message: string;
  /** its result in each earlier run */
  hist: Outcome[];
  /** its time in each earlier run (null where it didn't run) */
  times: (number | null)[];
  /** the runs (0 = oldest, runs.length = this one) whose commit changed its file */
  edited: number[];
  /** its snippet */
  code: [number, string, boolean][] | null;
};

export type Model = {
  repo: string;
  workflow: string;
  job: string;
  noun: string;
  problem: string;
  run: { number: number; url: string; sha: string; branch: string; when: string } | null;
  /** this job's time so far */
  seconds: number;
  /** the usual time (median of the earlier runs that passed) */
  usual: number | null;
  steps: {
    i: number;
    name: string;
    start: number;
    seconds: number;
    conclusion: string;
    usual: number | null;
    slower: boolean;
    past: (number | null)[];
  }[];
  runs: {
    number: number;
    url: string;
    sha: string;
    branch: string;
    when: string;
    seconds: number;
    conclusion: string;
  }[];
  tests: ModelTest[] | null;
  notes: [string, string][];
  load: Sample[];
  settle: number | null;
};

/**
 * A test's place: the folder and file its suite names, the describe blocks
 * around it and its own title, from its full name.
 */
export function parts(t: TestCase) {
  const rest =
    t.suite && t.name.startsWith(`${t.suite} › `) ? t.name.slice(t.suite.length + 3) : t.name;
  const names = rest.split(/ › | > /);
  const title = names.pop() ?? rest;
  const suite = t.suite && t.name !== t.suite && rest !== t.name ? t.suite : '';
  const cut = suite.lastIndexOf('/') + 1;
  return { folder: suite.slice(0, cut), file: suite.slice(cut), block: names.join(' › '), title };
}

/**
 * The model.
 */
export function buildModel(input: Input): Model {
  const { now, past, steps } = input;
  const ordered = [...past].reverse();
  const began = Date.parse(input.current?.started_at ?? '');
  const zero = Number.isFinite(began) ? began : (steps[0]?.start ?? now);
  const sTrends = stepTrends(steps, past, now);
  const pathOf = (t: TestCase) => input.located.get(t.name)?.path ?? '';
  const tTrends = testTrends(
    input.tests ?? [],
    past,
    input.run?.head_sha ?? '',
    input.changed,
    pathOf,
  );
  const pastSeconds = (p: PastRun) => p.seconds ?? jobSeconds(p.job, now);
  return {
    repo: input.repo,
    workflow: input.workflow,
    job: input.job,
    noun: input.noun,
    problem: input.problem,
    run: input.run && {
      number: input.run.run_number,
      url: input.current?.html_url ?? input.run.html_url,
      sha: input.run.head_sha,
      branch: input.run.head_branch ?? '',
      when: input.run.created_at,
    },
    seconds: input.current ? jobSeconds(input.current, now) : 0,
    usual: usual(past.filter((p) => p.job.conclusion === 'success').map(pastSeconds)),
    // The job's last step still running is the summary itself: left out,
    // as its time is only how far it has got.
    steps: (steps.at(-1)?.conclusion === 'running' ? steps.slice(0, -1) : steps).map((s, k) => {
      const trend = sTrends.get(s.name);
      return {
        i: k + 1,
        name: s.name,
        start: Math.max(0, (s.start - zero) / 1000),
        seconds: s.seconds,
        conclusion: s.conclusion,
        usual: trend?.usual ?? null,
        slower: trend?.slower ?? false,
        past: trend?.times ?? ordered.map(() => null),
      };
    }),
    runs: ordered.map((p) => ({
      number: p.run.run_number,
      // Its report, while the Pages site still keeps it; its job page otherwise.
      url:
        p.recorded && now - Date.parse(p.run.created_at) <= KEEP_DAYS * 86_400_000
          ? input.reportOf(p.run.id)
          : (p.job.html_url ?? p.run.html_url),
      sha: p.run.head_sha,
      branch: p.run.head_branch ?? '',
      when: p.run.created_at,
      seconds: pastSeconds(p),
      conclusion: p.job.conclusion ?? '',
    })),
    tests:
      input.tests &&
      input.tests.map((t) => {
        const trend = tTrends.get(t.name);
        const at = input.located.get(t.name);
        return {
          name: t.name,
          ...parts(t),
          path: at?.path ?? '',
          line: at?.line ?? 1,
          seconds: t.seconds,
          usual: trend?.usual ?? null,
          result: t.result,
          slower: trend?.slower ?? false,
          flaky: trend?.flaky ?? false,
          message: t.detail || t.message,
          hist: trend?.outcomes.slice(0, -1) ?? ordered.map(() => ''),
          times: trend?.times ?? ordered.map(() => null),
          edited: trend?.edited ?? [],
          code: at?.code ?? null,
        };
      }),
    notes: input.notes,
    load: input.load,
    settle: input.settle,
  };
}

/**
 * The tests worth a snippet: failed, passed on a re-run, slower than usual
 * or flaky.
 *
 * @returns their names
 */
export function noteworthy(model: Model): Set<string> {
  return new Set(
    (model.tests ?? [])
      .filter(
        (t) => t.result === 'failed' || t.result === 'passed on re-run' || t.slower || t.flaky,
      )
      .map((t) => t.name),
  );
}
