import type { TestCase } from './junit.ts';
import type { PastRun, Step } from './history.ts';

// How this run of a job compares with its recent runs, for job-summary
// (summary.ts): each step's and test's usual time, which are slower than
// usual, and which tests are flaky. Pure: the runs come from history.ts.
//
// "Usual" is the median of the earlier runs, the job's or step's over the
// runs that passed (a failed run stops early, or spends minutes collecting
// logs) and a test's over the runs it passed in, given at least
// MIN_SAMPLES of them: fewer say nothing. Slower than usual is SLOWER_RATIO
// of that and at least SLOWER_SECONDS more (TEST_SLOWER_SECONDS for a test),
// so a 2 s step taking 3 s isn't news. A test is flaky when, within the runs
// that kept a record of their tests, it passed on a re-run, failed and
// passed on the same commit, or changed result FLIPS times while its file
// stayed the same: a change of result on a commit that edited the test is
// the edit's doing (source.ts says which commits did), and one broken by a
// commit and fixed by the next is not flaky, nor one that fails from this
// run on.

/** The fewest earlier times that make a usual time. */
export const MIN_SAMPLES = 3;
/** How much over its usual time is slower than usual. */
export const SLOWER_RATIO = 1.15;
/** And by at least this many seconds. */
export const SLOWER_SECONDS = 10;
/** A test's floor: unit tests take milliseconds, so a second is news. */
export const TEST_SLOWER_SECONDS = 1;
/** Changes of result (pass to fail or back) that make a test flaky. */
export const FLIPS = 3;

/** A step that ran, timed. */
export type StepRow = {
  name: string;
  /** milliseconds */
  start: number;
  seconds: number;
  /** "running" for a step not finished yet */
  conclusion: string;
};

/**
 * Seconds between two times, never negative or NaN.
 *
 * @param start milliseconds
 * @param end milliseconds
 */
function elapsed(start: number, end: number) {
  const seconds = (end - start) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

/**
 * The steps that ran, with when each started and how long it took: not
 * skipped ones, nor those not started yet (the post-job steps). One the API
 * still shows running (this one, or the one before it, which the API can be
 * slow to close) is timed up to `now`.
 *
 * @param steps
 * @param now milliseconds
 */
export function stepRows(steps: Step[], now: number = Date.now()): StepRow[] {
  return steps
    .filter((s) => s.started_at && s.conclusion !== 'skipped')
    .map((s) => {
      const start = Date.parse(s.started_at ?? '');
      return {
        name: s.name,
        start: Number.isFinite(start) ? start : now,
        seconds: elapsed(start, s.completed_at ? Date.parse(s.completed_at) : now),
        conclusion: s.completed_at ? (s.conclusion ?? '') : 'running',
      };
    });
}

/**
 * A job's time, start to end (or `now`, in milliseconds).
 */
export function jobSeconds(
  job: { started_at: string | null; completed_at: string | null },
  now: number = Date.now(),
) {
  return elapsed(
    Date.parse(job.started_at ?? ''),
    job.completed_at ? Date.parse(job.completed_at) : now,
  );
}

/**
 * The median, or null for fewer than MIN_SAMPLES values.
 */
export function usual(values: number[]): number | null {
  if (values.length < MIN_SAMPLES) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Whether a time is slower than its usual one.
 *
 * @param seconds
 * @param typical
 * @param floor the fewest seconds over it that count
 */
export function slower(seconds: number, typical: number | null, floor: number = SLOWER_SECONDS) {
  return typical !== null && seconds >= typical * SLOWER_RATIO && seconds - typical >= floor;
}

/**
 * One row per test: a report and its re-runs (sift's <flow>.retry.xml)
 * name the same test, which the run reads as its first try's result and
 * time, or "passed on re-run". Order is kept.
 *
 * @param cases with re-runs settled (junit.ts settleReruns)
 */
export function byTest(cases: TestCase[]): TestCase[] {
  const tests: Map<string, TestCase> = new Map();
  const rank = { 'passed on re-run': 3, failed: 2, passed: 1, skipped: 0 };
  for (const c of cases) {
    const seen = tests.get(c.name);
    if (!seen || rank[c.result] > rank[seen.result]) tests.set(c.name, c);
  }
  return [...tests.values()];
}

/** A test's result in a run, '' where it didn't appear in that run's record or the run kept none. */
export type Outcome = TestCase['result'] | '';

/** How one step or test compares with its earlier runs. */
export type Trend = {
  usual: number | null;
  slower: boolean;
  /** earlier runs' times, oldest first (null where it didn't run) */
  times: (number | null)[];
};

/**
 * The steps' trends, by name.
 *
 * @param rows this run's
 * @param past newest first
 * @param now milliseconds
 */
export function stepTrends(
  rows: StepRow[],
  past: PastRun[],
  now: number = Date.now(),
): Map<string, Trend> {
  const earlier = [...past].reverse().map((p) => ({
    passed: p.job.conclusion === 'success',
    rows: new Map(
      stepRows(p.job.steps ?? [], now)
        .filter((r) => r.conclusion !== 'running')
        .map((r) => [r.name, r.seconds]),
    ),
  }));
  return new Map(
    rows.map((r) => {
      const typical = usual(
        earlier.filter((e) => e.passed && e.rows.has(r.name)).map((e) => e.rows.get(r.name) ?? 0),
      );
      return [
        r.name,
        {
          usual: typical,
          slower: r.conclusion !== 'running' && slower(r.seconds, typical),
          times: earlier.map((e) => e.rows.get(r.name) ?? null),
        },
      ];
    }),
  );
}

/**
 * A test's trend: its results in every earlier run ('' where the run kept no record, or the test
 * wasn't in it), this one last; whether it's flaky; and the runs (the same indices) whose commit
 * changed its file.
 */
export type TestTrend = Trend & { outcomes: Outcome[]; flaky: boolean; edited: number[] };

/**
 * The tests' trends, by name.
 *
 * @param tests this run's, one per test (byTest)
 * @param past newest first
 * @param sha this run's commit
 * @param changed the files each run's commit
 *   changed since the run before it, oldest run first and this one last
 *   (source.ts changedFiles); null where that isn't known
 * @param pathOf a test's file
 */
export function testTrends(
  tests: TestCase[],
  past: PastRun[],
  sha = '',
  changed: (Set<string> | null)[] = [],
  pathOf: (test: TestCase) => string = () => '',
): Map<string, TestTrend> {
  const ordered = [...past].reverse();
  const earlier = ordered.map((p) =>
    p.tests === null ? null : new Map(p.tests.map((t) => [t.name, t])),
  );
  const shas = [...ordered.map((p) => p.run.head_sha), sha];
  return new Map(
    tests.map((t) => {
      const runs = earlier.map((e) => e?.get(t.name));
      const typical = usual(runs.filter((r) => r?.result === 'passed').map((r) => r?.seconds ?? 0));
      const outcomes: Outcome[] = [...runs.map((r) => r?.result ?? ''), t.result];
      const path = pathOf(t);
      const edited = path ? changed.flatMap((files, i) => (files?.has(path) ? [i] : [])) : [];
      const byCommit: Record<string, Set<boolean>> = {};
      let flips = 0;
      let last: { at: number; passed: boolean } | null = null;
      outcomes.forEach((o, i) => {
        if (o !== 'passed' && o !== 'failed') return;
        const passed = o === 'passed';
        if (shas[i]) (byCommit[shas[i]] ??= new Set()).add(passed);
        // A change of result counts unless a commit since the last result
        // edited the test.
        if (last && last.passed !== passed && !edited.some((k) => k > (last?.at ?? 0) && k <= i)) {
          flips++;
        }
        last = { at: i, passed };
      });
      return [
        t.name,
        {
          usual: typical,
          slower: t.result === 'passed' && slower(t.seconds, typical, TEST_SLOWER_SECONDS),
          times: runs.map((r) => (r && r.result !== 'skipped' ? r.seconds : null)),
          outcomes,
          flaky:
            outcomes.includes('passed on re-run') ||
            Object.values(byCommit).some((r) => r.size === 2) ||
            flips >= FLIPS,
          edited,
        },
      ];
    }),
  );
}
