import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main, narrow, narrowFile, staysPut } from './narrow.ts';

/**
 * A mutant on lines `start` to `end`, as Stryker's report places it.
 */
const at = (id: string, start: number, end: number = start) => ({
  id,
  location: { start: { line: start, column: 1 }, end: { line: end, column: 5 } },
});

const report = {
  schemaVersion: '1.0',
  files: {
    'src/a.ts': { language: 'typescript', source: 'a', mutants: [at('1', 2), at('2', 9)] },
    'src/b.ts': { language: 'typescript', source: 'b', mutants: [at('3', 1)] },
    'src/c.ts': { language: 'typescript', source: 'c', mutants: [at('4', 1)] },
  },
  testFiles: { 'src/a.test.ts': { tests: [] } },
};

const scratch = () => mkdtempSync(path.join(tmpdir(), 'narrow-'));

/** Thirteen numbered lines, the source the line-range fixtures share. */
const thirteen = Array.from({ length: 13 }, (_, i) => `line ${i + 1}`).join('\n');

/**
 * A `read` answering `text` for every file.
 */
const reads = (text: string | null) => () => text;

// A sweep's static results: one only static (no covering test), one also
// covered by a test, which a run ignoring static mutants still runs.
const statics = [
  { ...at('5', 2), status: 'Survived', static: true, coveredBy: [] },
  { ...at('6', 3), status: 'Survived', static: true, coveredBy: ['0'] },
  { ...at('7', 4), status: 'Killed', coveredBy: ['0'] },
];

describe('narrow', () => {
  it('drops static results no covering test reaches when the run ignores static mutants', () => {
    const swept = {
      files: {
        'src/a.ts': { source: thirteen, mutants: statics },
        'src/b.ts': { source: thirteen, mutants: statics },
      },
    };
    const scope = ['src/a.ts', 'src/b.ts:1-13'];
    const ids = (out: ReturnType<typeof narrow>, file: string) =>
      out.files?.[file].mutants?.map((m) => m.id);
    const skips = narrow(swept, scope, '/repo', reads(thirteen), true);
    expect(ids(skips, 'src/a.ts')).toEqual(['6', '7']);
    expect(ids(skips, 'src/b.ts')).toEqual(['6', '7']);
    const tests = narrow(swept, scope, '/repo', reads(thirteen));
    expect(tests.files?.['src/a.ts']).toBe(swept.files['src/a.ts']);
    expect(ids(tests, 'src/b.ts')).toEqual(['5', '6', '7']);
  });

  it('drops the files out of scope and keeps a whole file whole, and every test file', () => {
    const out = narrow(report, ['src/a.ts', 'src/c.ts', 'src/App.tsx'], '/repo');
    expect(Object.keys(out.files ?? {})).toEqual(['src/a.ts', 'src/c.ts']);
    expect(out.files?.['src/a.ts']).toBe(report.files['src/a.ts']);
    expect(out.testFiles).toBe(report.testFiles);
    expect(out.schemaVersion).toBe('1.0');
  });

  it('matches a report that names its files by absolute path', () => {
    const abs = {
      files: { '/repo/api/graphql.ts': { mutants: [] }, '/repo/src/x.ts': { mutants: [] } },
    };
    expect(Object.keys(narrow(abs, ['api/graphql.ts'], '/repo').files ?? {})).toEqual([
      '/repo/api/graphql.ts',
    ]);
  });

  it('keeps only the mutants lying wholly on a file’s named lines', () => {
    const lined = {
      files: {
        'src/a.ts': {
          language: 'typescript',
          source: thirteen,
          mutants: [
            at('before', 3),
            at('first', 4),
            at('last', 5),
            at('spills', 5, 6),
            at('starts-before', 3, 4),
            at('second-range', 9, 12),
            at('after', 13),
            { id: 'unplaced' },
          ],
        },
      },
    };
    const out = narrow(lined, ['src/a.ts:4-5', 'src/a.ts:9-12'], '/repo', reads(thirteen));
    expect(out.files?.['src/a.ts'].mutants?.map((m) => m.id)).toEqual([
      'first',
      'last',
      'second-range',
    ]);
    expect(out.files?.['src/a.ts'].language).toBe('typescript');
  });

  it('copes with a report that has no files, or a file with no mutants', () => {
    expect(narrow({}, ['src/a.ts'], '/repo').files).toEqual({});
    expect(
      narrow({ files: { 'src/a.ts': {} } }, ['src/a.ts:1-2'], '/repo', reads('x')).files?.[
        'src/a.ts'
      ].mutants,
    ).toEqual([]);
  });

  // BoardGames#343: a doc comment added above a function moved its unchanged
  // line 83 to 90, and main's survivor there fell inside the comment's range.
  it('drops a mutant whose lines the change moved, though its old lines are in range', () => {
    const before = ['a', 'b', '<svg style={{ overflow }}>', 'c'].join('\n');
    const now = ['a', 'b', '/**', ' * why', ' */', '<svg style={{ overflow }}>', 'c'].join('\n');
    const moved = { files: { 'src/Icons.tsx': { source: before, mutants: [at('svg', 3)] } } };
    const out = narrow(moved, ['src/Icons.tsx:3-5'], '/repo', reads(now));
    expect(out.files?.['src/Icons.tsx'].mutants).toEqual([]);
  });

  // A new component like the one below it: its <svg> line reads the same as
  // the old one at the same line number, while the old one moves down, out
  // of the range.
  it('drops a mutant whose line reads the same but comes after a change', () => {
    const before = ['a', '<Icon>', '<svg style={{ overflow }}>', '</Icon>'].join('\n');
    const now = [
      'a',
      '<IconLarge>',
      '<svg style={{ overflow }}>',
      '</IconLarge>',
      '<Icon>',
      '<svg style={{ overflow }}>',
      '</Icon>',
    ].join('\n');
    const copied = { files: { 'src/Icons.tsx': { source: before, mutants: [at('svg', 3)] } } };
    const out = narrow(copied, ['src/Icons.tsx:2-4'], '/repo', reads(now));
    expect(out.files?.['src/Icons.tsx'].mutants).toEqual([]);
  });

  it('drops a mutant the diff slides down past an insertion that repeats the start', () => {
    const slid = { files: { 'src/a.ts': { source: 'x\ny', mutants: [at('x', 1)] } } };
    expect(
      narrow(slid, ['src/a.ts:1-2'], '/repo', reads('x\nx\ny')).files?.['src/a.ts'].mutants,
    ).toEqual([]);
  });

  it('keeps an in-range mutant above the first change, whatever the line endings', () => {
    const before = 'a\r\nb\r\nc';
    const kept = { files: { 'src/a.ts': { source: before, mutants: [at('b', 2), at('c', 3)] } } };
    const out = narrow(kept, ['src/a.ts:2-3'], '/repo', reads('a\nb\nC'));
    expect(out.files?.['src/a.ts'].mutants?.map((m) => m.id)).toEqual(['b']);
  });

  it('keeps no line-range mutant without a source to compare, or a file to read', () => {
    const one = (source: unknown) => ({
      files: { 'src/a.ts': { source, mutants: [at('1', 1)] } },
    });
    expect(
      narrow(one(undefined), ['src/a.ts:1-1'], '/r', reads('x')).files?.['src/a.ts'].mutants,
    ).toEqual([]);
    expect(narrow(one(42), ['src/a.ts:1-1'], '/r', reads('x')).files?.['src/a.ts'].mutants).toEqual(
      [],
    );
    expect(
      narrow(one('x'), ['src/a.ts:1-1'], '/r', reads(null)).files?.['src/a.ts'].mutants,
    ).toEqual([]);
    expect(
      narrow(one('x'), ['src/a.ts:1-1'], '/r', reads('x')).files?.['src/a.ts'].mutants,
    ).toHaveLength(1);
  });

  it('reads the file now from the app checkout by default', () => {
    const cwd = scratch();
    mkdirSync(path.join(cwd, 'src'));
    writeFileSync(path.join(cwd, 'src/a.ts'), 'x\ny');
    const one = { files: { [`${cwd}/src/a.ts`]: { source: 'x\ny', mutants: [at('1', 2)] } } };
    expect(narrow(one, ['src/a.ts:2-2'], cwd).files?.[`${cwd}/src/a.ts`].mutants).toHaveLength(1);
  });
});

describe('staysPut', () => {
  it('takes the end lines the file reads the same up to, whatever the line endings', () => {
    const stays = staysPut('a\r\nb\r\nc\r\nd', 'a\nb\nC\nd');
    expect([0, 1, 2, 3, 4].map(stays)).toEqual([false, true, true, false, false]);
    expect(staysPut('x\nb', 'a\nb')(1)).toBe(false);
    expect(staysPut('a\nb', 'a\nb\nc')(2)).toBe(true);
    expect(staysPut('a\nb\nc', 'a\nb')(2)).toBe(true);
  });

  // diff-match-patch reads x\ny -> x\nx\ny as an x\n inserted at the top,
  // moving the old line 1 to line 2.
  it('refuses a start the file now repeats further down', () => {
    const stays = staysPut('x\ny', 'x\nx\ny');
    expect(stays(1)).toBe(false);
    expect(staysPut('x\ny', 'x\nz\ny')(1)).toBe(true);
  });
});

describe('narrowFile', () => {
  it('rewrites the file in place with the scope only', () => {
    const cwd = scratch();
    mkdirSync(path.join(cwd, 'src'));
    writeFileSync(path.join(cwd, 'src/a.ts'), 'a\nb\nc');
    const file = path.join(cwd, 'incremental.json');
    const lined = {
      ...report,
      files: { ...report.files, 'src/a.ts': { ...report.files['src/a.ts'], source: 'a\nb\nc' } },
    };
    writeFileSync(file, JSON.stringify(lined));
    const log = vi.fn();
    narrowFile(file, ['src/a.ts:1-3', 'src/b.ts'], cwd, log);
    const narrowed = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(narrowed.files)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(narrowed.files['src/a.ts'].mutants.map((m: { id: string }) => m.id)).toEqual(['1']);
    expect(narrowed.testFiles).toEqual(report.testFiles);
    expect(log).toHaveBeenCalledWith(
      "Kept 2 of 3 file(s) from the incremental file for this run's scope.",
    );
  });

  it('leaves a missing file missing', () => {
    const file = path.join(scratch(), 'none.json');
    const log = vi.fn();
    narrowFile(file, ['a.ts'], '/repo', log);
    expect(existsSync(file)).toBe(false);
    expect(log.mock.calls[0][0]).toMatch(/^No incremental file/);
  });

  it('removes a file that will not parse, so Stryker runs every mutant', () => {
    const file = path.join(scratch(), 'broken.json');
    writeFileSync(file, '{"files": {');
    const log = vi.fn();
    narrowFile(file, ['a.ts'], '/repo', log);
    expect(existsSync(file)).toBe(false);
    expect(log.mock.calls[0][0]).toMatch(/^Unreadable incremental file/);
  });

  it('counts a report with no files as none kept of none', () => {
    const file = path.join(scratch(), 'empty.json');
    writeFileSync(file, '{}');
    const log = vi.fn();
    narrowFile(file, ['a.ts'], '/repo', log);
    expect(log).toHaveBeenCalledWith(
      "Kept 0 of 0 file(s) from the incremental file for this run's scope.",
    );
  });
});

describe('main', () => {
  it('needs both the file and the scope', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main([], '/repo')).toBe(2);
    expect(main(['incremental.json'], '/repo')).toBe(2);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  /**
   * An app whose Stryker config is `stryker`, with its incremental file.
   */
  function app(stryker: Record<string, unknown>, incremental: unknown) {
    const cwd = scratch();
    writeFileSync(path.join(cwd, 'stryker.config.json'), JSON.stringify(stryker));
    const file = path.join(cwd, 'incremental.json');
    writeFileSync(file, JSON.stringify(incremental));
    return { cwd, file };
  }

  it('narrows the file to the comma-separated scope', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { cwd, file } = app({ mutate: ['src/**'] }, report);
    expect(main([file, 'src/b.ts,'], cwd)).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).files)).toEqual(['src/b.ts']);
    log.mockRestore();
  });

  it("drops the sweep's static results when the Stryker config ignores static mutants", () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const swept = { files: { 'src/b.ts': { mutants: [statics[0], statics[1]] } } };
    const ids = (file: string) =>
      JSON.parse(readFileSync(file, 'utf8')).files['src/b.ts'].mutants.map(
        (m: { id: string }) => m.id,
      );
    const skips = app({ mutate: ['src/**'], ignoreStatic: true }, swept);
    expect(main([skips.file, 'src/b.ts'], skips.cwd)).toBe(0);
    expect(ids(skips.file)).toEqual(['6']);
    const tests = app({ mutate: ['src/**'] }, swept);
    expect(main([tests.file, 'src/b.ts'], tests.cwd)).toBe(0);
    expect(ids(tests.file)).toEqual(['5', '6']);
    log.mockRestore();
  });
});
