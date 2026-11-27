// Everything job-summary shows about a run, worked out once: the report
// page (report.html) reads it as JSON, and the run's summary (render.ts)
// is written from it. summary.ts gathers the inputs; this is pure.
//
// Times are seconds. Earlier runs are listed oldest first, and every list
// of per-run values (a step's times, a test's results) lines up with them,
// this run's value apart. A test's file, line and snippet come from
// source.ts, its usual time and flakiness from trends.ts.
//
// A probe's measurements (measures.ts) are in ms, and only with
// job-summary's measurements input: `measurements` is null without it, and
// the report hides its card. Their earlier runs are main's of this run's
// event (history.ts), so they line up with measurements.runs, not runs.

import { measureTrend, rawEntry, requests } from './measures.ts';
import { KEEP_DAYS } from './report.ts';
import { jobSeconds, stepTrends, testTrends, usual } from './trends.ts';
import type { Results, Start } from '../probe/results.ts';
import type { Kind, Part } from './measures.ts';
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
  /**
   * a probe's results and main's earlier runs of this event, newest first;
   * null (or left out) without the measurements input
   */
  measurements?: { results: Results; past: PastRun[] } | null;
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
  /** null without the measurements input; left out by a model made before it */
  measurements?: Measurements | null;
};

/** One start's value of a part of a request, in ms. */
export type MeasureValue = {
  ms: number;
  /** ms from the browser sending the request */
  start: number;
  /** how many times a field ran (1 for anything else) */
  calls: number;
  /** a field's slowest call (its ms for anything else) */
  slowest: number;
  /** its value in each of measurements.runs, null where a run didn't have it */
  past: (number | null)[];
  usual: number | null;
  slower: boolean;
  /** its `Server-Timing` entry ('' for the browser's own time) */
  raw: string;
};

/** A part of a request (measures.ts requests). */
export type MeasureNode = {
  /** its phase, unique in its request */
  key: string;
  title: string;
  label: string;
  path: string;
  kind: Kind;
  depth: number;
  warm: MeasureValue | null;
  cold: MeasureValue | null;
};

/** One value, for Needs attention and the summary's line. */
export type MeasureRow = {
  /** the request */
  op: string;
  /** its part's key */
  key: string;
  label: string;
  depth: number;
  start: Start;
  ms: number;
  usual: number | null;
  slower: boolean;
};

/** A probe's measurements, as the report's card draws them. */
export type Measurements = {
  /** this run's deployment's ("preview") */
  environment: string;
  /** the earlier runs' ("production"), '' without any */
  usualEnvironment: string;
  /** main's earlier runs that kept measurements, oldest first */
  runs: { number: number; url: string; when: string }[];
  /** each request and its parts */
  ops: { name: string; noCold: string; nodes: MeasureNode[] }[];
  /** every part's value, in the order the card draws them */
  rows: MeasureRow[];
  /** the results file's notes */
  notes: string[];
};

/**
 * The measurements, each part's values with its earlier ones.
 *
 * @param given the results and earlier runs
 * @param url an earlier run's page
 */
function measurements(
  given: { results: Results; past: PastRun[] },
  url: (p: PastRun) => string,
): Measurements {
  const { results } = given;
  const earlier = [...given.past].reverse().filter((p) => p.measurements);
  const pastOf = (name: string, phase: string, start: Start) =>
    earlier.map(
      (p) =>
        p.measurements?.values.find(
          (v) => v.name === name && v.phase === phase && v.start === start,
        )?.ms ?? null,
    );
  const value = (name: string, part: Part | null): MeasureValue | null => {
    if (!part) return null;
    const past = pastOf(name, part.phase, part.start);
    return {
      ms: part.ms,
      start: part.at,
      calls: part.calls ?? 1,
      slowest: part.slowestMs ?? part.ms,
      past,
      ...measureTrend(part.ms, past, part.phase),
      raw: rawEntry(part),
    };
  };
  const found = requests(results.measurements);
  const carriers = found
    .filter((r) => r.parts.some((p) => p.cold))
    .map((r) => r.name)
    .join(', ');
  const ops = found.map(({ name, parts }) => ({
    name,
    noCold: carriers ? `${carriers} carried this run’s cold start` : 'No cold start this run',
    nodes: parts.map(({ cold, warm, ...part }) => ({
      ...part,
      warm: value(name, warm),
      cold: value(name, cold),
    })),
  }));
  const environments = [
    ...new Set(earlier.map((p) => p.measurements?.environment).filter(Boolean)),
  ];
  return {
    environment: results.environment,
    usualEnvironment: environments.join(' and '),
    runs: earlier.map((p) => ({ number: p.run.run_number, url: url(p), when: p.run.created_at })),
    ops,
    rows: ops.flatMap((op) =>
      op.nodes.flatMap((n) =>
        (['warm', 'cold'] as const).flatMap((start) => {
          const v = n[start];
          return v
            ? [
                {
                  op: op.name,
                  key: n.key,
                  label: n.label,
                  depth: n.depth,
                  start,
                  ms: v.ms,
                  usual: v.usual,
                  slower: v.slower,
                },
              ]
            : [];
        }),
      ),
    ),
    notes: results.notes,
  };
}

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
  // Its report, while the Pages site still keeps it; its job page otherwise.
  const pastUrl = (p: PastRun) =>
    p.recorded && now - Date.parse(p.run.created_at) <= KEEP_DAYS * 86_400_000
      ? input.reportOf(p.run.id)
      : (p.job.html_url ?? p.run.html_url);
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
      url: pastUrl(p),
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
    measurements: input.measurements ? measurements(input.measurements, pastUrl) : null,
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
