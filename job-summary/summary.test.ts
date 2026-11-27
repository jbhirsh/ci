import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  HISTORY,
  build,
  main,
  parseLoad,
  parseNotes,
  readTests,
  record,
  reportFiles,
} from './summary.ts';
import { template } from './report.ts';
import type { Io } from './summary.ts';
import type { Gh } from './history.ts';
import type { Git } from './source.ts';
import type { Model } from './model.ts';

const T0 = Date.parse('2026-10-29T10:00:00Z');
/** @param s seconds after T0 */
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const env = {
  JOB: 'Accessibility audit',
  GITHUB_REPOSITORY: 'jbhirsh/sift',
  GITHUB_RUN_ID: '42',
  GITHUB_RUN_ATTEMPT: '2',
  JUNIT: 'r/*.xml',
};

const thisRun = {
  id: 42,
  run_number: 42,
  html_url: 'https://gh/run/42',
  head_branch: 'feat',
  head_sha: 'abcdef123',
  created_at: at(0),
  workflow_id: 7,
};

/**
 * A fake gh: this run, its jobs, and no earlier runs unless given.
 */
const fakeGh =
  (more: Record<string, unknown> = {}): Gh =>
  (args) => {
    const answers: Record<string, unknown> = {
      'repos/jbhirsh/sift/actions/runs/42/attempts/2/jobs?per_page=100': {
        jobs: [
          {
            name: 'Accessibility audit',
            conclusion: null,
            started_at: at(0),
            completed_at: null,
            steps: [
              {
                name: 'Audit',
                conclusion: 'success',
                started_at: at(0),
                completed_at: at(262),
              },
            ],
          },
        ],
      },
      'repos/jbhirsh/sift/actions/runs/42': thisRun,
      'repos/jbhirsh/sift': { default_branch: 'main' },
      ...more,
    };
    if (!(args[1] in answers)) throw new Error(`HTTP 404: ${args[1]}`);
    return JSON.stringify(answers[args[1]]);
  };

const files: Record<string, string> = {
  'r/a.xml': '<testcase name="T" time="2" status="ERROR"/><testcase name="U" time="5"/>',
  'r/T.retry.xml': '<testcase name="T" time="3"/>',
  'r/b.xml': 'garbage',
  'notes.json': '{"Simulator": "iPhone 17 Pro"}',
  'load.csv': `time,load,busy\n${T0 / 1000 + 10},300,95\n${T0 / 1000 + 20},40,bad\n${T0 / 1000 + 30},40,20`,
  'a/x.test.mjs':
    "describe('x', () => {\n  it('reads it', () => {\n    expect(1).toBe(2);\n  });\n});",
};
const git: Git = (args) => {
  if (args[0] === 'ls-files') return 'a/x.test.mjs\n';
  if (args[0] === 'diff') return '';
  return '';
};
const io = {
  git,
  page: '<script>const data = /* __REPORT_DATA__ */ null;</script>',
  read: (f: string) => {
    if (!(f in files)) throw new Error('ENOENT');
    return files[f];
  },
  glob: () => ['r/a.xml', 'r/T.retry.xml', 'r/b.xml'],
  now: T0 + 300_000,
};

describe('reportFiles', () => {
  it('expands each pattern, sorted, each file once, blank lines ignored', () => {
    const tree: Record<string, string[]> = {
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
    expect(reportFiles('job-summary/summary.ts')).toEqual(['job-summary/summary.ts']);
  });
});

describe('readTests', () => {
  it("reads one row per test, re-runs settled, and none from a report it can't read", () => {
    expect(readTests('r/*.xml', io.read, () => ['r/a.xml', 'r/T.retry.xml', 'r/gone.xml'])).toEqual(
      [
        {
          name: 'T',
          seconds: 2,
          result: 'passed on re-run',
          file: 'r/a.xml',
          message: '',
          detail: '',
          suite: '',
          source: '',
        },
        {
          name: 'U',
          seconds: 5,
          result: 'passed',
          file: 'r/a.xml',
          message: '',
          detail: '',
          suite: '',
          source: '',
        },
      ],
    );
  });

  it('is null when no reports were asked for', () => {
    expect(readTests('  \n', io.read)).toBeNull();
  });
});

describe('record', () => {
  it("keeps each test's name, time and result", () => {
    expect(
      JSON.parse(
        record(
          'A',
          [
            {
              name: 'T',
              seconds: 2,
              result: 'failed',
              file: 'r.xml',
              message: 'm',
              detail: 'm',
              suite: '',
              source: '',
            },
          ],
          90,
        ),
      ),
    ).toEqual({
      version: 2,
      job: 'A',
      seconds: 90,
      tests: [{ name: 'T', seconds: 2, result: 'failed' }],
    });
  });
});

/**
 * The model a built report carries.
 */
const modelOf = (page: string | null): Model => {
  const m = (page ?? '').match(/const data = (.*);<\/script>/s);
  return JSON.parse((m?.[1] ?? 'null').replace(/\\u003c/g, '<'));
};

describe('parseNotes', () => {
  it('reads an object or a list of pairs, and says when it is not JSON', () => {
    expect(parseNotes('{"Simulator": "iPhone 17 Pro", "Waited": 160}')).toEqual([
      ['Simulator', 'iPhone 17 Pro'],
      ['Waited', '160'],
    ]);
    expect(parseNotes('[["a", "b"], ["odd"], 3]')).toEqual([['a', 'b']]);
    expect(parseNotes('7')).toEqual([]);
    expect(parseNotes('| a | b |')).toEqual([['Notes', "couldn't be read: not JSON"]]);
  });
});

describe('parseLoad', () => {
  it("reads time, load and busy rows into times from the job's start, leaving out the rest", () => {
    expect(parseLoad(files['load.csv'], T0 + 5000, 300)).toEqual([
      { t: 5, load: 300, busy: 95 },
      { t: 25, load: 40, busy: 20 },
    ]);
    expect(parseLoad(`${T0 / 1000},1,150\n${T0 / 1000 - 9},1,-5`, T0, 300)).toEqual([
      { t: 0, load: 1, busy: 100 },
      { t: 0, load: 1, busy: 0 },
    ]);
  });

  it('leaves out samples from outside the job, such as times in milliseconds', () => {
    expect(
      parseLoad(`${T0},50,50\n${T0 / 1000 - 600},1,1\n${T0 / 1000 + 400},2,2`, T0, 300),
    ).toEqual([]);
  });
});

describe('build', () => {
  it("summarizes this attempt's job, records its tests, and writes its report", () => {
    const built = build(
      {
        ...env,
        NOUN: 'check',
        NOTES: 'notes.json',
        LOAD: 'load.csv',
        SETTLE: '80',
        GITHUB_WORKFLOW: 'CI',
      },
      fakeGh(),
      io,
    );
    expect(built.markdown.split('\n')[0]).toBe(
      '### Accessibility audit: ✅ 2 checks passed, 1 on re-run · 5m 00s',
    );
    expect(built.markdown).toContain(
      '**[Full report](https://jbhirsh.github.io/sift/runs/42/accessibility-audit/)**',
    );
    expect(JSON.parse(built.record ?? '').tests).toEqual([
      { name: 'T', seconds: 2, result: 'passed on re-run' },
      { name: 'U', seconds: 5, result: 'passed' },
    ]);
    const model = modelOf(built.report);
    expect(model).toMatchObject({
      job: 'Accessibility audit',
      workflow: 'CI',
      noun: 'check',
      notes: [['Simulator', 'iPhone 17 Pro']],
      settle: 80,
    });
    expect(model.load).toEqual([
      { t: 10, load: 300, busy: 95 },
      { t: 30, load: 40, busy: 20 },
    ]);
    expect(model.steps).toEqual([
      {
        i: 1,
        name: 'Audit',
        start: 0,
        seconds: 262,
        conclusion: 'success',
        usual: null,
        slower: false,
        past: [],
      },
    ]);
  });

  it('links a report base it is given, and leaves out notes and samples it was not', () => {
    const built = build({ ...env, REPORT_BASE: 'https://ci.example/sift/' }, fakeGh(), io);
    expect(built.markdown).toContain('(https://ci.example/sift/runs/42/accessibility-audit/)');
    expect(modelOf(built.report)).toMatchObject({ notes: [], load: [], settle: null });
  });

  it("finds each test's file, and a snippet of the ones worth reading", () => {
    const more: Record<string, string> = {
      ...files,
      'v.xml':
        '<testcase classname="a/x.test.mjs" name="x &gt; reads it" time="0.2"><failure message="expected 1 to be 2">AssertionError: expected 1 to be 2\n ❯ a/x.test.mjs:3:15</failure></testcase><testcase classname="a/x.test.mjs" name="x &gt; other" time="0.1"/>',
    };
    const built = build({ ...env, JUNIT: 'v.xml' }, fakeGh(), {
      ...io,
      read: (f) => more[f] ?? '',
      glob: () => ['v.xml'],
    });
    const tests = modelOf(built.report).tests ?? [];
    expect(tests.map((t) => [t.title, t.path, t.line, t.code])).toEqual([
      [
        'reads it',
        'a/x.test.mjs',
        2,
        [
          [2, "  it('reads it', () => {", false],
          [3, '    expect(1).toBe(2);', true],
          [4, '  });', false],
        ],
      ],
      ['other', 'a/x.test.mjs', 1, null],
    ]);
    expect(built.markdown).toContain(
      '- **Failed:** reads it (a/x.test.mjs › x) after 200ms: AssertionError: expected 1 to be 2',
    );
  });

  it('compares with earlier runs, reading their records and asking git what changed', () => {
    const runs = 'repos/jbhirsh/sift/actions/workflows/7/runs?';
    const earlier = {
      ...thisRun,
      id: 41,
      run_number: 41,
      html_url: 'https://gh/run/41',
      head_sha: 'old1',
      created_at: at(-3600),
    };
    const created = encodeURIComponent(`<${thisRun.created_at}`);
    const gh = fakeGh({
      [`${runs}branch=feat&status=completed&created=${created}&per_page=${HISTORY}`]: {
        workflow_runs: [earlier],
      },
      'repos/jbhirsh/sift/actions/runs/41/jobs?per_page=100': {
        jobs: [
          {
            name: 'Accessibility audit',
            conclusion: 'success',
            started_at: at(0),
            completed_at: at(100),
            html_url: 'https://gh/job/41',
          },
        ],
      },
    });
    const asked: [number, string][] = [];
    const gitCalls: string[][] = [];
    const built = build(env, gh, {
      ...io,
      git: (args) => {
        gitCalls.push(args);
        return git(args);
      },
      download: (id, artifact) => {
        asked.push([id, artifact]);
        return '{"tests":[{"name":"U","seconds":5,"result":"passed"}]}';
      },
    });
    expect(asked).toEqual([[41, 'job-summary-accessibility-audit']]);
    expect(gitCalls).toContainEqual(['diff', '--name-only', 'old1', 'abcdef123']);
    expect(modelOf(built.report).runs).toEqual([
      {
        number: 41,
        url: 'https://jbhirsh.github.io/sift/runs/41/accessibility-audit/',
        sha: 'old1',
        branch: 'feat',
        when: at(-3600),
        seconds: 100,
        conclusion: 'success',
      },
    ]);
  });

  it("says why there's no history when the job isn't found or the API refuses", () => {
    const missing = build({ ...env, JOB: 'Audit' }, fakeGh(), io);
    expect(missing.markdown).toContain(
      'No step times or history: no job named "Audit" in this attempt; it has "Accessibility audit".',
    );
    expect(missing.report).toBeNull();
    const refused = build(
      env,
      () => {
        throw new Error('HTTP 403');
      },
      io,
    ).markdown;
    expect(refused).toContain("the run's jobs couldn't be read (HTTP 403)");
    const none = build(
      { ...env, JOB: 'X' },
      (args) => JSON.stringify(args[1].includes('attempts') ? { jobs: [] } : thisRun),
      io,
    ).markdown;
    expect(none).toContain('it has none.');
  });

  it("records the job's time without reports, and says when the notes can't be read", () => {
    const built = build({ ...env, JUNIT: '', NOTES: 'gone.json' }, fakeGh(), io);
    expect(JSON.parse(built.record ?? '')).toEqual({
      version: 2,
      job: 'Accessibility audit',
      seconds: 300,
      tests: null,
    });
    expect(modelOf(built.report).notes).toEqual([['Notes', "gone.json couldn't be read"]]);
    expect(build({ ...env, JUNIT: '', JOB: 'Nope' }, fakeGh(), io).record).toBeNull();
  });

  it('reads the notes and samples job-summary/note and sample-load left, without the inputs', () => {
    const left = path.join('/rt', 'job-summary');
    const withLeft = {
      ...io,
      read: (f: string) => {
        if (f === path.join(left, 'notes.json')) return '{"Cores": "4"}';
        if (f === path.join(left, 'machine-cpu.csv')) return files['load.csv'];
        return io.read(f);
      },
    };
    const model = modelOf(build({ ...env, RUNNER_TEMP: '/rt' }, fakeGh(), withLeft).report);
    expect(model.notes).toEqual([['Cores', '4']]);
    expect(model.load).toHaveLength(2);
    // The inputs win, and a file that isn't there is no note.
    const given = modelOf(
      build({ ...env, RUNNER_TEMP: '/rt', NOTES: 'notes.json' }, fakeGh(), withLeft).report,
    );
    expect(given.notes).toEqual([['Simulator', 'iPhone 17 Pro']]);
    const none = modelOf(build({ ...env, RUNNER_TEMP: '/elsewhere' }, fakeGh(), withLeft).report);
    expect(none).toMatchObject({ notes: [], load: [] });
  });

  it('needs the job name', () => {
    expect(() => build({ ...env, JOB: '' }, fakeGh())).toThrow('JOB is not set');
  });
});

describe('main', () => {
  it('writes the summary, puts the record and report in one folder, and names it in the outputs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'job-summary-test-'));
    vi.stubEnv('GITHUB_STEP_SUMMARY', path.join(dir, 'summary.md'));
    vi.stubEnv('GITHUB_OUTPUT', path.join(dir, 'output'));
    try {
      main({ ...env, RUNNER_TEMP: dir }, fakeGh(), io);
      expect(readFileSync(path.join(dir, 'summary.md'), 'utf8')).toContain(
        '### Accessibility audit',
      );
      const folder = path.join(dir, 'job-summary', 'job-summary-accessibility-audit');
      expect(JSON.parse(readFileSync(path.join(folder, 'record.json'), 'utf8')).tests).toHaveLength(
        2,
      );
      expect(readFileSync(path.join(folder, 'report.html'), 'utf8')).toContain(
        '"job":"Accessibility audit"',
      );
      const output = readFileSync(path.join(dir, 'output'), 'utf8');
      expect(output).toContain('dir<<');
      expect(output).toContain(folder);
      expect(output).toContain('job-summary-accessibility-audit');
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the job's comment section beside its report", () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'job-summary-test-'));
    vi.stubEnv('GITHUB_STEP_SUMMARY', path.join(dir, 'summary.md'));
    vi.stubEnv('GITHUB_OUTPUT', path.join(dir, 'output'));
    try {
      main({ ...env, RUNNER_TEMP: dir }, fakeGh(), io);
      const folder = path.join(dir, 'job-summary', 'job-summary-accessibility-audit');
      expect(readFileSync(path.join(folder, 'section.md'), 'utf8')).toBe(
        '**Accessibility audit:** ✅ 2 tests passed, 1 on re-run · 5m 00s · [Full report](https://jbhirsh.github.io/sift/runs/42/accessibility-audit/)\n- **Passed on re-run:** T\n- **Flaky:** T, failed 1 of its last 1 runs',
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns instead of failing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    main({}, fakeGh(), io);
    main({ JOB: 'X', JUNIT: 'x' }, fakeGh(), {
      ...io,
      read: () => {
        throw 'odd';
      },
      glob: () => {
        throw 'odder';
      },
    });
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      '::warning::job-summary: JOB is not set',
      '::warning::job-summary: odder',
    ]);
    log.mockRestore();
  });
});

/**
 * A built report's page as it's drawn, in jsdom: the page's own elements,
 * with dates written alike in any time zone.
 */
function drawn(page: string | null) {
  const { JSDOM }: { JSDOM: new (html: string, options: object) => { window: Window } } =
    createRequire(import.meta.url)('jsdom');
  const { window } = new JSDOM(page ?? '', {
    runScripts: 'dangerously',
    beforeParse(w: Window & typeof globalThis) {
      w.matchMedia = (() => ({ matches: false })) as unknown as Window['matchMedia'];
      w.Date.prototype.toLocaleString = function (this: Date) {
        return this.toISOString();
      };
    },
  });
  // The measurements' card, hidden without them, isn't part of today's
  // page: it goes, with the space before it.
  const card = window.document.getElementById('measures-card');
  if (card?.previousSibling?.nodeType === 3) card.previousSibling.remove();
  card?.remove();
  return `${window.document.querySelector('.page')?.outerHTML}\n`;
}

describe('without measurements', () => {
  // Today's jobs, built as they were before the measurements input: their
  // summary, comment section, record and drawn report, byte for byte. The
  // snapshots were written by the code before it, so a change that reaches
  // a job without the input fails here.
  const scenarios: [string, Record<string, string>, Gh, Io][] = [
    [
      'notes-load',
      { ...env, NOUN: 'check', NOTES: 'notes.json', LOAD: 'load.csv', SETTLE: '80' },
      fakeGh(),
      io,
    ],
    ['no-reports', { ...env, JUNIT: '' }, fakeGh(), io],
    [
      'earlier-run',
      env,
      fakeGh({
        [`repos/jbhirsh/sift/actions/workflows/7/runs?branch=feat&status=completed&created=${encodeURIComponent(`<${thisRun.created_at}`)}&per_page=${HISTORY}`]:
          {
            workflow_runs: [
              { ...thisRun, id: 41, run_number: 41, head_sha: 'old1', created_at: at(-3600) },
            ],
          },
        'repos/jbhirsh/sift/actions/runs/41/jobs?per_page=100': {
          jobs: [
            {
              name: 'Accessibility audit',
              conclusion: 'success',
              started_at: at(0),
              completed_at: at(100),
              steps: [
                { name: 'Audit', conclusion: 'success', started_at: at(0), completed_at: at(90) },
              ],
            },
          ],
        },
      }),
      {
        ...io,
        download: () => '{"seconds":95,"tests":[{"name":"U","seconds":1,"result":"passed"}]}',
      },
    ],
  ];
  for (const [name, given, gh, options] of scenarios) {
    it(`builds ${name} as it did`, async () => {
      const built = build({ ...given, GITHUB_WORKFLOW: 'CI' }, gh, {
        ...options,
        page: template(),
      });
      const dir = `./__snapshots__/unchanged/${name}`;
      await expect(built.markdown).toMatchFileSnapshot(`${dir}/summary.md`);
      await expect(built.section).toMatchFileSnapshot(`${dir}/section.md`);
      await expect(built.record).toMatchFileSnapshot(`${dir}/record.json`);
      await expect(drawn(built.report)).toMatchFileSnapshot(`${dir}/report.html`);
      // The page's data: as it was, with measurements null.
      const json = (built.report ?? '').match(/const data = (.*);\n/)?.[1] ?? 'null';
      const { measurements, ...data } = JSON.parse(json.replace(/\\u003c/g, '<'));
      expect(measurements ?? null).toBeNull();
      await expect(`${JSON.stringify(data, null, 2)}\n`).toMatchFileSnapshot(`${dir}/model.json`);
    });
  }
});

describe('with measurements', () => {
  const probe = {
    version: 1,
    driver: 'web',
    target: 'https://x.vercel.app',
    environment: 'preview',
    measurements: [
      { name: 'games', phase: 'total', start: 'cold', ms: 3400 },
      { name: 'games', phase: 'browser', start: 'cold', ms: 3620, responseStartMs: 3610 },
      { name: 'games', phase: 'total', start: 'warm', ms: 34 },
      { name: 'games', phase: 'browser', start: 'warm', ms: 410, responseStartMs: 300 },
    ],
    notes: ['cold carried by: games'],
  };
  const earlier = [41, 40, 39].map((n, k) => ({
    ...thisRun,
    id: n,
    run_number: n,
    head_branch: 'main',
    created_at: at(-3600 * (k + 1)),
  }));
  const gh = fakeGh({
    [`repos/jbhirsh/sift/actions/workflows/7/runs?branch=main&event=deployment_status&status=completed&created=${encodeURIComponent(`<${thisRun.created_at}`)}&per_page=${HISTORY}`]:
      { workflow_runs: earlier },
    ...Object.fromEntries(
      earlier.map((r) => [
        `repos/jbhirsh/sift/actions/runs/${r.id}/jobs?per_page=100`,
        { jobs: [{ name: 'Accessibility audit', conclusion: 'success', completed_at: at(10) }] },
      ]),
    ),
  });
  const browser = { 41: 230, 40: 240, 39: 220 } as Record<number, number>;
  const options: Io = {
    ...io,
    read: (f) => (f === 'probe.json' ? JSON.stringify(probe) : (io.read?.(f) ?? '')),
    download: (id) =>
      JSON.stringify({
        version: 3,
        seconds: 60,
        tests: null,
        measurements: {
          environment: 'production',
          values: [{ name: 'games', phase: 'browser', start: 'warm', ms: browser[id] }],
        },
      }),
  };
  const given = { ...env, MEASUREMENTS: 'probe.json', GITHUB_EVENT_NAME: 'deployment_status' };
  const line = 'games › browser, warm: 410ms, usually 230ms (+78%)';

  it("records each value, version 3, and compares it with main's runs of this event", () => {
    const built = build(given, gh, options);
    expect(JSON.parse(built.record ?? '')).toMatchObject({
      version: 3,
      measurements: {
        environment: 'preview',
        values: [
          { name: 'games', phase: 'total', start: 'cold', ms: 3400 },
          { name: 'games', phase: 'browser', start: 'cold', ms: 3620 },
          { name: 'games', phase: 'total', start: 'warm', ms: 34 },
          { name: 'games', phase: 'browser', start: 'warm', ms: 410 },
        ],
      },
    });
    expect(built.markdown).toContain(`- **Slower than usual:** ${line}`);
    expect(built.section).toContain(`- **Slower than usual:** ${line}`);
    const measurements = modelOf(built.report).measurements;
    expect(measurements).toMatchObject({
      environment: 'preview',
      usualEnvironment: 'production',
      notes: ['cold carried by: games'],
    });
    expect(measurements?.runs.map((r) => r.number)).toEqual([39, 40, 41]);
    expect(measurements?.rows.filter((r) => r.slower).map((r) => [r.key, r.start])).toEqual([
      ['browser', 'warm'],
    ]);
  });

  it('draws the card, and leaves it out of a job without them', () => {
    const page = (e: Record<string, string>) =>
      build(e, gh, { ...options, page: template() }).report ?? '';
    const shown = (html: string) => {
      const { JSDOM }: { JSDOM: new (html: string, o: object) => { window: Window } } =
        createRequire(import.meta.url)('jsdom');
      const { document } = new JSDOM(html, {
        runScripts: 'dangerously',
        beforeParse(w: Window) {
          w.matchMedia = (() => ({ matches: false })) as unknown as Window['matchMedia'];
        },
      }).window;
      return !document.getElementById('measures-card')?.hidden;
    };
    expect(shown(page(given))).toBe(true);
    expect(shown(page(env))).toBe(false);
  });

  it("says when the results file couldn't be read, and records no measurements", () => {
    const built = build({ ...given, MEASUREMENTS: 'gone.json' }, gh, options);
    expect(JSON.parse(built.record ?? '')).toEqual({
      version: 2,
      job: 'Accessibility audit',
      seconds: 300,
      tests: [
        { name: 'T', seconds: 2, result: 'passed on re-run' },
        { name: 'U', seconds: 5, result: 'passed' },
      ],
    });
    expect(modelOf(built.report).measurements?.notes).toEqual([
      "gone.json couldn't be read: not there.",
    ]);
    const bad = build({ ...given, MEASUREMENTS: 'r/b.xml' }, gh, options);
    expect(modelOf(bad.report).measurements?.notes).toEqual([
      "r/b.xml couldn't be read: not JSON.",
    ]);
    // Any other reason, as it is.
    const folder = build({ ...given, MEASUREMENTS: 'job-summary' }, gh, {
      ...options,
      read: (f) => readFileSync(f, 'utf8'),
    });
    expect(modelOf(folder.report).measurements?.notes?.[0]).toMatch(
      /^job-summary couldn't be read: EISDIR: /,
    );
  });
});
