// The run the GIF tool records job-summary's report page from (page.ts
// builds it, ci#176): a model's input, as summary.ts gathers one from the
// Actions API and the job's JUnit reports, made up and fixed, so every
// recording of the page shows the same run's model. One job, `Check`, with its
// steps and tests, and five earlier runs, enough for each step's and test's
// usual time (trends.ts's MIN_SAMPLES), a sparkline and a "Job time" chart.
// One step and one test run slower than usual, so the page has something
// to point at; every test passes, so the test tree opens collapsed (the
// page opens only the groups holding a failure), for a scenario to open.
//
// The numbers are a Check job's of this repo, rounded. A scenario that
// needs more of the page (a card a later change adds) adds it here.

import type { TestCase } from '../junit.ts';
import type { Job, PastRun } from '../history.ts';
import type { Input } from '../model.ts';
import type { StepRow } from '../trends.ts';

/**
 * When the run's job started: a fixed time, so the model is the same on
 * every run. The page still reads the clock and locale it opens with (how
 * long ago a run was, how a time is written), but both sides record on the
 * same runner, so "before" and "after" agree.
 */
const T0 = Date.parse('2026-11-20T10:00:00Z');

/** @param s seconds after T0 */
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

/** Each step's name and seconds this run, then in each earlier run, newest first. */
const STEPS: [string, number, number[]][] = [
  ['Set up job', 2, [2, 2, 3, 2, 2]],
  ['Run actions/checkout@v7', 3, [3, 2, 3, 3, 4]],
  ['Run actions/setup-node@v7', 6, [5, 6, 5, 7, 6]],
  ['Run npm ci', 21, [19, 20, 22, 18, 21]],
  ['Run npx playwright install --with-deps webkit', 48, [46, 51, 47, 49, 45]],
  ['Run npm run lint', 34, [33, 35, 32, 34, 36]],
  ['Run npm run format:check', 4, [4, 4, 5, 4, 4]],
  ['Run npm run typecheck', 9, [8, 9, 9, 8, 10]],
  ['Run npm run test:coverage', 142, [96, 101, 94, 99, 97]],
  ['Pins (pins/check.ts, as the apps run it)', 2, [2, 2, 2, 2, 2]],
  ['Lint workflows (actionlint)', 7, [7, 6, 8, 7, 7]],
];

/** Each test's file, describe block, title and seconds this run, then in each earlier run, newest first. */
const TESTS: [string, string, string, number, number[]][] = [
  [
    'job-summary/model.test.ts',
    'buildModel',
    'times each step from the job',
    0.04,
    [0.04, 0.05, 0.04, 0.04, 0.05],
  ],
  [
    'job-summary/model.test.ts',
    'buildModel',
    "lines each test's runs up, oldest first",
    0.06,
    [0.05, 0.06, 0.06, 0.05, 0.06],
  ],
  [
    'job-summary/model.test.ts',
    'parts',
    "splits a test's name into its folder, file and title",
    0.01,
    [0.01, 0.01, 0.01, 0.01, 0.01],
  ],
  [
    'job-summary/report.test.ts',
    'report',
    'draws the steps, tests and history',
    1.9,
    [1.8, 1.9, 1.7, 1.8, 2],
  ],
  [
    'job-summary/report.test.ts',
    'report',
    'escapes a test name holding </script>',
    0.3,
    [0.3, 0.3, 0.2, 0.3, 0.3],
  ],
  [
    'job-summary/summary.test.ts',
    'build',
    'reads the job, its steps and its reports',
    0.5,
    [0.4, 0.5, 0.5, 0.4, 0.5],
  ],
  [
    'gif/route.test.ts',
    'routePage',
    'serves a folder as its index.html',
    0.2,
    [0.2, 0.2, 0.2, 0.2, 0.2],
  ],
  ['gif/route.test.ts', 'routePage', 'aborts every other origin', 0.1, [0.1, 0.1, 0.1, 0.1, 0.1]],
  [
    'gif/cli.test.ts',
    'recordSide',
    'plays the scenario against the routed page',
    6.4,
    [3.1, 3.3, 2.9, 3.2, 3],
  ],
  [
    'gif/workflow.test.ts',
    'changedScenarios',
    'records only files in the scenarios folder',
    0.02,
    [0.02, 0.02, 0.02, 0.02, 0.02],
  ],
  [
    'lint/gif-callers.test.ts',
    'lintGifCallers',
    'refuses a local call of pr-gif.yml',
    0.03,
    [0.03, 0.03, 0.03, 0.03, 0.03],
  ],
];

/** The steps of a job that ran from `start` seconds after T0, timed by `seconds`. */
function stepsOf(start: number, seconds: number[]) {
  let t = start;
  return STEPS.map(([name], k) => {
    const step = {
      name,
      conclusion: 'success',
      started_at: at(t),
      completed_at: at(t + seconds[k]),
    };
    t += seconds[k];
    return step;
  });
}

/** This run's commit, then each earlier run's, newest first. */
const SHAS = [
  '4c1e9a7d2b5f8e03a6d4c9b1e7f2a805c3d6b9e4',
  '9e2b7c4f1a8d3e6b5c0f7a2d9e4b1c8f6a3d5e7b',
  'b7f3a1c9e5d2b8f4a6c0e3d7b1f9a5c2e8d4b6f0',
  '2d8e5b3f9c1a7e4d6b0c8f2a5e9d3b7c1f4a6e8d',
  'e6a4c8f2b9d5e1a3c7f0b4d8e2a6c9f5b1d3e7a0',
  '7b1d9f3e5a8c2b6d4f0e9a3c7b5d1f8e2a6c4b9d',
];
const total = (seconds: number[]) => seconds.reduce((sum, s) => sum + s, 0);

/** A test case as junit.ts reads one from Vitest's report. */
function testCase([file, block, title, seconds]: (typeof TESTS)[number]): TestCase {
  return {
    name: `${file} › ${block} › ${title}`,
    seconds,
    result: 'passed',
    file: 'reports/junit.xml',
    message: '',
    detail: '',
    suite: file,
    source: '',
  };
}

/** The `ago`th earlier run (1 the newest): a day apart, each on main. */
function pastRun(ago: number): PastRun {
  const id = 9000 - ago;
  const start = -ago * 86_400;
  const seconds = STEPS.map(([, , past]) => past[ago - 1]);
  const job: Job = {
    name: 'Check',
    conclusion: 'success',
    started_at: at(start),
    completed_at: at(start + total(seconds)),
    html_url: `https://github.com/jbhirsh/ci/actions/runs/${id}/job/${id}`,
    steps: stepsOf(start, seconds),
  };
  return {
    run: {
      id,
      run_number: 400 - ago,
      html_url: `https://github.com/jbhirsh/ci/actions/runs/${id}`,
      head_branch: 'main',
      head_sha: SHAS[ago],
      created_at: at(start),
    },
    job,
    tests: TESTS.map((t) => ({ ...testCase(t), seconds: t[4][ago - 1] })),
    recorded: true,
    seconds: total(seconds),
  };
}

/**
 * The model's input: this run of `Check`, still writing its summary, and
 * its five earlier runs.
 */
export function fixture(): Input {
  const seconds = STEPS.map(([, s]) => s);
  const steps: StepRow[] = stepsOf(0, seconds).map((s, k) => ({
    name: s.name,
    start: Date.parse(s.started_at),
    seconds: seconds[k],
    conclusion: 'success',
  }));
  const end = total(seconds);
  const current: Job = {
    name: 'Check',
    conclusion: null,
    started_at: at(0),
    completed_at: null,
    html_url: 'https://github.com/jbhirsh/ci/actions/runs/9000/job/9000',
  };
  return {
    repo: 'jbhirsh/ci',
    workflow: 'CI',
    job: 'Check',
    noun: 'test',
    now: T0 + (end + 5) * 1000,
    run: {
      id: 9000,
      run_number: 400,
      html_url: 'https://github.com/jbhirsh/ci/actions/runs/9000',
      head_branch: 'gif-page',
      head_sha: SHAS[0],
      created_at: at(0),
    },
    current,
    steps,
    problem: '',
    tests: TESTS.map(testCase),
    past: [1, 2, 3, 4, 5].map(pastRun),
    located: new Map(),
    changed: [null, null, null, null, null, null],
    reportOf: (runId) => `https://jbhirsh.github.io/ci/runs/${runId}/check/`,
    notes: [],
    load: [],
    settle: null,
  };
}
