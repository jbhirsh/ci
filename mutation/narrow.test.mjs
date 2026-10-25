import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main, narrow, narrowFile } from './narrow.mjs';

/**
 * A mutant on lines `start` to `end`, as Stryker's report places it.
 *
 * @param {string} id
 * @param {number} start
 * @param {number} [end]
 */
const at = (id, start, end = start) => ({
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

describe('narrow', () => {
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
    const out = narrow(lined, ['src/a.ts:4-5', 'src/a.ts:9-12'], '/repo');
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
      narrow({ files: { 'src/a.ts': {} } }, ['src/a.ts:1-2'], '/repo').files?.['src/a.ts'].mutants,
    ).toEqual([]);
  });
});

describe('narrowFile', () => {
  it('rewrites the file in place with the scope only', () => {
    const file = path.join(scratch(), 'incremental.json');
    writeFileSync(file, JSON.stringify(report));
    const log = vi.fn();
    narrowFile(file, ['src/a.ts:1-3', 'src/b.ts'], '/repo', log);
    const narrowed = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(narrowed.files)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(
      narrowed.files['src/a.ts'].mutants.map((/** @type {{ id: string }} */ m) => m.id),
    ).toEqual(['1']);
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

  it('narrows the file to the comma-separated scope', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = path.join(scratch(), 'incremental.json');
    writeFileSync(file, JSON.stringify(report));
    expect(main([file, 'src/b.ts,'], '/repo')).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).files)).toEqual(['src/b.ts']);
    log.mockRestore();
  });
});
