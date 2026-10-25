import fc from 'fast-check';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addedRanges,
  formatOnly,
  inMutateScope,
  loadPrettier,
  main,
  mutateEntries,
  prettierFormat,
  prScope,
  scopeEntries,
  scopeFor,
  subjects,
  wiringChanged,
} from './scope.mjs';
import { parseSettings, wiringGlobs } from './settings.mjs';
import { cleanRepos, isolateGit, repo, writeFiles } from './test-repo.mjs';

const CI_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @typedef {import('./scope.mjs').ScopeIo} ScopeIo */

// The apps' mutate globs as their Stryker configs had them when this moved.
const BOARDGAMES_MUTATE = [
  'src/utils/**/*.ts',
  'src/context/filterReducer.ts',
  'src/components/**/*.tsx',
  'src/App.tsx',
  'src/sw/shell.ts',
  'src/pdfjs/saved.ts',
  'src/client/graphql.ts',
  'api/**/*.ts',
  '!**/*.d.ts',
];
const SIFT_MUTATE = [
  'src/context/**/*.{ts,tsx}',
  'src/services/**/*.ts',
  'src/utils/**/*.ts',
  'src/hooks/**/*.ts',
  '!src/**/index.ts',
  '!src/services/MusicProviderInterface.ts',
  '!src/utils/mockData.ts',
  '!src/services/MockMusicProvider.ts',
];

/**
 * A fake repository: base and head contents, a "formatter" that collapses
 * runs of spaces, standing in for Prettier, and the lines each file changed
 * (`lines`, else line 1 of a file the base has; a new file has none).
 *
 * @param {{ base?: Record<string, string>, head?: Record<string, string>,
 *   ignored?: string[], lines?: Record<string, Array<[number, number]>> }} [contents]
 * @returns {ScopeIo}
 */
function fakeRepo({ base = {}, head = {}, ignored = [], lines = {} } = {}) {
  return {
    ranges: (file) => (file in base ? (lines[file] ?? [[1, 1]]) : null),
    before: (file) => base[file] ?? null,
    now: (file) => {
      if (!(file in head)) throw new Error(`no ${file}`);
      return head[file];
    },
    format: async (source, file) => (ignored.includes(file) ? null : source.replace(/ +/g, ' ')),
    exists: (file) => file in head || file in base,
  };
}

const mutate = ['src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}', '!src/legacy.ts'];
const rules = { mutate, testSubjects: true, formatCheck: true };

describe('inMutateScope', () => {
  it('lets a later negation take back what an earlier glob selected', () => {
    expect(inMutateScope('src/a.d.ts', ['src/**/*.ts', '!**/*.d.ts'])).toBe(false);
    expect(inMutateScope('src/a.ts', ['src/**/*.ts', '!**/*.d.ts'])).toBe(true);
  });

  it('applies the globs in order, as Stryker does', () => {
    expect(inMutateScope('src/a.d.ts', ['!**/*.d.ts', 'src/**/*.ts'])).toBe(true);
  });

  it('selects nothing a positive glob does not name', () => {
    expect(inMutateScope('docs/a.ts', ['src/**/*.ts'])).toBe(false);
    expect(inMutateScope('src/a.ts', [])).toBe(false);
  });

  it('does not match into hidden directories', () => {
    expect(inMutateScope('src/.cache/a.ts', ['src/**/*.ts'])).toBe(false);
  });

  it("keeps BoardGames' changed source in scope and drops tests, declarations and the rest", () => {
    const changed = [
      'src/components/GameCard.tsx',
      'src/utils/filterGames.ts',
      'src/context/filterReducer.ts',
      'src/context/FilterContext.tsx',
      'src/App.tsx',
      'src/main.tsx',
      'src/sw/shell.ts',
      'src/sw/sw.ts',
      'src/pdfjs/saved.ts',
      'src/pdfjs/worker.ts',
      'api/graphql.ts',
      'api/_lib/slug.ts',
      'src/__tests__/filterGames.test.ts',
      'src/types/vitest-axe.d.ts',
      'src/utils/env.d.ts',
      'api/_lib/types.d.ts',
      'src/data/games.ts',
      'src/index.css',
      'stryker.config.json',
    ];
    expect(changed.filter((f) => inMutateScope(f, BOARDGAMES_MUTATE))).toEqual([
      'src/components/GameCard.tsx',
      'src/utils/filterGames.ts',
      'src/context/filterReducer.ts',
      'src/App.tsx',
      'src/sw/shell.ts',
      'src/pdfjs/saved.ts',
      'api/graphql.ts',
      'api/_lib/slug.ts',
    ]);
  });

  it("takes sift's context .ts and .tsx and its services', utils' and hooks' .ts", () => {
    const taken = [
      'src/context/SiftContext.tsx',
      'src/context/resumeSession.ts',
      'src/services/SessionStore.ts',
      'src/utils/sorting.ts',
      'src/hooks/usePendingDecision.ts',
      'src/utils/nested/deep.ts',
    ];
    expect(taken.filter((f) => inMutateScope(f, SIFT_MUTATE))).toEqual(taken);
    const left = [
      'src/utils/index.ts',
      'src/services/MusicProviderInterface.ts',
      'src/utils/mockData.ts',
      'src/services/MockMusicProvider.ts',
      'src/components/Button.tsx',
      'src/screens/SiftScreen.tsx',
      'src/hooks/useThing.tsx',
      'src/utils/sorting.js',
      '__tests__/unit/sorting.test.ts',
      'scripts/mutationScope.ts',
      'xsrc/utils/sorting.ts',
    ];
    expect(left.filter((f) => inMutateScope(f, SIFT_MUTATE))).toEqual([]);
  });

  it('never throws, and a trailing negation of everything selects nothing, for any path', () => {
    fc.assert(
      fc.property(fc.string(), (file) => {
        expect(typeof inMutateScope(file, mutate)).toBe('boolean');
        expect(inMutateScope(file, [...mutate, '!**'])).toBe(false);
      }),
    );
  });
});

describe('wiringChanged', () => {
  it("is true for a change to what fog-and-frontier's setup rests on", () => {
    const globs = wiringGlobs(
      parseSettings({
        wiring: [
          'vite.config.ts',
          'src/test/setup.ts',
          'tsconfig*.json',
          'package.json',
          'package-lock.json',
          'patches/**',
          '.github/workflows/mutation.yml',
        ],
      }),
    );
    for (const file of [
      'stryker.config.json',
      '.github/ci.json',
      'vite.config.ts',
      'src/test/setup.ts',
      'tsconfig.json',
      'tsconfig.app.json',
      'package.json',
      'package-lock.json',
      'patches/@stryker-mutator+vitest-runner+10.0.0.patch',
      '.github/workflows/mutation.yml',
    ]) {
      expect(wiringChanged(['README.md', file], globs), file).toBe(true);
    }
    expect(
      wiringChanged(
        [
          'docs/screenshots/catalog.png',
          'README.md',
          '.github/workflows/ci.yml',
          '.github/scripts/pr-visuals.mjs',
          'src/test/render.tsx',
          'src/lib/viewMode.ts',
          'api/tsconfig.json',
          'scripts/package.json',
        ],
        globs,
      ),
    ).toBe(false);
  });

  it("counts sift's Jest and Babel setup, and not its source, tests or other workflows", () => {
    const globs = wiringGlobs(
      parseSettings({
        wiring: [
          'stryker.conf*',
          'jest.{config,setup}*',
          'babel.config.*',
          '.babelrc*',
          '__tests__/helpers/*.setup.ts',
          'package.json',
          'package-lock.json',
          'patches/**',
          '.github/workflows/mutation.yml',
          'scripts/stryker-jest-runner.mjs',
          'scripts/strykerTestFiles.ts',
          '__tests__/unit/strykerTestFiles.test.ts',
        ],
      }),
    );
    for (const file of [
      'stryker.config.json',
      'stryker.conf.js',
      'jest.config.js',
      'jest.setup.ts',
      'babel.config.js',
      '.babelrc',
      '__tests__/helpers/clock.setup.ts',
      'patches/@stryker-mutator+jest-runner+10.0.0.patch',
      'scripts/stryker-jest-runner.mjs',
      'scripts/strykerTestFiles.ts',
      '__tests__/unit/strykerTestFiles.test.ts',
    ]) {
      expect(wiringChanged([file], globs), file).toBe(true);
    }
    for (const file of [
      'src/screens/SiftScreen.tsx',
      'src/utils/sorting.ts',
      '__tests__/unit/sorting.test.ts',
      '__tests__/helpers/renderWithProviders.tsx',
      '__mocks__/expo-musickit.ts',
      'CLAUDE.md',
      'scripts/pr-gifs.mjs',
      'src/package.json',
      'my-stryker.config.json',
    ]) {
      expect(wiringChanged([file], globs), file).toBe(false);
    }
  });

  it('is false for nothing', () => {
    expect(wiringChanged([], ['**'])).toBe(false);
  });
});

describe('subjects', () => {
  /** @param {string} f */
  const exists = (f) =>
    ['src/a.ts', 'src/b.tsx', 'src/x.helpers.ts', 'src/x.ts', 'App.tsx'].includes(f);

  it('maps a test to the source it covers, and a source to itself', () => {
    expect(subjects('src/a.test.ts', exists)).toEqual(['src/a.ts']);
    expect(subjects('src/b.test.tsx', exists)).toEqual(['src/b.tsx']);
    expect(subjects('src/__tests__/a.test.ts', exists)).toEqual(['src/a.ts']);
    expect(subjects('__tests__/App.test.tsx', exists)).toEqual(['App.tsx']);
    expect(subjects('src/a.ts', exists)).toEqual(['src/a.ts']);
  });

  it('strips an infix only when no source has the full name', () => {
    expect(subjects('src/x.helpers.test.ts', exists)).toEqual(['src/x.helpers.ts']);
    expect(subjects('src/a.cache.test.ts', exists)).toEqual(['src/a.ts']);
    expect(subjects('src/gone.test.ts', exists)).toEqual([]);
  });
});

describe('addedRanges', () => {
  it('reads the new side of each hunk, a missing count meaning one line', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -3 +3 @@ export function x() {',
      '-a',
      '+b',
      '@@ -10,0 +11,4 @@',
      '+c',
      '+d',
      '+e',
      '+f',
      '@@ -20,2 +25,3 @@',
      '-g',
      '-h',
      '+i',
      '+j',
      '+k',
      '@@ -30,2 +40 @@',
      '-l',
      '-m',
      '+n',
    ].join('\n');
    expect(addedRanges(diff)).toEqual([
      [3, 3],
      [11, 14],
      [25, 27],
      [40, 40],
    ]);
  });

  it('adds nothing for a hunk that only deletes, or for no diff', () => {
    expect(addedRanges('@@ -5,2 +4,0 @@\n-a\n-b\n')).toEqual([]);
    expect(addedRanges('')).toEqual([]);
  });

  it('reads only hunk headers, not a changed line that looks like one', () => {
    expect(addedRanges('@@ -1 +1 @@\n-x\n+@@ -1 +9,9 @@\n')).toEqual([[1, 1]]);
  });

  it('gives ordered, positive ranges, never throwing, for any text', () => {
    const header = fc
      .tuple(fc.nat(500), fc.nat(500), fc.integer({ min: 1, max: 500 }), fc.nat(20))
      .map(([a, b, start, count]) => `@@ -${a},${b} +${start},${count} @@`);
    const text = fc
      .array(fc.oneof(header, fc.string()), { maxLength: 20 })
      .map((l) => l.join('\n'));
    fc.assert(
      fc.property(text, (diff) => {
        for (const [first, last] of addedRanges(diff)) {
          expect(first).toBeGreaterThan(0);
          expect(last).toBeGreaterThanOrEqual(first);
        }
      }),
    );
  });
});

describe('mutateEntries', () => {
  it('names a file whole, each changed block, or nothing', () => {
    expect(mutateEntries('src/a.ts', null)).toEqual(['src/a.ts']);
    expect(
      mutateEntries('src/a.ts', [
        [3, 3],
        [11, 14],
      ]),
    ).toEqual(['src/a.ts:3-3', 'src/a.ts:11-14']);
    expect(mutateEntries('src/a.ts', [])).toEqual([]);
  });
});

describe('formatOnly', () => {
  it('is true when formatting the base gives the head exactly', async () => {
    const r = fakeRepo({ base: { 'src/a.ts': 'let  a = 1;' }, head: { 'src/a.ts': 'let a = 1;' } });
    expect(await formatOnly('src/a.ts', r)).toBe(true);
  });

  it('is false for a real change, a new file, an ignored file or a read that fails', async () => {
    const r = fakeRepo({
      base: { 'src/a.ts': 'let  a = 1;', 'src/gql.ts': 'x  y', 'src/gone.ts': 'z' },
      head: { 'src/a.ts': 'let a = 2;', 'src/new.ts': 'let b;', 'src/gql.ts': 'x y' },
      ignored: ['src/gql.ts'],
    });
    expect(await formatOnly('src/a.ts', r)).toBe(false);
    expect(await formatOnly('src/new.ts', r)).toBe(false);
    expect(await formatOnly('src/gql.ts', r)).toBe(false);
    expect(await formatOnly('src/gone.ts', r)).toBe(false);
  });

  it('counts a formatter that throws as a real change', async () => {
    const r = {
      ...fakeRepo({ base: { 'src/a.ts': 'x' }, head: { 'src/a.ts': 'x' } }),
      format: async () => {
        throw new Error('syntax error');
      },
    };
    expect(await formatOnly('src/a.ts', r)).toBe(false);
  });
});

describe('scopeEntries', () => {
  const r = fakeRepo({
    base: {
      'src/fmt.ts': 'a  b',
      'src/real.ts': 'a',
      'src/covered.ts': 'c',
      'src/covered.test.ts': 'it(  1)',
      'src/tested.ts': 't',
      'src/tested.test.ts': 'it(1)',
      'src/legacy.ts': 'l',
    },
    head: {
      'src/fmt.ts': 'a b',
      'src/real.ts': 'b',
      'src/new.ts': 'n',
      'src/covered.ts': 'c',
      'src/covered.test.ts': 'it( 1)',
      'src/tested.ts': 't',
      'src/tested.test.ts': 'it(2)',
      'src/legacy.ts': 'm',
      'README.md': 'x',
    },
  });

  it('leaves out format-only changes, narrows real ones to their lines and keeps new files whole', async () => {
    expect(await scopeEntries(['src/fmt.ts', 'src/real.ts', 'src/new.ts'], rules, r)).toEqual([
      'src/real.ts:1-1',
      'src/new.ts',
    ]);
  });

  it('keeps a format-only change without formatCheck', async () => {
    expect(await scopeEntries(['src/fmt.ts'], { ...rules, formatCheck: false }, r)).toEqual([
      'src/fmt.ts:1-1',
    ]);
  });

  it('names each changed block of a file, and nothing for one that only lost lines', async () => {
    const lined = fakeRepo({
      base: { 'src/a.ts': 'a', 'src/b.ts': 'b' },
      head: { 'src/a.ts': 'A', 'src/b.ts': '' },
      lines: {
        'src/a.ts': [
          [3, 3],
          [11, 14],
        ],
        'src/b.ts': [],
      },
    });
    expect(await scopeEntries(['src/a.ts', 'src/b.ts'], rules, lined)).toEqual([
      'src/a.ts:3-3',
      'src/a.ts:11-14',
    ]);
  });

  it('keeps the source of a changed test whole, whichever is listed first', async () => {
    const both = ['src/tested.ts', 'src/tested.test.ts'];
    expect(await scopeEntries(both, rules, r)).toEqual(['src/tested.ts']);
    expect(await scopeEntries([...both].reverse(), rules, r)).toEqual(['src/tested.ts']);
  });

  it('maps a really changed test to its source, and a reformatted one to nothing', async () => {
    expect(await scopeEntries(['src/tested.test.ts', 'src/covered.test.ts'], rules, r)).toEqual([
      'src/tested.ts',
    ]);
  });

  it('maps no test to its source without testSubjects', async () => {
    const off = { ...rules, testSubjects: false };
    expect(await scopeEntries(['src/tested.test.ts'], off, r)).toEqual([]);
  });

  it('keeps to the globs, and lists a file once', async () => {
    expect(
      await scopeEntries(
        ['src/legacy.ts', 'README.md', 'src/tested.ts', 'src/tested.test.ts'],
        rules,
        r,
      ),
    ).toEqual(['src/tested.ts']);
  });

  it('reads and formats only the files that would count', async () => {
    const read = /** @type {string[]} */ ([]);
    const io = { ...r, before: (/** @type {string} */ f) => (read.push(f), r.before(f)) };
    await scopeEntries(
      ['README.md', 'src/legacy.ts', 'src/fmt.ts', 'src/tested.test.ts'],
      rules,
      io,
    );
    expect(read).toEqual(['src/fmt.ts', 'src/tested.test.ts']);
  });

  it('diffs only the files in scope', async () => {
    const asked = /** @type {string[]} */ ([]);
    const io = { ...r, ranges: (/** @type {string} */ f) => (asked.push(f), [[1, 1]]) };
    await scopeEntries(
      ['src/real.ts', 'README.md', 'src/legacy.ts'],
      rules,
      /** @type {ScopeIo} */ (io),
    );
    expect(asked).toEqual(['src/real.ts']);
  });
});

describe('prScope', () => {
  const settings = parseSettings({ smoke: ['src/utils/formatTime.ts', 'src/utils/sorting.ts'] });
  const io = fakeRepo({ base: { 'src/a.ts': 'a', 'src/gone.ts': 'g' }, head: { 'src/a.ts': 'b' } });
  /**
   * @param {string[]} changed
   * @param {string[]} [touched]
   */
  const run = (changed, touched = changed) => prScope({ changed, touched, mutate, settings, io });

  it('mutates the changed lines when there are any', async () => {
    expect(await run(['src/a.ts', 'package.json'])).toEqual({
      entries: ['src/a.ts:1-1'],
      reason: 'changed',
    });
  });

  it('runs the smoke scope when only the setup changed, a deletion included', async () => {
    expect(await run(['package.json'])).toEqual({ entries: settings.smoke, reason: 'smoke' });
    expect(await run([], ['patches/old.patch'])).toEqual({
      entries: settings.smoke,
      reason: 'smoke',
    });
  });

  it('runs nothing when neither mutable code nor the setup changed', async () => {
    expect(await run(['src/screens/x.css', 'README.md'])).toEqual({ entries: [], reason: 'none' });
  });

  it('runs nothing for a setup change with no smoke scope', async () => {
    const none = await prScope({
      changed: ['package.json'],
      touched: ['package.json'],
      mutate,
      settings: parseSettings({}),
      io,
    });
    expect(none).toEqual({ entries: [], reason: 'none' });
  });

  it('hands out a copy of the smoke scope', async () => {
    const { entries } = await run(['package.json']);
    entries.push('x');
    expect(settings.smoke).toHaveLength(2);
  });
});

describe("the app's Prettier", () => {
  it("formats with the app's config, and is null for what it ignores", async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'prettier-app-'));
    writeFileSync(path.join(root, '.prettierrc.json'), '{"singleQuote":true}');
    writeFileSync(path.join(root, '.prettierignore'), 'gen/\n');
    const prettier = await loadPrettier(CI_ROOT);
    expect(prettier).not.toBeNull();
    const format = prettierFormat(prettier, root);
    expect(await format('const a = "x"', 'src/x.ts')).toBe("const a = 'x';\n");
    expect(await format('const a = "x"', 'gen/x.ts')).toBeNull();
    expect(await format('x', 'notes.unknown-ext')).toBeNull();
    await expect(format('const = ;', 'src/x.ts')).rejects.toThrow();
    expect(await prettierFormat(null, root)('x', 'src/x.ts')).toBeNull();
  });

  it('is null when the app has none installed, or one that is not Prettier', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bare-app-'));
    expect(await loadPrettier(root)).toBeNull();
    writeFiles(root, {
      'package.json': '{}',
      'node_modules/prettier/package.json': '{"name":"prettier","main":"index.js"}',
      'node_modules/prettier/index.js': 'exports.format = 1;',
    });
    expect(await loadPrettier(root)).toBeNull();
    writeFiles(root, {
      'node_modules/prettier/package.json': '{"name":"prettier","main":"gone.js"}',
    });
    expect(await loadPrettier(root)).toBeNull();
  });
});

// A real history in a throwaway repository: the base on main, the PR a
// branch from it.
describe('against a base in git', () => {
  /** @type {() => void} */
  let restore;
  beforeAll(() => {
    restore = isolateGit();
  });
  afterAll(() => restore());
  afterEach(() => {
    cleanRepos();
    delete process.env.GITHUB_OUTPUT;
    vi.restoreAllMocks();
  });

  const base = {
    '.github/ci.json': JSON.stringify({ mutation: { smoke: ['src/changed.ts'] } }),
    '.prettierrc.json': JSON.stringify({ singleQuote: true }),
    'stryker.config.json': '{"mutate":["src/**/*.ts","!src/**/*.test.ts"]}',
    'src/changed.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
    'src/shrunk.ts': 'export const a = 1;\nexport const b = 2;\n',
    'src/fmt.ts': 'export const a   =  "x"',
    'src/covered.ts': 'export const a = 1;\nexport const b = 2;\n',
    'src/covered.test.ts': 'it("a", () => {});\n',
    'patches/x.patch': 'p',
  };

  it('mutates changed lines, a covered file and a new file whole, and skips a reformat', async () => {
    const app = repo(base);
    app.git('checkout', '-q', '-b', 'pr');
    app.commit({
      'src/changed.ts':
        'export const a = 1;\nexport const b = 20;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n',
      'src/shrunk.ts': 'export const a = 1;\n',
      'src/fmt.ts': "export const a = 'x';\n",
      'src/covered.test.ts': 'it("a", () => {});\nit("b", () => {});\n',
      'src/new.ts': 'export const n = 1;\n',
      'README.md': 'x',
    });
    expect(await scopeFor(app.root, 'main')).toEqual({
      entries: ['src/changed.ts:2-2', 'src/changed.ts:4-5', 'src/covered.ts', 'src/new.ts'],
      reason: 'changed',
    });
  });

  it('runs the smoke scope for a deleted setup file, and nothing for docs', async () => {
    const app = repo(base);
    app.git('checkout', '-q', '-b', 'pr');
    app.commit({ 'README.md': 'x' });
    expect(await scopeFor(app.root, 'main')).toEqual({ entries: [], reason: 'none' });
    app.commit({}, ['patches/x.patch']);
    expect(await scopeFor(app.root, 'main')).toEqual({
      entries: ['src/changed.ts'],
      reason: 'smoke',
    });
  });

  it('writes the outputs from the command line', async () => {
    const app = repo(base);
    app.git('checkout', '-q', '-b', 'pr');
    app.commit({ 'src/new.ts': 'export const n = 1;\n', 'src/two.ts': 'export const t = 2;\n' });
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'scope-out-')), 'out');
    writeFileSync(out, '');
    process.env.GITHUB_OUTPUT = out;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['main'], app.root)).toBe(0);
    expect(log).toHaveBeenCalledWith('Mutating the changed lines:\nsrc/new.ts\nsrc/two.ts');
    const text = readFileSync(out, 'utf8');
    expect(text).toMatch(/run<<(\w+)\ntrue\n\1/);
    expect(text).toMatch(/mutate<<(\w+)\nsrc\/new\.ts,src\/two\.ts\n\1/);
    expect(text).toMatch(/reason<<(\w+)\nchanged\n\1/);
  });

  it('needs the base ref', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main([], '/nowhere')).toBe(2);
    expect(error).toHaveBeenCalledWith('Usage: scope.mjs <base ref>');
  });
});
