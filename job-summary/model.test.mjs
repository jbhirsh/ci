import { describe, expect, it } from 'vitest';
import { buildModel, noteworthy, parts } from './model.mjs';

const T0 = Date.parse('2026-10-29T10:00:00Z');
/** @param {number} s seconds after T0 */
const at = (s) => new Date(T0 + s * 1000).toISOString();

/**
 * A test case as junit.mjs reads it.
 *
 * @param {Partial<import('./junit.mjs').TestCase>} over
 * @returns {import('./junit.mjs').TestCase}
 */
const tc = (over) => ({
  name: 'T',
  seconds: 1,
  result: 'passed',
  file: 'r.xml',
  message: '',
  detail: '',
  suite: '',
  source: '',
  ...over,
});

describe('parts', () => {
  it("splits a test's name into its folder, file, describe blocks and title", () => {
    expect(
      parts(
        tc({
          name: 'job-summary/render.test.mjs › render › links > the report',
          suite: 'job-summary/render.test.mjs',
        }),
      ),
    ).toEqual({
      folder: 'job-summary/',
      file: 'render.test.mjs',
      block: 'render › links',
      title: 'the report',
    });
    expect(parts(tc({ name: 'home.spec.ts › filters by players', suite: 'home.spec.ts' }))).toEqual(
      {
        folder: '',
        file: 'home.spec.ts',
        block: '',
        title: 'filters by players',
      },
    );
  });

  it("keeps a flow's name whole, and a suite that failed as a whole as its own title", () => {
    expect(parts(tc({ name: 'Swipe to Keep', suite: 'Swipe to Keep' }))).toEqual({
      folder: '',
      file: '',
      block: '',
      title: 'Swipe to Keep',
    });
    expect(parts(tc({ name: 'a/b.test.mjs', suite: 'a/b.test.mjs' }))).toEqual({
      folder: '',
      file: '',
      block: '',
      title: 'a/b.test.mjs',
    });
  });
});

/**
 * An earlier run.
 *
 * @param {number} id
 * @param {string} conclusion
 * @param {import('./history.mjs').PastRun['tests']} tests
 * @param {number | null} [seconds]
 * @returns {import('./history.mjs').PastRun}
 */
const pastRun = (id, conclusion, tests, seconds = null) => ({
  run: {
    id,
    run_number: id,
    html_url: `https://gh/run/${id}`,
    head_branch: id % 2 ? 'main' : null,
    head_sha: `sha${id}`,
    created_at: at(-id * 100),
  },
  job: {
    name: 'Check',
    conclusion,
    started_at: at(0),
    completed_at: at(60),
    html_url: `https://gh/job/${id}`,
    steps: [{ name: 'Test', conclusion, started_at: at(0), completed_at: at(50) }],
  },
  tests,
  recorded: tests !== null,
  seconds,
});

/**
 * A model's input, with what a test changes.
 *
 * @param {Partial<import('./model.mjs').Input>} over
 * @returns {import('./model.mjs').Input}
 */
const input = (over = {}) => ({
  repo: 'jbhirsh/ci',
  workflow: 'CI',
  job: 'Check',
  noun: 'test',
  now: T0 + 70_000,
  run: {
    id: 9,
    run_number: 9,
    html_url: 'https://gh/run/9',
    head_branch: 'feat',
    head_sha: 'sha9',
    created_at: at(0),
  },
  current: {
    name: 'Check',
    conclusion: null,
    started_at: at(0),
    completed_at: null,
    html_url: 'https://gh/job/9',
  },
  steps: [
    { name: 'Set up', start: T0 + 2000, seconds: 3, conclusion: 'success' },
    { name: 'Test', start: T0 + 5000, seconds: 60, conclusion: 'success' },
  ],
  problem: '',
  tests: [
    tc({
      name: 'a/x.test.mjs › reads it',
      suite: 'a/x.test.mjs',
      seconds: 3,
      result: 'failed',
      detail: 'boom\n ❯ a/x.test.mjs:2:1',
    }),
  ],
  past: [
    pastRun(3, 'success', [{ name: 'a/x.test.mjs › reads it', seconds: 1, result: 'passed' }], 55),
    pastRun(2, 'failure', null),
    pastRun(1, 'success', [{ name: 'a/x.test.mjs › reads it', seconds: 1, result: 'passed' }]),
    pastRun(0, 'success', [{ name: 'a/x.test.mjs › reads it', seconds: 1.1, result: 'passed' }]),
  ],
  located: new Map([
    [
      'a/x.test.mjs › reads it',
      { path: 'a/x.test.mjs', line: 2, code: [[2, "it('reads it')", true]] },
    ],
  ]),
  changed: [null, null, null, new Set(['a/x.test.mjs']), null],
  reportOf: (id) => `https://pages/runs/${id}/check/`,
  notes: [['Simulator', 'iPhone 17 Pro']],
  load: [{ t: 0, load: 3, busy: 40 }],
  settle: 80,
  ...over,
});

describe('buildModel', () => {
  const model = buildModel(input());

  it("times the steps from the job's start, beside their earlier runs, oldest first", () => {
    expect(model.steps).toEqual([
      {
        i: 1,
        name: 'Set up',
        start: 2,
        seconds: 3,
        conclusion: 'success',
        usual: null,
        slower: false,
        past: [null, null, null, null],
      },
      {
        i: 2,
        name: 'Test',
        start: 5,
        seconds: 60,
        conclusion: 'success',
        usual: 50,
        slower: true,
        past: [50, 50, 50, 50],
      },
    ]);
  });

  it('lists the earlier runs oldest first, linking the ones with a record to their report', () => {
    expect(model.runs.map((r) => [r.number, r.url, r.seconds, r.conclusion, r.branch])).toEqual([
      [0, 'https://pages/runs/0/check/', 60, 'success', ''],
      [1, 'https://pages/runs/1/check/', 60, 'success', 'main'],
      [2, 'https://gh/job/2', 60, 'failure', ''],
      [3, 'https://pages/runs/3/check/', 55, 'success', 'main'],
    ]);
    expect(model.usual).toBe(60);
    expect(model.seconds).toBe(70);
    expect(model.run).toEqual({
      number: 9,
      url: 'https://gh/job/9',
      sha: 'sha9',
      branch: 'feat',
      when: at(0),
    });
  });

  it('gives each test its place, history, the runs that edited it and its snippet', () => {
    expect(model.tests).toEqual([
      {
        name: 'a/x.test.mjs › reads it',
        folder: 'a/',
        file: 'x.test.mjs',
        block: '',
        title: 'reads it',
        path: 'a/x.test.mjs',
        line: 2,
        seconds: 3,
        usual: 1,
        result: 'failed',
        slower: false,
        flaky: false,
        message: 'boom\n ❯ a/x.test.mjs:2:1',
        hist: ['passed', 'passed', '', 'passed'],
        times: [1.1, 1, null, 1],
        edited: [3],
        code: [[2, "it('reads it')", true]],
      },
    ]);
    expect(model.notes).toEqual([['Simulator', 'iPhone 17 Pro']]);
    expect(model.settle).toBe(80);
  });

  it('leaves out the last step while it runs (the summary itself), not an earlier one', () => {
    const steps = [
      { name: 'Test', start: T0, seconds: 60, conclusion: 'running' },
      { name: 'Summary', start: T0 + 60_000, seconds: 2, conclusion: 'running' },
    ];
    expect(buildModel(input({ steps })).steps.map((s) => s.name)).toEqual(['Test']);
  });

  it("links a run's report only while the Pages site keeps it, whether or not it had tests", () => {
    const old = {
      ...pastRun(5, 'success', []),
      run: { ...pastRun(5, 'success', []).run, created_at: at(-40 * 86_400) },
    };
    const noTests = { ...pastRun(6, 'success', null), recorded: true };
    const m = buildModel(input({ past: [noTests, old] }));
    expect(m.runs.map((r) => r.url)).toEqual(['https://gh/job/5', 'https://pages/runs/6/check/']);
  });

  it('holds no tests without reports, and no run when the job could not be read', () => {
    const bare = buildModel(
      input({
        tests: null,
        run: null,
        current: null,
        steps: [],
        past: [],
        problem: 'no job named "X"',
      }),
    );
    expect(bare).toMatchObject({
      tests: null,
      run: null,
      seconds: 0,
      usual: null,
      steps: [],
      runs: [],
      problem: 'no job named "X"',
    });
  });

  it("falls back to a test's first message line, and a step's start when the job's isn't known", () => {
    const m = buildModel(
      input({
        current: { name: 'Check', conclusion: null, started_at: null, completed_at: null },
        tests: [tc({ name: 'Flow', suite: 'Flow', result: 'failed', message: 'first line' })],
        located: new Map(),
      }),
    );
    expect(m.steps[0].start).toBe(0);
    expect(m.tests?.[0]).toMatchObject({ message: 'first line', path: '', line: 1, code: null });
    expect(m.run?.url).toBe('https://gh/run/9');
  });
});

describe('noteworthy', () => {
  it('names the tests that failed, passed on a re-run, got slower or are flaky', () => {
    const base = buildModel(input());
    const one = base.tests?.[0];
    if (!one) throw new Error('no test');
    /** @type {[string, import('./junit.mjs').TestCase['result'], boolean, boolean][]} */
    const cases = [
      ['a', 'failed', false, false],
      ['b', 'passed on re-run', false, false],
      ['c', 'passed', true, false],
      ['d', 'passed', false, true],
      ['e', 'passed', false, false],
    ];
    const tests = cases.map(([name, result, slower, flaky]) => ({
      ...one,
      name,
      result,
      slower,
      flaky,
    }));
    expect(noteworthy({ ...base, tests })).toEqual(new Set(['a', 'b', 'c', 'd']));
    expect(noteworthy({ ...base, tests: null })).toEqual(new Set());
  });
});
