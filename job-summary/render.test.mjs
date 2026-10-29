import { describe, expect, it } from 'vitest';
import { ATTENTION, MAX_BYTES, cell, duration, fit, over, render, verdict } from './render.mjs';

/**
 * A test in a model.
 *
 * @param {Partial<import('./model.mjs').ModelTest>} over
 * @returns {import('./model.mjs').ModelTest}
 */
const mt = (over) => ({
  name: 'T',
  folder: '',
  file: '',
  block: '',
  title: 'T',
  path: '',
  line: 1,
  seconds: 1,
  usual: null,
  result: 'passed',
  slower: false,
  flaky: false,
  message: '',
  hist: [],
  times: [],
  edited: [],
  code: null,
  ...over,
});

/**
 * A model, with what a test changes.
 *
 * @param {Partial<import('./model.mjs').Model>} [over]
 * @returns {import('./model.mjs').Model}
 */
const model = (over = {}) => ({
  repo: 'jbhirsh/sift',
  workflow: 'CI',
  job: 'E2E Tests (Maestro)',
  noun: 'flow',
  problem: '',
  run: {
    number: 20,
    url: 'https://gh/job/20',
    sha: 'fda062e',
    branch: 'feat',
    when: '2026-10-29T10:00:00Z',
  },
  seconds: 1500,
  usual: 1100,
  steps: [
    {
      i: 1,
      name: 'Simulator setup',
      start: 0,
      seconds: 174,
      conclusion: 'success',
      usual: 170,
      slower: false,
      past: [],
    },
    {
      i: 2,
      name: 'Run Maestro tests',
      start: 174,
      seconds: 1300,
      conclusion: 'failure',
      usual: 900,
      slower: true,
      past: [],
    },
  ],
  runs: [],
  tests: [
    mt({
      name: 'Swipe',
      title: 'Swipe',
      seconds: 31,
      result: 'failed',
      message: '\nAssertion is false: "1 kept"\n at step 12',
    }),
    mt({
      name: 'Retry',
      title: 'Retry',
      result: 'passed on re-run',
      flaky: true,
      hist: ['passed', 'failed', 'passed'],
    }),
    mt({
      name: 'a/b.test.mjs › block › Restore',
      folder: 'a/',
      file: 'b.test.mjs',
      block: 'block',
      title: 'Restore',
      seconds: 115,
      usual: 100,
      slower: true,
    }),
    mt({ name: 'Skip', title: 'Skip', result: 'skipped' }),
  ],
  notes: [],
  load: [],
  settle: null,
  ...over,
});

describe('cell', () => {
  it('keeps text to one line and shows it as written', () => {
    expect(cell('  a |\nb\t c  ')).toBe('a \\| b c');
    expect(cell('renders <GameCard /> & `code` *bold* [link]_x_')).toBe(
      'renders &lt;GameCard /&gt; &amp; \\`code\\` \\*bold\\* \\[link\\]\\_x\\_',
    );
  });
});

describe('duration and over', () => {
  it('reads as people say it', () => {
    expect([0, 0.0004, 0.04, 3, 9.96, 12.4, 65, 3599, 3720].map(duration)).toEqual([
      '0s',
      '1ms',
      '40ms',
      '3s',
      '10s',
      '12s',
      '1m 05s',
      '59m 59s',
      '1h 02m',
    ]);
  });

  it('is a percentage over a usual time, and seconds over a usual time of nothing', () => {
    expect(over(115, 100)).toBe('+15%');
    expect(over(40, 0)).toBe('+40s');
  });
});

describe('verdict', () => {
  it('says what failed, the time and how it compares', () => {
    expect(verdict(model())).toBe('❌ 1 of 3 flows failed · 25m 00s · 36% slower than usual');
  });

  it('names a failed step when every test passed, still counting them', () => {
    const tests = [mt({ result: 'passed' }), mt({ result: 'passed on re-run' })];
    expect(verdict(model({ tests, usual: 1480 }))).toBe(
      '❌ Run Maestro tests failed · 2 flows passed, 1 on re-run · 25m 00s · about as long as usual',
    );
    expect(verdict(model({ tests: null, usual: 2000 }))).toBe(
      '❌ Run Maestro tests failed · 25m 00s · 25% faster than usual',
    );
  });

  it('says when everything passed, or no step failed, and leaves out what it can’t know', () => {
    const ok = model().steps.map((s) => ({ ...s, conclusion: 'success' }));
    expect(verdict(model({ steps: ok, tests: [mt({})], usual: null }))).toBe(
      '✅ 1 flow passed · 25m 00s',
    );
    expect(verdict(model({ steps: ok, tests: null, run: null }))).toBe('✅ no step failed');
    expect(verdict(model({ steps: ok, tests: [mt({ result: 'skipped' })], run: null }))).toBe(
      '⚪ all 1 flow skipped',
    );
    const open = [{ ...ok[0], conclusion: 'running' }, ok[1]];
    expect(verdict(model({ steps: open, tests: null, run: null }))).toBe(
      '✅ no step failed so far',
    );
  });
});

describe('render', () => {
  it('leads with the verdict and the report, then what needs attention', () => {
    expect(render(model(), 'https://jbhirsh.github.io/sift/runs/20/e2e/')).toBe(
      [
        '### E2E Tests (Maestro): ❌ 1 of 3 flows failed · 25m 00s · 36% slower than usual',
        '',
        "**[Full report](https://jbhirsh.github.io/sift/runs/20/e2e/)**: every step and flow beside its recent runs. It's published once the workflow finishes.",
        '',
        '**Needs attention**',
        '',
        '- **Failed:** Swipe after 31s: Assertion is false: "1 kept"',
        '- **Passed on re-run:** Retry',
        '- **Flaky:** Retry, failed 2 of its last 4 runs',
        '- **Slower than usual:** Run Maestro tests: 21m 40s, usually 15m 00s (+44%) · Restore (a/b.test.mjs › block): 1m 55s, usually 1m 40s (+15%)',
      ].join('\n'),
    );
  });

  it('names a failed step when no test failed, and says why there is no history', () => {
    const text = render(model({ tests: null, problem: 'no job named "E2E"' }), '');
    expect(text).toContain('No step times or history: no job named "E2E"');
    expect(text).toContain('- **Failed step:** Run Maestro tests');
    expect(text).not.toContain('Full report');
  });

  it('caps each list, pointing at the report for the rest', () => {
    const many = Array.from({ length: ATTENTION + 2 }, (_, i) =>
      mt({ name: `f${i}`, title: `f${i}`, result: 'failed' }),
    );
    const reruns = Array.from({ length: ATTENTION + 1 }, (_, i) =>
      mt({ name: `r${i}`, title: `r${i}`, result: 'passed on re-run' }),
    );
    const text = render(model({ tests: [...many, ...reruns] }), '');
    expect(text.match(/\*\*Failed:\*\*/g)).toHaveLength(ATTENTION);
    expect(text).toContain('- …and 2 more failed flows, in the report');
    expect(text).toContain('r4 · …and 1 more in the report');
  });

  it('writes nothing to attend to when nothing needs it', () => {
    const ok = model().steps.map((s) => ({ ...s, conclusion: 'success', slower: false }));
    expect(render(model({ steps: ok, tests: [mt({})] }), '')).toBe(
      '### E2E Tests (Maestro): ✅ 1 flow passed · 25m 00s · 36% slower than usual',
    );
  });
});

describe('fit', () => {
  it("cuts a summary over GitHub's limit at a line, saying so", () => {
    const huge = fit(Array.from({ length: 10_000 }, () => 'y'.repeat(200)).join('\n'));
    expect(Buffer.byteLength(huge)).toBeLessThanOrEqual(MAX_BYTES);
    expect(huge.endsWith("…cut here: the summary would be over GitHub's 1 MiB limit.")).toBe(true);
    expect(fit('short')).toBe('short');
  });
});
