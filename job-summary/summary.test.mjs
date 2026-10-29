import { describe, expect, it } from 'vitest';
import {
  MAX_ROWS,
  build,
  cell,
  jobSteps,
  markdown,
  parseJunit,
  reportFiles,
  settleReruns,
  stepRows,
  unescapeXml,
} from './summary.mjs';

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

const NOW = Date.parse('2026-10-29T10:11:00Z');

describe('stepRows', () => {
  it('times the steps that ran, a running one up to now, and leaves out skipped and unstarted ones', () => {
    expect(
      stepRows(
        [
          step('Set up job', 'success', '2026-10-29T10:00:00Z', '2026-10-29T10:00:03Z'),
          step('Accessibility audit', 'failure', '2026-10-29T10:00:03Z', '2026-10-29T10:10:17Z'),
          step('Upload GIF videos', 'skipped', '2026-10-29T10:10:17Z', '2026-10-29T10:10:17Z'),
          step('Run jbhirsh/ci/job-summary@main', null, '2026-10-29T10:10:30Z', null),
          step('Post Run actions/checkout@v7', null, null, null),
        ],
        NOW,
      ),
    ).toEqual([
      { name: 'Set up job', seconds: 3, conclusion: 'success' },
      { name: 'Accessibility audit', seconds: 614, conclusion: 'failure' },
      { name: 'Run jbhirsh/ci/job-summary@main', seconds: 30, conclusion: 'running' },
    ]);
  });

  it('never gives a negative or NaN time', () => {
    const rows = stepRows([
      step('back', 'success', '2026-10-29T10:00:05Z', '2026-10-29T10:00:00Z'),
      step('bad', 'success', 'yesterday', '2026-10-29T10:00:00Z'),
    ]);
    expect(rows.map((r) => r.seconds)).toEqual([0, 0]);
  });
});

describe('unescapeXml', () => {
  it('replaces named and numeric entities, and leaves unknown ones', () => {
    expect(unescapeXml('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(
      `a & b <c> "d" 'e'`,
    );
    expect(unescapeXml('&#233;&#xE9;&#XE9;')).toBe('ééé');
    expect(unescapeXml('&nbsp; &#x110000; &#99999999;')).toBe('&nbsp; &#x110000; &#99999999;');
  });
});

describe('parseJunit', () => {
  it("reads Maestro's report: a status attribute, failures inside", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<testsuites>
  <testsuite name="Test Suite" device="iPhone 17 Pro" tests="2" failures="1" time="61.5">
    <testcase id="Swipe to Keep and Remove" name="Swipe to Keep and Remove" classname="Swipe to Keep and Remove" file=".maestro/19_swipe_decisions.yaml" time="30.738" timestamp="2026-10-29T06:56:07" status="ERROR">
      <failure>Assertion is false: "1 kept", id: stat-kept is visible</failure>
    </testcase>
    <testcase id="Setup" name="Setup &amp; sort" classname="Setup" file=".maestro/01_setup.yaml" time="12.1" status="SUCCESS"/>
  </testsuite>
</testsuites>`;
    expect(parseJunit(xml, 'suite.xml')).toEqual([
      { name: 'Swipe to Keep and Remove', seconds: 30.738, result: 'failed', file: 'suite.xml' },
      { name: 'Setup & sort', seconds: 12.1, result: 'passed', file: 'suite.xml' },
    ]);
  });

  it('counts a status other than a success as failed, even with nothing inside', () => {
    const xml =
      '<testcase name="a" status="CANCELED"/><testcase name="b" status="STOPPED"/>' +
      '<testcase name="c" status="WARNING"/><testcase name="d" status="passed"/>';
    expect(parseJunit(xml).map((c) => c.result)).toEqual(['failed', 'failed', 'passed', 'passed']);
  });

  it("reads Playwright's and Vitest's: errors and skips as elements", () => {
    const xml = `<testsuite>
<testcase name='home › filters by players' classname="home.spec.ts" time="4.2"></testcase>
<testcase name="phone › opens the menu" time="1.5"><error message="boom"/></testcase>
<testcase name="offline › later" time="0"><skipped/></testcase>
<testcase name="status skip" status="skipped"/>
</testsuite>`;
    expect(parseJunit(xml).map((c) => [c.name, c.seconds, c.result])).toEqual([
      ['home › filters by players', 4.2, 'passed'],
      ['phone › opens the menu', 1.5, 'failed'],
      ['offline › later', 0, 'skipped'],
      ['status skip', 0, 'skipped'],
    ]);
  });

  it('ignores what captured output and comments hold, even when it looks like JUnit', () => {
    const xml = `<testsuite>
<testcase name="prints errors" time="1"><system-out><![CDATA[<error>not mine</error> <skipped/>
</testcase><testcase name="ghost" time="99"/>]]></system-out></testcase>
<!-- <testcase name="commented out"/> -->
<testcase name="real failure" time="2"><failure><![CDATA[expected <a> to be <b>]]></failure></testcase>
<!-- an unclosed comment <testcase name="hidden"/>`;
    expect(parseJunit(xml).map((c) => [c.name, c.result])).toEqual([
      ['prints errors', 'passed'],
      ['real failure', 'failed'],
    ]);
  });

  it('names a case by its classname or file when it has no name, and zeroes a bad time', () => {
    expect(
      parseJunit(
        '<testcase classname="Only class" time="abc"/><testcase file="f.yaml" time="-3"/><testcase/>',
      ),
    ).toEqual([
      { name: 'Only class', seconds: 0, result: 'passed', file: '' },
      { name: 'f.yaml', seconds: 0, result: 'passed', file: '' },
      { name: '?', seconds: 0, result: 'passed', file: '' },
    ]);
  });

  it('keeps a ">" inside an attribute, and finds nothing in what isn\'t JUnit', () => {
    expect(parseJunit('<testcase name="a > b" time="1"/>')[0].name).toBe('a > b');
    expect(parseJunit('<html><body>not junit</body></html>')).toEqual([]);
    expect(parseJunit('')).toEqual([]);
  });
});

describe('settleReruns', () => {
  /**
   * @param {string} name
   * @param {import('./summary.mjs').TestCase['result']} result
   * @param {string} file
   * @returns {import('./summary.mjs').TestCase}
   */
  const tc = (name, result, file) => ({ name, seconds: 1, result, file });

  it('reads a failure that passed in another report as passed on re-run, in either order', () => {
    expect(
      settleReruns([
        tc('Swipe', 'passed', '19_swipe.retry.xml'),
        tc('Swipe', 'failed', 'suite.xml'),
        tc('Setup', 'failed', 'suite.xml'),
        tc('Undo', 'failed', 'suite.xml'),
        tc('Undo', 'passed', 'Undo.retry.xml'),
      ]).map((c) => c.result),
    ).toEqual(['passed', 'passed on re-run', 'failed', 'passed on re-run', 'passed']);
  });

  it('leaves a failure alone when its re-run failed too, or it passed only in its own report', () => {
    expect(
      settleReruns([
        tc('B', 'failed', 'one.xml'),
        tc('B', 'failed', 'B.retry.xml'),
        tc('C', 'failed', 'one.xml'),
        tc('C', 'passed', 'one.xml'),
      ]).map((c) => c.result),
    ).toEqual(['failed', 'failed', 'failed', 'passed']);
  });
});

describe('cell', () => {
  it('keeps a cell to one line and shows its text as written', () => {
    expect(cell('  a |\nb\t c  ')).toBe('a \\| b c');
    expect(cell('renders <GameCard /> & `code` *bold* [link]_x_')).toBe(
      'renders &lt;GameCard /&gt; &amp; \\`code\\` \\*bold\\* \\[link\\]\\_x\\_',
    );
    expect(cell('<!-- hides the rest')).toBe('&lt;!-- hides the rest');
  });
});

describe('markdown', () => {
  it('lists the steps, then the tests: failures first, then slowest first, with their reports', () => {
    const text = markdown(
      'E2E Tests (Maestro)',
      { rows: [{ name: 'Run Maestro tests', seconds: 1064.4, conclusion: 'failure' }] },
      [
        { name: 'Setup', seconds: 12, result: 'passed', file: 'maestro-results/suite.xml' },
        { name: 'Undo', seconds: 5, result: 'failed', file: 'maestro-results/suite.xml' },
        {
          name: 'Swipe',
          seconds: 30.7,
          result: 'passed on re-run',
          file: 'maestro-results/suite.xml',
        },
        { name: 'Swipe', seconds: 9, result: 'passed', file: 'maestro-results/19.retry.xml' },
      ],
    );
    expect(text).toBe(
      [
        '### E2E Tests (Maestro): step times',
        '',
        '| Step | Seconds | Result |',
        '|---|--:|---|',
        '| Run Maestro tests | 1064 | failure |',
        '',
        '### Tests: 4 from 2 reports, 1 failed, 1 passed on re-run',
        '',
        '| Test | Seconds | Result | Report |',
        '|---|--:|---|---|',
        '| Undo | 5 | failed | suite.xml |',
        '| Swipe | 31 | passed on re-run | suite.xml |',
        '| Setup | 12 | passed | suite.xml |',
        '| Swipe | 9 | passed | 19.retry.xml |',
      ].join('\n'),
    );
  });

  it('lists every failure but caps the rest, saying how many it left out', () => {
    /** @type {import('./summary.mjs').TestCase[]} */
    const cases = [];
    for (let i = 0; i < MAX_ROWS + 10; i++) {
      cases.push({ name: `pass ${i}`, seconds: i, result: 'passed', file: 'r.xml' });
    }
    for (let i = 0; i < 3; i++)
      cases.push({ name: `fail ${i}`, seconds: 0, result: 'failed', file: 'r.xml' });
    const rows = markdown('A', { rows: [] }, cases)
      .split('\n')
      .filter((l) => l.startsWith('| pass') || l.startsWith('| fail'));
    expect(rows).toHaveLength(MAX_ROWS);
    expect(rows.slice(0, 3).every((r) => r.startsWith('| fail'))).toBe(true);
    expect(rows[3]).toMatch(/^\| pass 59 /);
    expect(markdown('A', { rows: [] }, cases)).toContain('…and 13 faster ones');
  });

  it('says why there are no step times, or that none ran, and lists no tests without any', () => {
    expect(markdown('A', { problem: 'no job named "A"' }, [])).toBe(
      '### A: step times\n\nNo step times: no job named "A"',
    );
    expect(markdown('A', { rows: [] }, [])).toBe('### A: step times\n\nNo steps have run.');
    expect(
      markdown('A', { rows: [] }, [{ name: 't', seconds: 1, result: 'passed', file: 'x' }]),
    ).toContain('1 from 1 report, 0 failed');
  });
});

describe('reportFiles', () => {
  it('expands each pattern, sorted, each file once, blank lines ignored', () => {
    /** @type {Record<string, string[]>} */
    const tree = {
      'r/*.xml': ['r/suite.xml', 'r/19.retry.xml'],
      'r/suite.xml': ['r/suite.xml'],
    };
    expect(reportFiles('r/*.xml\n\n  r/suite.xml  \n', (p) => tree[p] ?? [])).toEqual([
      'r/19.retry.xml',
      'r/suite.xml',
    ]);
    expect(reportFiles('')).toEqual([]);
  });

  it('globs the real file system by default', () => {
    expect(reportFiles('job-summary/summary.mjs')).toEqual(['job-summary/summary.mjs']);
  });
});

describe('jobSteps', () => {
  const env = { GITHUB_REPOSITORY: 'jbhirsh/sift', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '' };
  const jobs = JSON.stringify({ jobs: [{ name: 'E2E Tests (Maestro)' }, { name: 'Build' }] });

  it("names the jobs it found when none has the name, and the API's error when it refuses", () => {
    expect(jobSteps(env, 'E2E Tests', () => jobs)).toEqual({
      problem: 'no job named "E2E Tests" in this attempt; it has "E2E Tests (Maestro)", "Build".',
    });
    expect(jobSteps(env, 'X', () => '{"jobs": []}')).toEqual({
      problem: 'no job named "X" in this attempt; it has none.',
    });
    const refused = jobSteps(env, 'X', () => {
      throw new Error('gh: Resource not accessible by integration (HTTP 403)\nmore');
    });
    expect(refused).toEqual({
      problem:
        "the run's jobs couldn't be read (gh: Resource not accessible by integration (HTTP 403)); the job needs actions: read.",
    });
    expect(
      jobSteps(env, 'X', () => {
        throw 'odd';
      }),
    ).toEqual({ problem: "the run's jobs couldn't be read (odd); the job needs actions: read." });
  });

  it('reads attempt 1 by default, and a job with no steps has no rows', () => {
    /** @type {string[][]} */
    const calls = [];
    expect(
      jobSteps(env, 'Build', (args) => {
        calls.push(args);
        return jobs;
      }),
    ).toEqual({ rows: [] });
    expect(calls).toEqual([
      ['api', 'repos/jbhirsh/sift/actions/runs/42/attempts/1/jobs?per_page=100'],
    ]);
  });
});

describe('build', () => {
  const env = {
    JOB: 'Accessibility audit',
    GITHUB_REPOSITORY: 'jbhirsh/sift',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '2',
    JUNIT: 'r/*.xml',
  };
  const jobs = JSON.stringify({
    jobs: [
      {
        name: 'Accessibility audit',
        steps: [step('Audit', 'success', '2026-10-29T10:00:00Z', '2026-10-29T10:04:22Z')],
      },
    ],
  });

  it("reads this attempt's job and its reports' tests, settling re-runs", () => {
    /** @type {Record<string, string>} */
    const files = {
      'r/a.xml': '<testcase name="T" time="2" status="ERROR"/>',
      'r/T.retry.xml': '<testcase name="T" time="3"/>',
      'r/b.xml': 'garbage',
    };
    const text = build(
      env,
      () => jobs,
      (f) => files[f],
      () => ['r/a.xml', 'r/T.retry.xml', 'r/b.xml'],
      NOW,
    );
    expect(text).toContain('| Audit | 262 | success |');
    expect(text).toContain('| T | 2 | passed on re-run | a.xml |');
    expect(text).toContain('2 from 2 reports, 0 failed, 1 passed on re-run');
  });

  it("lists no tests from a report that can't be read", () => {
    const text = build(
      env,
      () => jobs,
      () => {
        throw new Error('ENOENT');
      },
      () => ['r/gone.xml'],
    );
    expect(text).not.toContain('### Tests');
  });

  it('needs the job name', () => {
    expect(() => build({ ...env, JOB: '' }, () => jobs)).toThrow('JOB is not set');
  });
});
