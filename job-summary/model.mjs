// Everything job-summary shows about a run, worked out once: the report
// page (report.html) reads it as JSON, and the run's summary (render.mjs)
// is written from it. summary.mjs gathers the inputs; this is pure.
//
// Times are seconds. Earlier runs are listed oldest first, and every list
// of per-run values (a step's times, a test's results) lines up with them,
// this run's value apart. A test's file, line and snippet come from
// source.mjs, its usual time and flakiness from trends.mjs.

import { KEEP_DAYS } from './report.mjs';
import { jobSeconds, stepTrends, testTrends, usual } from './trends.mjs';

/** @typedef {import('./junit.mjs').TestCase} TestCase */
/** @typedef {import('./history.mjs').PastRun} PastRun */
/** @typedef {import('./history.mjs').Run} Run */
/** @typedef {import('./history.mjs').Job} Job */
/** @typedef {import('./trends.mjs').StepRow} StepRow */
/** @typedef {import('./trends.mjs').Outcome} Outcome */
/** @typedef {import('./source.mjs').Located} Located */

/**
 * One CPU sample: seconds into the job, the load average, % busy.
 *
 * @typedef {{ t: number, load: number, busy: number }} Sample
 */

/**
 * What the model is made from.
 *
 * @typedef {object} Input
 * @property {string} repo owner/name
 * @property {string} workflow
 * @property {string} job
 * @property {string} noun what a test is called
 * @property {number} now milliseconds
 * @property {Run | null} run this run
 * @property {Job | null} current this job
 * @property {StepRow[]} steps this job's
 * @property {string} problem why there are no steps or history ('' when there are)
 * @property {TestCase[] | null} tests one per test, null without reports
 * @property {PastRun[]} past newest first
 * @property {Map<string, Located>} located by test name
 * @property {(Set<string> | null)[]} changed files each commit changed, oldest run first, this one last
 * @property {(runId: number) => string} reportOf an earlier run's report page
 * @property {[string, string][]} notes
 * @property {Sample[]} load
 * @property {number | null} settle the settle wait's limit, % busy
 */

/**
 * A test in the model.
 *
 * @typedef {object} ModelTest
 * @property {string} name its full name, the key across runs
 * @property {string} folder its file's folder, with a trailing slash
 * @property {string} file its file's name ('' for a Maestro flow)
 * @property {string} block the describe blocks around it, joined by " › "
 * @property {string} title
 * @property {string} path its file in the repository ('' when not found)
 * @property {number} line
 * @property {number} seconds
 * @property {number | null} usual
 * @property {TestCase['result']} result
 * @property {boolean} slower
 * @property {boolean} flaky
 * @property {string} message a failure's whole message ('' otherwise)
 * @property {Outcome[]} hist its result in each earlier run
 * @property {(number | null)[]} times its time in each earlier run (null where it didn't run)
 * @property {number[]} edited the runs (0 = oldest, runs.length = this one) whose commit changed its file
 * @property {[number, string, boolean][] | null} code its snippet
 */

/**
 * @typedef {object} Model
 * @property {string} repo
 * @property {string} workflow
 * @property {string} job
 * @property {string} noun
 * @property {string} problem
 * @property {{ number: number, url: string, sha: string, branch: string, when: string } | null} run
 * @property {number} seconds this job's time so far
 * @property {number | null} usual the usual time (median of the earlier runs that passed)
 * @property {{ i: number, name: string, start: number, seconds: number, conclusion: string, usual: number | null, slower: boolean, past: (number | null)[] }[]} steps
 * @property {{ number: number, url: string, sha: string, branch: string, when: string, seconds: number, conclusion: string }[]} runs
 * @property {ModelTest[] | null} tests
 * @property {[string, string][]} notes
 * @property {Sample[]} load
 * @property {number | null} settle
 */

/**
 * A test's place: the folder and file its suite names, the describe blocks
 * around it and its own title, from its full name.
 *
 * @param {TestCase} t
 */
export function parts(t) {
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
 *
 * @param {Input} input
 * @returns {Model}
 */
export function buildModel(input) {
  const { now, past, steps } = input;
  const ordered = [...past].reverse();
  const began = Date.parse(input.current?.started_at ?? '');
  const zero = Number.isFinite(began) ? began : (steps[0]?.start ?? now);
  const sTrends = stepTrends(steps, past, now);
  const pathOf = (/** @type {TestCase} */ t) => input.located.get(t.name)?.path ?? '';
  const tTrends = testTrends(
    input.tests ?? [],
    past,
    input.run?.head_sha ?? '',
    input.changed,
    pathOf,
  );
  const pastSeconds = (/** @type {PastRun} */ p) => p.seconds ?? jobSeconds(p.job, now);
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
 * @param {Model} model
 * @returns {Set<string>} their names
 */
export function noteworthy(model) {
  return new Set(
    (model.tests ?? [])
      .filter(
        (t) => t.result === 'failed' || t.result === 'passed on re-run' || t.slower || t.flaky,
      )
      .map((t) => t.name),
  );
}
