import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failures, fileScores, judge, main } from './gate.mjs';
import { parseScope } from './report.mjs';

const CWD = '/home/runner/work/sift/sift';

/**
 * A mutant spanning lines `start` to `end`, with `status`.
 *
 * @param {number} start
 * @param {number} end
 * @param {string} [status]
 */
const at = (start, end, status = 'Killed') => ({
  status,
  location: { start: { line: start }, end: { line: end } },
});

const report = {
  files: {
    'src/utils/a.ts': {
      mutants: [
        at(2, 2, 'Survived'),
        at(5, 5, 'Killed'),
        at(5, 6, 'Killed'),
        at(9, 9, 'Survived'),
        at(9, 12, 'Survived'),
      ],
    },
    [`${CWD}/src/utils/b.ts`]: { mutants: [at(1, 1, 'Killed'), at(2, 2, 'Survived')] },
    'src/utils/carried.ts': { mutants: [at(1, 1, 'Survived')] },
    'src/utils/typesOnly.ts': { mutants: [at(30, 30, 'Survived')] },
    'src/utils/empty.ts': {},
  },
};

afterEach(() => vi.restoreAllMocks());

describe('fileScores', () => {
  it('scores every file whole without a scope (the sweep), lowest first', () => {
    expect(fileScores(report, null, CWD)).toEqual([
      { file: 'src/utils/carried.ts', score: 0 },
      { file: 'src/utils/typesOnly.ts', score: 0 },
      { file: 'src/utils/a.ts', score: 40 },
      { file: 'src/utils/b.ts', score: 50 },
      { file: 'src/utils/empty.ts', score: null },
    ]);
  });

  it("scores only the scope's files, each on its named lines", () => {
    const scope = parseScope(
      ['src/utils/a.ts:4-6', 'src/utils/a.ts:9-9', 'src/utils/b.ts', 'src/utils/typesOnly.ts:1-3'],
      CWD,
    );
    expect(fileScores(report, scope, CWD)).toEqual([
      // Lines 5, 5-6 killed and 9 survived; 2 and 9-12 aren't its changed lines.
      { file: 'src/utils/b.ts', score: 50 },
      { file: 'src/utils/a.ts', score: (2 / 3) * 100 },
      // Its changed lines hold no mutant: no score, not a failure.
      { file: 'src/utils/typesOnly.ts', score: null },
    ]);
  });

  it('copes with a report that has no files', () => {
    expect(fileScores({}, null, CWD)).toEqual([]);
    expect(fileScores({}, parseScope(['src/a.ts'], CWD), CWD)).toEqual([]);
  });
});

describe('failures', () => {
  it('fails only the scored files below the threshold', () => {
    expect(
      failures(
        [
          { file: 'low.ts', score: 79.99 },
          { file: 'edge.ts', score: 80 },
          { file: 'high.ts', score: 100 },
          { file: 'none.ts', score: null },
        ],
        80,
      ),
    ).toEqual([{ file: 'low.ts', score: 79.99 }]);
  });
});

describe('judge', () => {
  it('lists each file and fails those under the bar', () => {
    const { pass, lines } = judge(report, null, 30, CWD);
    expect(pass).toBe(false);
    expect(lines).toContain('  [FAIL] 0.00%  src/utils/carried.ts');
    expect(lines).toContain('  [ok] 40.00%  src/utils/a.ts');
    expect(lines).toContain('  [none] nothing scorable — src/utils/empty.ts');
    expect(lines).toContain('Mutation score below 30% for 2 file(s):');
    expect(lines).toContain('  - src/utils/carried.ts: 0.00%');
  });

  it('passes when every scored file clears it, saying where it looked', () => {
    const scope = parseScope(['src/utils/b.ts', 'src/utils/typesOnly.ts:1-3'], CWD);
    const { pass, lines } = judge(report, scope, 50, CWD);
    expect(pass).toBe(true);
    expect(lines).toContain(
      '  [none] nothing scorable in its changed lines — src/utils/typesOnly.ts',
    );
    expect(lines.at(-1)).toBe('All 1 scored file(s) >= 50% mutation score.');
  });
});

describe('main', () => {
  /**
   * @param {unknown} ci
   * @param {unknown} [mutation]
   */
  function app(ci, mutation) {
    const root = mkdtempSync(path.join(tmpdir(), 'gate-'));
    mkdirSync(path.join(root, '.github'));
    writeFileSync(path.join(root, '.github', 'ci.json'), JSON.stringify(ci));
    if (mutation !== undefined) {
      mkdirSync(path.join(root, 'reports', 'mutation'), { recursive: true });
      writeFileSync(
        path.join(root, 'reports', 'mutation', 'mutation.json'),
        JSON.stringify(mutation),
      );
    }
    return root;
  }

  it('gates nothing without a per-file threshold', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main([], app({}), {})).toBe(0);
    expect(log.mock.calls[0][0]).toMatch(/^No per-file threshold set/);
  });

  it('fails on a missing report', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main([], app({ mutation: { perFileThreshold: 80 } }), {})).toBe(1);
    expect(error.mock.calls[0][0]).toMatch(/^No readable mutation report/);
  });

  it("judges the json reporter's report on MUTATE_SCOPE's lines, adding it to the summary", () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const sum = path.join(mkdtempSync(path.join(tmpdir(), 'gate-sum-')), 'sum');
    writeFileSync(sum, '');
    vi.stubEnv('GITHUB_STEP_SUMMARY', sum);
    const root = app({ mutation: { perFileThreshold: 80 } }, report);
    expect(main([], root, { MUTATE_SCOPE: 'src/utils/a.ts:5-6' })).toBe(0);
    expect(main([], root, { MUTATE_SCOPE: 'src/utils/a.ts:4-9' })).toBe(1);
    expect(main([], root, {})).toBe(1);
    expect(readFileSync(sum, 'utf8')).toContain('### Per-file mutation scores');
    vi.unstubAllEnvs();
  });

  it('reads another report when given one', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv(
      'GITHUB_STEP_SUMMARY',
      path.join(mkdtempSync(path.join(tmpdir(), 'gate-sum-')), 'sum'),
    );
    const root = app({ mutation: { perFileThreshold: 50 } });
    writeFileSync(
      path.join(root, 'merged.json'),
      JSON.stringify({ files: { 'a.ts': { mutants: [at(1, 1)] } } }),
    );
    expect(main(['merged.json'], root, {})).toBe(0);
    vi.unstubAllEnvs();
  });
});
