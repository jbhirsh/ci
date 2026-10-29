import { describe, expect, it } from 'vitest';
import {
  MIN_SAMPLES,
  byTest,
  jobSeconds,
  slower,
  stepRows,
  stepTrends,
  testTrends,
  usual,
} from './trends.mjs';

const T0 = Date.parse('2026-10-29T10:00:00Z');
/** @param {number} s seconds after T0 */
const at = (s) => new Date(T0 + s * 1000).toISOString();

/**
 * A step as the Actions API gives it.
 *
 * @param {string} name
 * @param {string | null} conclusion
 * @param {string | null} start
 * @param {string | null} end
 */
const step = (name, conclusion, start, end) => ({
  name,
  conclusion,
  started_at: start,
  completed_at: end,
});

/**
 * An earlier run of the job.
 *
 * @param {string} conclusion
 * @param {Record<string, number>} times each step's seconds
 * @param {import('./history.mjs').PastRun['tests']} [tests]
 * @param {string} [sha]
 * @returns {import('./history.mjs').PastRun}
 */
const pastRun = (conclusion, times, tests = null, sha = '') => ({
  run: {
    id: 1,
    run_number: 1,
    html_url: '',
    head_branch: 'main',
    head_sha: sha,
    created_at: at(0),
  },
  job: {
    name: 'J',
    conclusion,
    started_at: at(0),
    completed_at: at(100),
    steps: Object.entries(times).map(([name, s]) => step(name, 'success', at(0), at(s))),
  },
  tests,
  recorded: tests !== null,
  seconds: null,
});

describe('stepRows', () => {
  it('times the steps that ran, a running one up to now, and leaves out skipped and unstarted ones', () => {
    expect(
      stepRows(
        [
          step('Set up job', 'success', at(0), at(3)),
          step('Accessibility audit', 'failure', at(3), at(617)),
          step('Upload GIF videos', 'skipped', at(617), at(617)),
          step('Run jbhirsh/ci/job-summary@main', null, at(630), null),
          step('Post Run actions/checkout@v7', null, null, null),
        ],
        T0 + 660_000,
      ),
    ).toEqual([
      { name: 'Set up job', start: T0, seconds: 3, conclusion: 'success' },
      { name: 'Accessibility audit', start: T0 + 3000, seconds: 614, conclusion: 'failure' },
      {
        name: 'Run jbhirsh/ci/job-summary@main',
        start: T0 + 630_000,
        seconds: 30,
        conclusion: 'running',
      },
    ]);
  });

  it("never gives a negative or NaN time, nor a start it can't read", () => {
    const rows = stepRows(
      [step('back', 'success', at(5), at(0)), step('bad', 'success', 'yesterday', at(0))],
      T0,
    );
    expect(rows.map((r) => [r.seconds, r.start])).toEqual([
      [0, T0 + 5000],
      [0, T0],
    ]);
  });
});

describe('jobSeconds', () => {
  it('times a job start to end, or to now while it runs', () => {
    expect(jobSeconds({ started_at: at(0), completed_at: at(90) })).toBe(90);
    expect(jobSeconds({ started_at: at(0), completed_at: null }, T0 + 30_000)).toBe(30);
    expect(jobSeconds({ started_at: null, completed_at: null })).toBe(0);
  });
});

describe('usual', () => {
  it('is the median, given enough values', () => {
    expect(usual([3, 1, 2])).toBe(2);
    expect(usual([4, 1, 3, 2])).toBe(2.5);
    expect(usual(Array(MIN_SAMPLES - 1).fill(5))).toBeNull();
  });
});

describe('slower', () => {
  it('needs both the ratio and the seconds', () => {
    expect(slower(115, 100)).toBe(true);
    expect(slower(114, 100)).toBe(false);
    expect(slower(3, 2)).toBe(false);
    expect(slower(20, 10)).toBe(true);
    expect(slower(1000, null)).toBe(false);
  });
});

describe('byTest', () => {
  /**
   * @param {string} name
   * @param {import('./junit.mjs').TestCase['result']} result
   * @param {number} seconds
   * @returns {import('./junit.mjs').TestCase}
   */
  const tc = (name, result, seconds) => ({
    name,
    seconds,
    result,
    file: '',
    message: '',
    detail: '',
    suite: '',
    source: '',
  });

  it("keeps one row per test, a re-run's first try over its pass", () => {
    expect(
      byTest([
        tc('A', 'passed', 9),
        tc('A', 'passed on re-run', 30),
        tc('B', 'skipped', 0),
        tc('B', 'failed', 4),
        tc('C', 'passed', 1),
        tc('C', 'passed', 2),
      ]),
    ).toEqual([tc('A', 'passed on re-run', 30), tc('B', 'failed', 4), tc('C', 'passed', 1)]);
  });
});

describe('stepTrends', () => {
  it("compares each step with the passing runs' median, listing every run's time oldest first", () => {
    const past = [
      pastRun('success', { Test: 100, Build: 50 }),
      pastRun('failure', { Test: 400 }),
      pastRun('success', { Test: 110, Build: 52 }),
      pastRun('success', { Test: 90 }),
    ];
    const trends = stepTrends(
      [
        { name: 'Test', start: T0, seconds: 130, conclusion: 'success' },
        { name: 'Build', start: T0, seconds: 90, conclusion: 'success' },
        { name: 'Summary', start: T0, seconds: 900, conclusion: 'running' },
      ],
      past,
      T0,
    );
    expect(trends.get('Test')).toEqual({ usual: 100, slower: true, times: [90, 110, 400, 100] });
    expect(trends.get('Build')).toEqual({
      usual: null,
      slower: false,
      times: [null, 52, null, 50],
    });
    expect(trends.get('Summary')?.slower).toBe(false);
  });

  it('reads a past job with no steps as none', () => {
    const past = pastRun('success', {});
    delete past.job.steps;
    expect(
      stepTrends([{ name: 'A', start: T0, seconds: 1, conclusion: 'success' }], [past]).get('A'),
    ).toEqual({ usual: null, slower: false, times: [null] });
  });
});

describe('testTrends', () => {
  /**
   * @param {import('./junit.mjs').TestCase['result']} result
   * @param {number} [seconds]
   */
  const t = (result, seconds = 10) => [{ name: 'T', seconds, result }];
  /**
   * The trend of test T, given its earlier results (oldest first) and this run's.
   *
   * @param {(import('./history.mjs').PastRun['tests'])[]} earlier
   * @param {import('./junit.mjs').TestCase['result']} result
   * @param {number} [seconds]
   * @param {string[]} [shas] the earlier runs' commits, then this run's
   * @param {(Set<string> | null)[]} [changed] files each commit changed
   */
  const trend = (earlier, result, seconds = 10, shas = [], changed = []) =>
    testTrends(
      [{ name: 'T', seconds, result, file: '', message: '', detail: '', suite: '', source: '' }],
      earlier.map((tests, i) => pastRun('success', {}, tests, shas[i])).reverse(),
      shas[earlier.length],
      changed,
      () => 't.test.mjs',
    ).get('T');

  it('takes the usual time from the runs it passed in, and skips runs with no record', () => {
    expect(
      trend(
        [t('passed', 10), t('failed', 99), null, t('passed', 12), t('passed', 11), []],
        'passed',
        30,
      ),
    ).toEqual({
      usual: 11,
      slower: true,
      times: [10, 99, null, 12, 11, null],
      outcomes: ['passed', 'failed', '', 'passed', 'passed', '', 'passed'],
      flaky: false,
      edited: [],
    });
  });

  it('calls a test broken, or broken and fixed, not flaky', () => {
    const P = t('passed');
    const F = t('failed');
    expect(trend([P, P], 'failed')?.flaky).toBe(false);
    expect(trend([F, F], 'failed')?.flaky).toBe(false);
    expect(trend([P, P, F, P], 'passed')?.flaky).toBe(false);
  });

  it('calls a test flaky when it passed on a re-run, mixed results on a commit, or kept changing', () => {
    const P = t('passed');
    const F = t('failed');
    expect(trend([], 'passed on re-run')?.flaky).toBe(true);
    expect(trend([P, F], 'passed', 10, ['a', 'b', 'b'])?.flaky).toBe(true);
    expect(trend([P, F], 'passed', 10, ['a', 'b', 'c'])?.flaky).toBe(false);
    expect(trend([P, F, P], 'failed')?.flaky).toBe(true);
    expect(trend([P, F, t('skipped'), [], P], 'passed')?.flaky).toBe(false);
  });

  it("doesn't count a change of result on a commit that edited the test", () => {
    const P = t('passed');
    const F = t('failed');
    const edit = new Set(['t.test.mjs']);
    const other = new Set(['src/a.ts']);
    // P F P F: three changes; one of them on a commit that edited the test.
    expect(trend([P, F, P], 'failed', 10, [], [null, null, edit, null])).toMatchObject({
      flaky: false,
      edited: [2],
    });
    // The same with only other files changed is flaky.
    expect(trend([P, F, P], 'failed', 10, [], [null, other, other, other])?.flaky).toBe(true);
    // An edit before a gap (a run without a record) still explains the change after it.
    expect(trend([P, F, null, P], 'failed', 10, [], [null, null, edit, null, null])?.flaky).toBe(
      false,
    );
  });

  it('never calls a failed or skipped run slower, and times a skip as nothing', () => {
    const passes = [t('passed'), t('passed'), t('passed'), t('skipped', 0)];
    expect(trend(passes, 'failed', 100)?.slower).toBe(false);
    expect(trend(passes, 'passed', 100)?.times).toEqual([10, 10, 10, null]);
  });
});
