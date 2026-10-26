import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  fileWeights,
  main,
  mergeReports,
  mutantWeight,
  plan,
  reportWeights,
  shardConfig,
  shardMatrix,
  shardTable,
  splitShards,
  testKey,
  verdict,
} from './sweep.mjs';
import { allMutants, counts } from './report.mjs';
import { cleanRepos, isolateGit, repo, writeFiles } from './test-repo.mjs';

const CWD = '/home/runner/work/sift/sift';

/** @typedef {import('./report.mjs').Report} Report */

describe('mutantWeight', () => {
  it('counts one run plus each covering test', () => {
    expect(mutantWeight({ status: 'Killed', coveredBy: ['1', '2', '3'] })).toBe(4);
    expect(mutantWeight({ status: 'NoCoverage' })).toBe(1);
  });

  it('counts nothing for an ignored mutant, which never runs', () => {
    expect(mutantWeight({ status: 'Ignored', coveredBy: ['1'] })).toBe(0);
  });
});

describe('reportWeights', () => {
  it("sums each file's mutants, by cwd-relative name", () => {
    /** @type {Report} */
    const report = {
      files: {
        [`${CWD}/src/utils/a.ts`]: {
          mutants: [
            { status: 'Killed', coveredBy: ['0'] },
            { status: 'Survived' },
            { status: 'Ignored' },
          ],
        },
        'src/utils/b.ts': { mutants: [{ status: 'Ignored' }] },
        'src/utils/c.ts': {},
      },
    };
    expect(reportWeights(report, CWD)).toEqual(
      new Map([
        ['src/utils/a.ts', 3],
        ['src/utils/b.ts', 0],
        ['src/utils/c.ts', 0],
      ]),
    );
  });

  it('knows nothing from results with no files', () => {
    expect(reportWeights({}, CWD).size).toBe(0);
  });
});

describe('fileWeights', () => {
  /** @param {string} file */
  const lines = (file) => ({ 'a.ts': 100, 'b.ts': 50, 'c.ts': 30 })[file] ?? 0;

  it('weighs files by line count when nothing is known', () => {
    expect(fileWeights(['a.ts', 'b.ts'], lines, new Map())).toEqual(
      new Map([
        ['a.ts', 100],
        ['b.ts', 50],
      ]),
    );
  });

  it('takes known weights, scaling the rest by the known weight per line', () => {
    // a.ts and b.ts: 300 over 150 lines, 2 a line; c.ts has 30 lines.
    const known = new Map([
      ['a.ts', 250],
      ['b.ts', 50],
      ['gone.ts', 999],
    ]);
    expect(fileWeights(['a.ts', 'b.ts', 'c.ts'], lines, known)).toEqual(
      new Map([
        ['a.ts', 250],
        ['b.ts', 50],
        ['c.ts', 60],
      ]),
    );
  });

  it('rounds a scaled weight to a whole number', () => {
    expect(fileWeights(['b.ts', 'c.ts'], lines, new Map([['b.ts', 25]])).get('c.ts')).toBe(15);
    expect(fileWeights(['a.ts', 'c.ts'], lines, new Map([['a.ts', 33]])).get('c.ts')).toBe(10);
    expect(fileWeights(['a.ts', 'c.ts'], lines, new Map([['a.ts', 10]])).get('c.ts')).toBe(3);
  });

  it("ignores known weights of files that aren't in scope", () => {
    expect(fileWeights(['b.ts'], lines, new Map([['gone.ts', 999]]))).toEqual(
      new Map([['b.ts', 50]]),
    );
  });
});

describe('splitShards', () => {
  it('puts each file, biggest first, on the lightest shard so far', () => {
    const weights = new Map([
      ['e.ts', 1],
      ['a.ts', 9],
      ['b.ts', 7],
      ['c.ts', 4],
      ['d.ts', 3],
    ]);
    // a→1 (9), b→2 (7), c→2 (11), d→1 (12), e→2 (12).
    expect(splitShards(weights, 2)).toEqual([
      { files: ['a.ts', 'd.ts'], weight: 12 },
      { files: ['b.ts', 'c.ts', 'e.ts'], weight: 12 },
    ]);
  });

  it('breaks ties by path and by the lower shard, so the split is the same whatever the order given', () => {
    const files = ['c.ts', 'a.ts', 'd.ts', 'b.ts'];
    const forward = splitShards(new Map(files.map((f) => [f, 5])), 2);
    const backward = splitShards(new Map([...files].reverse().map((f) => [f, 5])), 2);
    expect(forward).toEqual([
      { files: ['a.ts', 'c.ts'], weight: 10 },
      { files: ['b.ts', 'd.ts'], weight: 10 },
    ]);
    expect(backward).toEqual(forward);
    expect(
      splitShards(
        new Map([
          ['z', 1],
          ['y', 1],
          ['x', 1],
        ]),
        2,
      ),
    ).toEqual([
      { files: ['x', 'z'], weight: 2 },
      { files: ['y'], weight: 1 },
    ]);
  });

  it('makes no empty shard when there are fewer files than shards', () => {
    expect(splitShards(new Map([['a.ts', 1]]), 4)).toEqual([{ files: ['a.ts'], weight: 1 }]);
    expect(splitShards(new Map(), 3)).toEqual([]);
  });

  it('keeps every file exactly once, the heaviest shard within one file of the lightest', () => {
    const weights = new Map(Array.from({ length: 40 }, (_, i) => [`f${i}.ts`, (i * 37) % 23]));
    const shards = splitShards(weights, 6);
    expect(shards).toHaveLength(6);
    expect(shards.flatMap((s) => s.files).sort()).toEqual([...weights.keys()].sort());
    const total = [...weights.values()].reduce((a, b) => a + b, 0);
    expect(shards.reduce((sum, s) => sum + s.weight, 0)).toBe(total);
    const heaviest = Math.max(...shards.map((s) => s.weight));
    const lightest = Math.min(...shards.map((s) => s.weight));
    expect(heaviest - lightest).toBeLessThanOrEqual(Math.max(...weights.values()));
  });
});

describe('plan', () => {
  const mutate = ['src/utils/**/*.ts', 'src/App.tsx', 'api/**/*.ts', '!**/*.d.ts'];
  const tracked = [
    'src/utils/a.ts',
    'src/utils/b.ts',
    'src/types.d.ts',
    'src/App.tsx',
    'README.md',
  ];
  /** @type {Record<string, number>} */
  const text = { 'src/utils/a.ts': 10, 'src/utils/b.ts': 20, 'src/App.tsx': 30 };
  /** @param {string} file */
  const lines = (file) => text[file];

  it('refuses a scope with no file in it, naming the globs', () => {
    expect(() =>
      plan({ tracked: ['README.md'], mutate, results: null, lines, count: 8, cwd: '/repo' }),
    ).toThrow('no tracked file matches the mutate globs (src/utils/**/*.ts, src/App.tsx');
  });

  it('splits the files the mutate globs select among the tracked ones, by lines without results', () => {
    const out = plan({ tracked, mutate, results: null, lines, count: 2, cwd: '/repo' });
    expect(out.fromResults).toBe(false);
    expect(out.shards).toEqual([
      { files: ['src/App.tsx'], weight: 30 },
      { files: ['src/utils/a.ts', 'src/utils/b.ts'], weight: 30 },
    ]);
  });

  it('weighs by the last results when it has some', () => {
    const results = {
      files: {
        'src/App.tsx': { mutants: [{ status: 'Killed' }] },
        'src/utils/a.ts': { mutants: Array.from({ length: 5 }, () => ({ status: 'Survived' })) },
      },
    };
    const out = plan({ tracked, mutate, results, lines, count: 2, cwd: '/repo' });
    expect(out.fromResults).toBe(true);
    // 6 over 40 known lines: b.ts's 20 lines weigh 3.
    expect(out.shards).toEqual([
      { files: ['src/utils/a.ts'], weight: 5 },
      { files: ['src/App.tsx', 'src/utils/b.ts'], weight: 4 },
    ]);
  });
});

describe('shardMatrix and shardTable', () => {
  const shards = [
    { files: ['a.ts', 'b.ts'], weight: 12 },
    { files: ['c.ts'], weight: 11 },
  ];

  it('makes one matrix entry per shard, numbered from 1, its files comma-joined', () => {
    expect(shardMatrix(shards)).toEqual({
      include: [
        { shard: 1, mutate: 'a.ts,b.ts' },
        { shard: 2, mutate: 'c.ts' },
      ],
    });
  });

  it('tabulates each shard with the unit its weights are in', () => {
    expect(shardTable(shards, true)).toBe(
      [
        '| Shard | Files | Weight (mutants plus covering tests, last results) |',
        '| --- | --- | --- |',
        '| 1 | 2 | 12 |',
        '| 2 | 1 | 11 |',
        '',
      ].join('\n'),
    );
    expect(shardTable(shards, false)).toContain('| Weight (lines) |');
  });
});

describe('shardConfig', () => {
  it('drops the break threshold and keeps the rest', () => {
    expect(
      shardConfig({ testRunner: 'jest', thresholds: { high: 80, low: 65, break: 80 } }),
    ).toEqual({
      testRunner: 'jest',
      thresholds: { high: 80, low: 65, break: null },
    });
  });

  it('works with no thresholds', () => {
    expect(shardConfig({ testRunner: 'jest' })).toEqual({
      testRunner: 'jest',
      thresholds: { break: null },
    });
  });
});

/**
 * @param {number} line
 * @param {number} [column]
 */
const at = (line, column = 1) => ({ start: { line, column } });
/**
 * @param {string} id
 * @param {string} status
 * @param {Record<string, unknown>} [extra]
 */
const mutant = (id, status, extra = {}) => ({
  id,
  status,
  mutatorName: 'X',
  location: at(1),
  ...extra,
});

const config = {
  mutate: ['src/**/*.ts', '!**/*.d.ts'],
  thresholds: { high: 80, low: 60, break: 68 },
};

// Two shards whose runs met the same three tests in different orders.
/** @type {Report} */
const shardA = {
  schemaVersion: '1.0',
  projectRoot: '/repo',
  config: { mutate: ['src/a.ts'], thresholds: { break: null }, concurrency: 3 },
  thresholds: { break: null },
  files: {
    'src/a.ts': {
      language: 'typescript',
      source: 'a',
      mutants: [
        mutant('1', 'Killed', { coveredBy: ['0', '1'], killedBy: ['1'] }),
        mutant('2', 'Survived', { coveredBy: ['0'] }),
      ],
    },
  },
  testFiles: {
    'src/__tests__/a.test.ts': {
      source: 'tests',
      tests: [
        { id: '0', name: 'reads', location: at(3) },
        { id: '1', name: 'writes', location: at(7) },
      ],
    },
    'src/__tests__/b.test.ts': { tests: [{ id: '2', name: 'b' }] },
  },
};
/** @type {Report} */
const shardB = {
  schemaVersion: '1.0',
  config: { mutate: ['src/b.ts'], thresholds: { break: null } },
  files: {
    'src/b.ts': {
      language: 'typescript',
      mutants: [
        mutant('1', 'Timeout', { coveredBy: ['0', '9'], killedBy: ['0'] }),
        mutant('2', 'NoCoverage'),
        mutant('3', 'CompileError'),
        mutant('4', 'Ignored'),
      ],
    },
  },
  testFiles: {
    'src/__tests__/b.test.ts': { tests: [{ id: '0', name: 'b' }] },
    'src/__tests__/a.test.ts': {
      source: 'tests',
      tests: [
        { id: '1', name: 'writes', location: at(7) },
        { id: '2', name: 'reads', location: at(3) },
      ],
    },
  },
};

describe('testKey', () => {
  it("is Stryker's key: relative test file, start position and name", () => {
    expect(
      testKey('/repo/src/a.test.ts', { id: '1', name: 'n', location: at(4, 2) }, '/repo'),
    ).toBe('src/a.test.ts@4:2\nn');
    expect(testKey('src/a.test.ts', { id: '1', name: 'n' }, '/repo')).toBe('src/a.test.ts@0:0\nn');
  });
});

describe('mergeReports', () => {
  const merged = mergeReports([shardA, shardB], config, '/repo');

  it("keeps every shard's files", () => {
    expect(Object.keys(merged.files ?? {})).toEqual(['src/a.ts', 'src/b.ts']);
    expect(merged.files?.['src/a.ts'].source).toBe('a');
    expect(merged.files?.['src/b.ts'].mutants?.map((m) => m.status)).toEqual([
      'Timeout',
      'NoCoverage',
      'CompileError',
      'Ignored',
    ]);
  });

  it('lists each test once, numbered across the shards', () => {
    expect(merged.testFiles?.['src/__tests__/a.test.ts']).toEqual({
      source: 'tests',
      tests: [
        { id: '0', name: 'reads', location: at(3) },
        { id: '1', name: 'writes', location: at(7) },
      ],
    });
    expect(merged.testFiles?.['src/__tests__/b.test.ts'].tests).toEqual([{ id: '2', name: 'b' }]);
  });

  it("renumbers each shard's mutants to the merged tests, dropping a test the shard doesn't list", () => {
    const [killed, survived] = merged.files?.['src/a.ts'].mutants ?? [];
    expect(killed.coveredBy).toEqual(['0', '1']);
    expect(killed.killedBy).toEqual(['1']);
    expect(survived.coveredBy).toEqual(['0']);
    expect(survived.killedBy).toBeUndefined();
    // Shard B's test "0" is b.test.ts's "b", merged as "2"; its "9" is no test.
    const [timeout, noCoverage] = merged.files?.['src/b.ts'].mutants ?? [];
    expect(timeout.coveredBy).toEqual(['2']);
    expect(timeout.killedBy).toEqual(['2']);
    expect(noCoverage.coveredBy).toBeUndefined();
  });

  it('tells apart tests of one name at different places', () => {
    /** @type {Report} */
    const other = {
      testFiles: {
        'src/__tests__/a.test.ts': { tests: [{ id: '0', name: 'reads', location: at(9) }] },
      },
    };
    const out = mergeReports([shardA, other], config, '/repo');
    expect(out.testFiles?.['src/__tests__/a.test.ts'].tests?.map((t) => t.id)).toEqual([
      '0',
      '1',
      '3',
    ]);
  });

  it("takes the first shard's report, with the config's whole scope and thresholds", () => {
    expect(merged.schemaVersion).toBe('1.0');
    expect(merged.projectRoot).toBe('/repo');
    expect(merged.thresholds).toEqual(config.thresholds);
    expect(merged.config).toEqual({
      mutate: config.mutate,
      thresholds: config.thresholds,
      concurrency: 3,
    });
  });

  it('stops when two shards mutated the same file, however it is named', () => {
    const again = { files: { '/repo/src/a.ts': { mutants: [] } } };
    expect(() => mergeReports([shardA, again], config, '/repo')).toThrow(
      "src/a.ts is in more than one shard's results",
    );
  });

  it('copes with reports missing their lists, and with none', () => {
    const out = mergeReports(
      [{ files: { 'src/c.ts': {} }, testFiles: { 't.ts': {} } }, {}],
      config,
      '/repo',
    );
    expect(out.files?.['src/c.ts'].mutants).toEqual([]);
    expect(out.testFiles?.['t.ts'].tests).toEqual([]);
    expect(mergeReports([], config, '/repo').files).toEqual({});
  });

  it('scores the merge as Stryker does', () => {
    expect(counts(allMutants(merged))).toEqual({
      killed: 1,
      timeout: 1,
      survived: 1,
      noCoverage: 1,
      errors: 1,
      ignored: 1,
      score: 50,
    });
  });
});

describe('verdict', () => {
  const c = { killed: 7, timeout: 0, survived: 3, noCoverage: 0, errors: 2, ignored: 4, score: 70 };

  it('passes a complete sweep at or above the break threshold, showing the counts', () => {
    const v = verdict({ found: 4, expected: 4, counts: c, breakAt: 70 });
    expect(v).toMatchObject({ complete: true, pass: true });
    expect(v.summary).toContain('### Mutation sweep\n');
    expect(v.summary).toContain('Shards reported: 4 of 4.');
    expect(v.summary).toContain('| 70.00% | 70 | 7 | 0 | 3 | 0 | 2 | 4 |');
  });

  it('fails one under the break threshold', () => {
    const v = verdict({ found: 4, expected: 4, counts: { ...c, score: 69.99 }, breakAt: 70 });
    expect(v.pass).toBe(false);
    expect(v.summary).toContain('under the break threshold of 70');
  });

  it('passes any score when there is no break threshold', () => {
    const v = verdict({ found: 1, expected: 1, counts: { ...c, score: 1 }, breakAt: null });
    expect(v.pass).toBe(true);
    expect(v.summary).toContain('| 1.00% | none |');
  });

  it('fails on the per-file gate, showing its lines', () => {
    const perFile = { pass: false, lines: ['  [FAIL] 10.00%  a.ts'] };
    const v = verdict({ found: 1, expected: 1, counts: c, breakAt: null, perFile });
    expect(v.pass).toBe(false);
    expect(v.summary).toContain('```\n  [FAIL] 10.00%  a.ts\n```');
    expect(
      verdict({
        found: 1,
        expected: 1,
        counts: c,
        breakAt: null,
        perFile: { pass: true, lines: [] },
      }).pass,
    ).toBe(true);
  });

  it('fails a complete sweep that tested nothing', () => {
    const v = verdict({ found: 2, expected: 2, counts: { ...c, score: null }, breakAt: 68 });
    expect(v.pass).toBe(false);
    expect(v.summary).toContain('| none | 68 |');
    expect(v.summary).toContain('No mutant was tested.');
  });

  it('fails an incomplete sweep whatever its score, saying the baseline is kept', () => {
    const v = verdict({ found: 3, expected: 4, counts: { ...c, score: 99 }, breakAt: 68 });
    expect(v).toMatchObject({ complete: false, pass: false });
    expect(v.summary).toContain('### Mutation sweep (incomplete)');
    expect(v.summary).toContain('Shards reported: 3 of 4.');
    expect(v.summary).toContain("main's baseline is left as it was");
  });
});

// The command line, in a throwaway app.
describe('main', () => {
  /** @type {() => void} */
  let restore;
  /** @type {string} */
  let out;
  beforeAll(() => {
    restore = isolateGit();
  });
  afterAll(() => restore());
  afterEach(() => {
    cleanRepos();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  /** @param {Record<string, unknown>} [mutation] */
  function app(mutation = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'sweep-out-'));
    out = path.join(dir, 'out');
    writeFileSync(out, '');
    vi.stubEnv('GITHUB_OUTPUT', out);
    vi.stubEnv('GITHUB_STEP_SUMMARY', path.join(dir, 'summary'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return repo({
      '.github/ci.json': JSON.stringify({ mutation: { sweep: { shards: 2 }, ...mutation } }),
      'stryker.config.json': JSON.stringify(config),
      'src/a.ts': 'a\nb\nc',
      'src/b.ts': 'a',
      'src/c.ts': 'a\nb',
      'src/x.d.ts': 'x',
      'README.md': 'r',
    }).root;
  }

  it('plans, writing the matrix and count for Actions', () => {
    const root = app();
    writeFiles(root, {
      'last.json': JSON.stringify({ files: { 'src/c.ts': { mutants: [{ status: 'Killed' }] } } }),
    });
    expect(main(['plan', 'last.json'], root)).toBe(0);
    const text = readFileSync(out, 'utf8');
    // c.ts is 1 over its 2 lines: a.ts (3 lines) weighs 2, b.ts 1.
    expect(text).toContain(
      '\n{"include":[{"shard":1,"mutate":"src/a.ts"},{"shard":2,"mutate":"src/b.ts,src/c.ts"}]}\n',
    );
    expect(text).toMatch(/count<<(\w+)\n2\n\1/);
    expect(main(['plan'], root)).toBe(0);
    expect(main(['plan', 'missing.json'], root)).toBe(0);
  });

  it('writes the shard config', () => {
    const root = app();
    expect(main(['config', 'reports/shard.json'], root)).toBe(0);
    const written = JSON.parse(readFileSync(path.join(root, 'reports/shard.json'), 'utf8'));
    expect(written).toEqual({ ...config, thresholds: { ...config.thresholds, break: null } });
  });

  /**
   * @param {string} root
   * @param {Record<string, unknown>} shards
   */
  const shardDir = (root, shards) => {
    for (const [name, report] of Object.entries(shards)) {
      writeFiles(root, {
        [`shards/${name}/stryker-incremental.json`]:
          typeof report === 'string' ? report : JSON.stringify(report),
      });
    }
    writeFiles(root, { 'shards/stray-file': '' });
  };

  it('merges the shard artifacts, writing a complete sweep even under the threshold', () => {
    const root = app();
    shardDir(root, { 'stryker-sweep-results-1': shardA, 'stryker-sweep-results-2': shardB });
    // 2 of 4 detected: 50%, under 68, but complete, so written.
    expect(main(['merge', 'shards', '2', 'merged.json'], root)).toBe(1);
    expect(
      Object.keys(JSON.parse(readFileSync(path.join(root, 'merged.json'), 'utf8')).files),
    ).toEqual(['src/a.ts', 'src/b.ts']);
    expect(readFileSync(out, 'utf8')).toMatch(/complete<<(\w+)\ntrue\n\1/);
  });

  it('passes a complete sweep over the threshold and the per-file gate', () => {
    const root = app({ perFileThreshold: 50 });
    const good = {
      files: { 'src/a.ts': { mutants: [mutant('1', 'Killed'), mutant('2', 'Killed')] } },
    };
    const fine = {
      files: { 'src/b.ts': { mutants: [mutant('1', 'Killed'), mutant('2', 'Survived')] } },
    };
    shardDir(root, { 'shard-1': good, 'shard-2': fine });
    // 3 of 4: 75%, over 68; b.ts at 50% clears 50.
    expect(main(['merge', 'shards', '2', 'merged.json'], root)).toBe(0);
  });

  it('writes nothing and fails when a shard is missing or unreadable', () => {
    const root = app();
    shardDir(root, { 'shard-1': shardA, 'shard-2': '{cut off', 'shard-3': 'null' });
    expect(main(['merge', 'shards', '4', 'merged.json'], root)).toBe(1);
    expect(existsSync(path.join(root, 'merged.json'))).toBe(false);
    expect(readFileSync(out, 'utf8')).toMatch(/complete<<(\w+)\nfalse\n\1/);
    expect(console.error).toHaveBeenCalledWith('No readable results from shard-2.');
    expect(main(['merge', 'missing', '1', 'merged.json'], root)).toBe(1);
  });

  it.each([
    [[]],
    [['merge']],
    [['merge', 'shards', '0', 'o.json']],
    [['merge', 'shards', 'x', 'o.json']],
    [['config']],
    [['nope']],
  ])('refuses %j with the usage', (args) => {
    const root = app();
    expect(main(args, root)).toBe(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^Usage:/));
  });
});
