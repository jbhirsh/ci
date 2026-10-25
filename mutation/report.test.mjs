import fc from 'fast-check';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allMutants,
  counts,
  inRanges,
  isRecord,
  parseReport,
  parseScope,
  readText,
  relativeName,
} from './report.mjs';

const CWD = '/home/runner/work/sift/sift';

/**
 * A mutant on lines `start` to `end`, with `status`.
 *
 * @param {number} start
 * @param {number} end
 * @param {string} [status]
 */
const at = (start, end, status = 'Killed') => ({
  status,
  location: { start: { line: start }, end: { line: end } },
});

describe('isRecord', () => {
  it('is true for plain objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });
});

describe('parseReport', () => {
  it('reads an object whose files and testFiles are objects', () => {
    expect(parseReport('{"files":{},"testFiles":{}}')).toEqual({ files: {}, testFiles: {} });
    expect(parseReport('{"schemaVersion":"1"}')).toEqual({ schemaVersion: '1' });
  });

  it('is null for anything else', () => {
    expect(parseReport(null)).toBeNull();
    expect(parseReport('{cut off')).toBeNull();
    expect(parseReport('null')).toBeNull();
    expect(parseReport('[]')).toBeNull();
    expect(parseReport('{"files":[]}')).toBeNull();
    expect(parseReport('{"testFiles":3}')).toBeNull();
  });
});

describe('readText', () => {
  it("reads a file, or null when it can't", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'report-')), 'a.txt');
    expect(readText(file)).toBeNull();
    writeFileSync(file, 'x');
    expect(readText(file)).toBe('x');
  });
});

describe('relativeName', () => {
  it("strips the working directory, a leading ./ and Windows' separators", () => {
    expect(relativeName(`${CWD}/src/a.ts`, CWD)).toBe('src/a.ts');
    expect(relativeName(`${CWD}/src/a.ts`, `${CWD}/`)).toBe('src/a.ts');
    expect(relativeName('src/a.ts', '/repo')).toBe('src/a.ts');
    expect(relativeName('./src/a.ts', CWD)).toBe('src/a.ts');
    expect(relativeName('src\\utils\\a.ts', CWD)).toBe('src/utils/a.ts');
    expect(relativeName('C:\\repo\\src\\a.ts', 'C:\\repo')).toBe('src/a.ts');
  });

  it('leaves a path outside the working directory as it is', () => {
    expect(relativeName('/elsewhere/src/a.ts', CWD)).toBe('/elsewhere/src/a.ts');
    expect(relativeName(`${CWD}-other/src/a.ts`, CWD)).toBe(`${CWD}-other/src/a.ts`);
  });

  it('reads a relative name and its absolute form alike, for any path', () => {
    const segment = fc.stringMatching(/^[\w.-]{1,8}$/).filter((s) => s !== '.' && s !== '..');
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), (parts) => {
        const name = parts.join('/');
        expect(relativeName(`${CWD}/${name}`, CWD)).toBe(relativeName(name, CWD));
      }),
    );
  });
});

describe('parseScope', () => {
  it("collects each file's ranges, a file named whole anywhere staying whole", () => {
    const scope = parseScope(
      ['src/a.ts:1-2', 'src/a.ts:7-7', 'src/b.ts', 'src/b.ts:3-4', 'src/c.ts:5-6', 'src/c.ts'],
      CWD,
    );
    expect(scope.get('src/a.ts')).toEqual([
      [1, 2],
      [7, 7],
    ]);
    expect(scope.get('src/b.ts')).toBeNull();
    expect(scope.get('src/c.ts')).toBeNull();
    expect([...scope.keys()]).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(scope.has('src/d.ts')).toBe(false);
  });

  it('skips empty entries and spaces, and names files relative to the working directory', () => {
    const scope = parseScope([` ${CWD}/src/a.ts:3-4 `, '', 'src/b.ts', ' '], CWD);
    expect([...scope.entries()]).toEqual([
      ['src/a.ts', [[3, 4]]],
      ['src/b.ts', null],
    ]);
  });

  it('is empty for an empty scope', () => {
    expect(parseScope([], CWD).size).toBe(0);
    expect(parseScope([''], CWD).size).toBe(0);
  });

  it('never throws, and names every non-blank entry, for any comma-separated input', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const entries = text.split(',');
        const scope = parseScope(entries, CWD);
        expect(scope.size).toBeLessThanOrEqual(entries.filter((e) => e.trim()).length);
        for (const ranges of scope.values()) {
          if (ranges !== null)
            for (const [first, last] of ranges)
              expect(Number.isInteger(first) && Number.isInteger(last)).toBe(true);
        }
      }),
    );
  });
});

describe('inRanges', () => {
  /** @type {Array<[number, number]>} */
  const ranges = [
    [4, 6],
    [10, 10],
  ];

  it('takes a mutant that starts and ends inside one range', () => {
    expect(inRanges(at(4, 4), ranges)).toBe(true);
    expect(inRanges(at(4, 6), ranges)).toBe(true);
    expect(inRanges(at(6, 6), ranges)).toBe(true);
    expect(inRanges(at(10, 10), ranges)).toBe(true);
  });

  it('refuses one outside, or reaching past a range, as Stryker does', () => {
    expect(inRanges(at(3, 3), ranges)).toBe(false);
    expect(inRanges(at(7, 7), ranges)).toBe(false);
    expect(inRanges(at(11, 11), ranges)).toBe(false);
    expect(inRanges(at(3, 4), ranges)).toBe(false);
    expect(inRanges(at(6, 7), ranges)).toBe(false);
    // Across both ranges, inside neither.
    expect(inRanges(at(5, 10), ranges)).toBe(false);
  });

  it('refuses a mutant with no location', () => {
    expect(inRanges({ status: 'Killed' }, ranges)).toBe(false);
    expect(inRanges({ location: { start: { line: 4 } } }, ranges)).toBe(false);
    expect(inRanges({ location: { end: { line: 4 } } }, ranges)).toBe(false);
  });

  it('takes a mutant exactly when one range holds both its ends, for any lines', () => {
    const line = fc.integer({ min: 1, max: 50 });
    fc.assert(
      fc.property(line, line, line, line, (a, b, c, d) => {
        const [start, end] = a <= b ? [a, b] : [b, a];
        const [first, last] = c <= d ? [c, d] : [d, c];
        expect(inRanges(at(start, end), [[first, last]])).toBe(start >= first && end <= last);
      }),
    );
  });
});

describe('counts', () => {
  it('counts each status and scores as Stryker does', () => {
    expect(
      counts([
        at(1, 1, 'Killed'),
        at(1, 1, 'Killed'),
        at(1, 1, 'Timeout'),
        at(1, 1, 'Survived'),
        at(1, 1, 'Ignored'),
        at(1, 1, 'NoCoverage'),
        at(1, 1, 'CompileError'),
        at(1, 1, 'RuntimeError'),
        {},
      ]),
    ).toEqual({
      killed: 2,
      timeout: 1,
      survived: 1,
      noCoverage: 1,
      errors: 2,
      ignored: 1,
      score: 60,
    });
  });

  it('has no score with nothing valid, and 0 when every valid mutant got through', () => {
    expect(counts([]).score).toBeNull();
    expect(counts([at(1, 1, 'CompileError'), at(1, 1, 'Ignored')]).score).toBeNull();
    expect(counts([at(1, 1, 'NoCoverage'), at(2, 2, 'Survived')]).score).toBe(0);
  });
});

describe('allMutants', () => {
  it("lists every file's mutants", () => {
    expect(allMutants({ files: { a: { mutants: [at(1, 1)] }, b: {} } })).toEqual([at(1, 1)]);
    expect(allMutants({})).toEqual([]);
  });
});
