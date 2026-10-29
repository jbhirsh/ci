import { describe, expect, it } from 'vitest';
import {
  SNIPPET_LINES,
  changedFiles,
  failureLine,
  locate,
  snippet,
  testLine,
  testPath,
  trackedFiles,
} from './source.mjs';

const FILES = [
  'job-summary/render.test.mjs',
  'e2e/home.spec.ts',
  'e2e/phone/home.spec.ts',
  '.maestro/19_swipe.yaml',
];

describe('trackedFiles', () => {
  it("lists git's files, or none outside a checkout", () => {
    expect(trackedFiles(() => 'a.mjs\nb/c.mjs\n')).toEqual(['a.mjs', 'b/c.mjs']);
    expect(
      trackedFiles(() => {
        throw new Error('not a git repository');
      }),
    ).toEqual([]);
  });
});

describe('testPath', () => {
  it("finds a test's file from its file attribute or suite, exactly or by its ending", () => {
    expect(testPath({ source: './.maestro/19_swipe.yaml', suite: 'Swipe' }, FILES)).toBe(
      '.maestro/19_swipe.yaml',
    );
    expect(testPath({ source: '', suite: 'job-summary/render.test.mjs' }, FILES)).toBe(
      'job-summary/render.test.mjs',
    );
    expect(testPath({ source: '', suite: 'phone/home.spec.ts' }, FILES)).toBe(
      'e2e/phone/home.spec.ts',
    );
  });

  it('gives nothing for a name that matches no file, or more than one', () => {
    expect(testPath({ source: '', suite: 'home.spec.ts' }, FILES)).toBe('');
    expect(testPath({ source: '', suite: 'gone.test.mjs' }, FILES)).toBe('');
    expect(testPath({ source: '', suite: '' }, FILES)).toBe('');
  });
});

describe('testLine', () => {
  it("finds the title as a string in any quotes, or the file's first line", () => {
    const lines = [
      "describe('x', () => {",
      '  it("reads it", () => {',
      '  test(`keeps it`, () => {});',
    ];
    expect(testLine(lines, 'reads it')).toBe(2);
    expect(testLine(lines, 'keeps it')).toBe(3);
    expect(testLine(lines, 'not here')).toBe(1);
    expect(testLine(lines, '')).toBe(1);
  });
});

describe('failureLine', () => {
  it("reads the line a failure's stack points at in the test's file", () => {
    expect(
      failureLine(
        'AssertionError\n ❯ job-summary/render.test.mjs:142:18',
        'job-summary/render.test.mjs',
      ),
    ).toBe(142);
    expect(failureLine('at Object.<anonymous> (a.b.test.mjs:9:1)', 'x/a.b.test.mjs')).toBe(9);
    expect(failureLine('at other.test.mjs:3:1', 'x/render.test.mjs')).toBe(0);
    expect(failureLine('anything', '')).toBe(0);
  });
});

describe('snippet', () => {
  const lines = [
    "describe('a', () => {",
    "  it('one', () => {",
    '    const x = 1;',
    '    expect(x).toBe(2);',
    '  });',
    "  it('two', () => {});",
    '});',
  ];

  it('takes a test from its first line to the line that closes it, marking the failure', () => {
    expect(snippet(lines, 2, 4)).toEqual([
      [2, "  it('one', () => {", false],
      [3, '    const x = 1;', false],
      [4, '    expect(x).toBe(2);', true],
      [5, '  });', false],
    ]);
  });

  it('starts near the failure when it is far from the first line, and stops at the cap', () => {
    const long = Array.from({ length: 60 }, (_, i) => `    line ${i + 1}`);
    const cut = snippet(long, 1, 40);
    expect(cut[0][0]).toBe(32);
    expect(cut).toHaveLength(SNIPPET_LINES);
    expect(cut.find((l) => l[2])?.[0]).toBe(40);
  });

  it('is empty for a file it could not read', () => {
    expect(snippet([], 1, 0)).toEqual([]);
  });
});

describe('locate', () => {
  /** @type {Record<string, string>} */
  const files = {
    'job-summary/render.test.mjs':
      "describe('r', () => {\n  it('draws', () => {\n    expect(1).toBe(2);\n  });\n});",
    '.maestro/19_swipe.yaml': 'appId: x\n---\n- launchApp',
  };
  /**
   * @param {Partial<import('./junit.mjs').TestCase> & { name: string, title: string }} t
   * @returns {import('./junit.mjs').TestCase & { title: string }}
   */
  const tc = (t) => ({
    seconds: 1,
    result: 'passed',
    file: 'r.xml',
    message: '',
    detail: '',
    suite: '',
    source: '',
    ...t,
  });

  it("finds each test's file and line, and a snippet only for the ones wanted", () => {
    const found = locate(
      [
        tc({
          name: 'r › draws',
          title: 'draws',
          suite: 'job-summary/render.test.mjs',
          detail: 'x\n ❯ job-summary/render.test.mjs:3:5',
        }),
        tc({ name: 'Swipe', title: 'Swipe', source: '.maestro/19_swipe.yaml' }),
        tc({ name: 'gone', title: 'gone', suite: 'gone.test.mjs' }),
      ],
      new Set(['r › draws', 'Swipe']),
      [...Object.keys(files), 'gone.txt'],
      (p) => {
        if (!(p in files)) throw new Error('ENOENT');
        return files[p];
      },
    );
    expect(found.get('r › draws')).toEqual({
      path: 'job-summary/render.test.mjs',
      line: 2,
      code: [
        [2, "  it('draws', () => {", false],
        [3, '    expect(1).toBe(2);', true],
        [4, '  });', false],
      ],
    });
    expect(found.get('Swipe')).toMatchObject({ path: '.maestro/19_swipe.yaml', line: 1 });
    expect(found.get('gone')).toEqual({ path: '', line: 1, code: null });
  });

  it('leaves out a snippet of a file it could not read', () => {
    const found = locate(
      [tc({ name: 'a', title: 'a', suite: 'a.test.mjs' })],
      new Set(['a']),
      ['a.test.mjs'],
      () => {
        throw new Error('ENOENT');
      },
    );
    expect(found.get('a')).toEqual({ path: 'a.test.mjs', line: 1, code: null });
  });
});

describe('changedFiles', () => {
  /**
   * @param {string} sha
   * @param {string} [branch]
   */
  const r = (sha, branch = 'main') => ({ sha, branch });

  it("diffs each run with its own branch's previous run, fetching the missing commits together", () => {
    /** @type {string[][]} */
    const calls = [];
    const changed = changedFiles(
      [r('a'), r('p1', 'pr'), r('b'), r('b'), r('p2', 'pr'), r('c')],
      (args) => {
        calls.push(args);
        if (
          args[0] === 'cat-file' &&
          calls.filter((c) => c[0] === 'fetch').length === 0 &&
          ['c', 'p2'].some((x) => args[2] === `${x}^{commit}`)
        ) {
          throw new Error('missing');
        }
        if (args[0] === 'diff') return `${args[2]}-${args[3]}.txt\n`;
        return '';
      },
    );
    expect(changed).toEqual([
      null,
      null,
      new Set(['a-b.txt']),
      new Set(),
      new Set(['p1-p2.txt']),
      new Set(['b-c.txt']),
    ]);
    expect(calls.filter((c) => c[0] === 'fetch')).toEqual([
      ['fetch', '--no-tags', '--depth=1', 'origin', 'p2', 'c'],
    ]);
  });

  it("can't tell for a commit it can't reach, one with no commit, or a diff that fails", () => {
    const changed = changedFiles([r('a'), r('x'), r('b'), r('c'), r('')], (args) => {
      if (args[0] === 'cat-file' && args[2] === 'x^{commit}') throw new Error('gone');
      if (args[0] === 'diff' && args[2] === 'b') throw new Error('bad diff');
      return '';
    });
    expect(changed).toEqual([null, null, null, null, null]);
  });

  it('fetches and diffs nothing once its time is up', () => {
    /** @type {string[][]} */
    const calls = [];
    const changed = changedFiles(
      [r('a'), r('b')],
      (args) => {
        calls.push(args);
        if (args[0] === 'cat-file') throw new Error('missing');
        return '';
      },
      100,
      () => 200,
    );
    expect(changed).toEqual([null, null]);
    expect(calls.some((c) => c[0] === 'fetch' || c[0] === 'diff')).toBe(false);
  });
});
