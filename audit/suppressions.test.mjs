import { rmSync } from 'node:fs';
import path from 'node:path';
import ts from '@typescript/typescript6';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isolateGit } from '../mutation/test-repo.mjs';
import { parseJsonc } from './jsonc.mjs';
import {
  annotations,
  cli,
  keyLines,
  knipSuppressions,
  readKnipConfig,
  suppressionTags,
  suppressions,
  suppressionsMessage,
} from './suppressions.mjs';
import { APP_CONFIGS, app, cleanApps } from './test-app.mjs';

/** @type {() => void} */
let restoreGit;
beforeEach(() => {
  restoreGit = isolateGit();
});
afterEach(() => {
  restoreGit();
  cleanApps();
});

/** The option paths knipSuppressions reports for a config. */
const paths = (/** @type {unknown} */ config, /** @type {string[]} */ tracked = []) =>
  knipSuppressions(config, tracked).map((s) => s.path.join('.'));

describe('knipSuppressions', () => {
  it.each([
    'ignore',
    'ignoreFiles',
    'ignoreDependencies',
    'ignoreBinaries',
    'ignoreGlobalBinaries',
    'ignoreMembers',
    'ignoreUnresolved',
    'ignoreExportsUsedInFile',
    'ignoreIssues',
    'ignoreWorkspaces',
    'ignoreSomethingKnipAddsLater',
    'include',
    'exclude',
    'tags',
  ])('refuses %s, at the root and under a workspace, with its fix', (key) => {
    const found = knipSuppressions({
      [key]: ['x'],
      workspaces: { 'packages/a': { [key]: ['x'] } },
    });
    expect(found.map((s) => s.path)).toEqual([[key], ['workspaces', 'packages/a', key]]);
    expect(found[0].values).toEqual(['x']);
    expect(found[0].fix).toMatch(/^delete it/);
  });

  it('refuses a rule that is not "error", naming it', () => {
    const [rules] = knipSuppressions({ rules: { exports: 'off', types: 'warn', files: 'error' } });
    expect(rules.values).toEqual(['exports: "off"', 'types: "warn"']);
    expect(paths({ rules: { exports: 'error' } })).toEqual([]);
  });

  it('refuses cycles.allow, not cycles.dynamicImports', () => {
    expect(paths({ cycles: { allow: [['a.ts', 'b.ts']], dynamicImports: true } })).toEqual([
      'cycles.allow',
    ]);
    expect(paths({ cycles: { dynamicImports: true } })).toEqual([]);
  });

  it('refuses a negated project glob, and allows a negated entry', () => {
    const [project] = knipSuppressions({ project: ['src/**', '!src/legacy/**'] });
    expect(project).toMatchObject({ path: ['project'], values: ['!src/legacy/**'] });
    expect(paths({ project: 'src/**', entry: ['src/*.ts', '!src/skip.ts'] })).toEqual([]);
  });

  it('allows what says where code starts or how to read it', () => {
    expect(
      paths({
        $schema: 'x',
        entry: ['a.ts'],
        project: ['**'],
        paths: { '@/*': ['src/*'] },
        compilers: {},
        preprocessor: 'x',
        includeEntryExports: false,
        treatConfigHintsAsErrors: false,
        treatTagHintsAsErrors: false,
        workspaces: { '.': { entry: ['a.ts'] } },
      }),
    ).toEqual([]);
  });

  it('refuses a plugin turned off, or whose config names no tracked file', () => {
    expect(paths({ expo: false })).toEqual(['expo']);
    expect(paths({ expo: { config: [] } })).toEqual(['expo']);
    expect(paths({ eslint: ['nowhere.js'] }, ['eslint.config.js'])).toEqual(['eslint']);
    const [off] = knipSuppressions({ vite: false });
    expect(off.fix).toBe('delete it, so the plugin reads its config.');
  });

  it("refuses a negated glob in a plugin's project, as at the root", () => {
    expect(knipSuppressions({ vitest: { project: ['src/**', '!src/legacy/**'] } })).toEqual([
      {
        path: ['vitest'],
        values: ['project: !src/legacy/**'],
        fix: 'delete the negation, so knip reads every file.',
      },
    ]);
  });

  it("allows a plugin's entry, project, true, or a config naming a real file", () => {
    const tracked = ['config/app.json', 'packages/a/vite.config.ts'];
    expect(
      paths(
        {
          expo: { config: ['config/app.json'], entry: ['x.ts'] },
          vite: true,
          vitest: { entry: ['**/*.test.ts'], project: ['src/**'] },
          workspaces: { 'packages/a': { vite: { config: 'vite.config.ts' } } },
        },
        tracked,
      ),
    ).toEqual([]);
  });

  it.each([[null], [1], ['x'], [[]], [{ workspaces: 1, rules: 2, cycles: 3, project: 4 }]])(
    'reads %j without throwing',
    (config) => {
      expect(() => knipSuppressions(config)).not.toThrow();
    },
  );

  it("gives exactly the plan's lists for the three apps' configs as they stood", () => {
    const found = Object.fromEntries(
      Object.entries(APP_CONFIGS).map(([name, text]) => [
        name,
        knipSuppressions(parseJsonc(text)).map(
          (s) => `${s.path.join('.')}: ${s.values.join(', ')}`,
        ),
      ]),
    );
    expect(found).toEqual({
      'BoardGames.knip.jsonc': ['ignoreDependencies: axe-core, jscpd, pixelmatch, pngjs'],
      'fog-and-frontier.knip.json': ['ignoreDependencies: jscpd, pixelmatch, pngjs'],
      'sift.knip.jsonc': [
        'ignoreDependencies: expo-musickit, expo-system-ui, jscpd, pixelmatch, pngjs',
        'ignoreIssues: modules/expo-musickit/src/index.ts',
      ],
    });
  });
});

describe('suppressionTags', () => {
  // Checked against knip 6.43: with an entry importing only `used`, knip
  // reported e, f and g unused and hid a, b, c, d, h and i.
  const SOURCE = [
    'export const used = 1;',
    '/** @public */',
    'export const a = 1;',
    '/* @public */',
    'export const b = 1;',
    '// @public',
    'export const c = 1;',
    '/** @public-key */',
    'export const d = 1;',
    '/** @publicKey */',
    'export const e = 1;',
    'const z = 1; // @public',
    'export const f = z;',
    '/** @internal */',
    'export const g = 1;',
    '/** @beta */',
    'export const h = 1;',
    '/** @alias */',
    'export const i = 1;',
  ].join('\n');

  it('finds each tag knip hides an export for, as knip reads it', () => {
    expect(suppressionTags(SOURCE, ts)).toEqual([
      { tag: '@public', line: 2 },
      { tag: '@public', line: 4 },
      { tag: '@public', line: 6 },
      { tag: '@public', line: 8 },
      { tag: '@beta', line: 16 },
      { tag: '@alias', line: 18 },
    ]);
  });

  it('reads a tag in prose and in an indented line comment, but never in a string', () => {
    expect(
      suppressionTags(
        [
          '// Each export is tagged @public for knip.',
          'function f() {',
          '  // @beta',
          "  const s = '/** @public */';",
          '  const t = "// @public";',
          '  const u = `/* @alias */ ${s}`;',
          '  return [s, t, u];',
          '}',
        ].join('\n'),
        ts,
      ),
    ).toEqual([
      { tag: '@public', line: 1 },
      { tag: '@beta', line: 3 },
    ]);
  });

  it('stays in step past a quote in a regex, a nested template or JSX text', () => {
    const later = '\n/** @public */\nexport const x = 1;\n';
    expect(suppressionTags(`const a = s.replace(/'/g, '');${later}`, ts)).toEqual([
      { tag: '@public', line: 2 },
    ]);
    expect(suppressionTags('const b = `a ${"`"} b ${`/* @beta */`}`;' + later, ts)).toEqual([
      { tag: '@public', line: 2 },
    ]);
    const jsx = [
      "export const P = () => <p>Don't // @beta, /* @alias */</p>;",
      "const s = '/* @public */';",
      '// @beta',
    ].join('\n');
    expect(suppressionTags(jsx, ts, 'a.tsx')).toEqual([{ tag: '@beta', line: 3 }]);
    expect(suppressionTags("const r = /'/;\n// @alias\n", ts, 'a.mjs')).toEqual([
      { tag: '@alias', line: 2 },
    ]);
  });

  it('reads an unterminated block comment to the end', () => {
    expect(suppressionTags('x;\n/* @public', ts)).toEqual([{ tag: '@public', line: 2 }]);
  });
});

describe('keyLines', () => {
  it('finds each key where it is, never in a comment or a string', () => {
    const lines = keyLines(
      [
        '{',
        '  // "ignore": would be bad',
        '  "entry": ["\\"ignore\\": no"],',
        '  "workspaces": { "a": {',
        '    "ignore": ["x"] } },',
        '  /* "ignore": */ "ignore": [],',
        '}',
      ].join('\n'),
    );
    expect(lines.get('ignore')).toBe(6);
    expect(lines.get(['workspaces', 'a', 'ignore'].join('\0'))).toBe(5);
    expect(lines.get('entry')).toBe(3);
    expect(lines.get('nope')).toBeUndefined();
  });
});

describe('readKnipConfig', () => {
  it('reads the first of knip’s locations, else package.json’s knip key, else none', () => {
    expect(
      readKnipConfig(app({ 'knip.json': '{"a":1}', 'knip.jsonc': '{"b":2}' }))?.config,
    ).toEqual({ a: 1 });
    expect(readKnipConfig(app({ 'package.json': '{"knip":{"entry":[]}}' }))).toMatchObject({
      file: 'package.json',
      keys: ['knip'],
      config: { entry: [] },
    });
    expect(readKnipConfig(app({ 'package.json': '{}' }))).toBeNull();
    expect(readKnipConfig(app({ 'a.txt': '' }))).toBeNull();
  });

  it('refuses a config it would have to run, and names one that does not parse', () => {
    expect(() => readKnipConfig(app({ 'knip.ts': 'export default {}' }))).toThrow(
      "knip.ts can't be read without running it, so the audit can't check what it hides: move the config to knip.jsonc.",
    );
    expect(() => readKnipConfig(app({ 'knip.jsonc': '{ nope' }))).toThrow(
      /^knip.jsonc doesn't parse: /,
    );
  });
});

describe('suppressions', () => {
  it("lists the config's, with their lines, then the code's, by file and tag", () => {
    const root = app({
      'package.json':
        '{\n  "name": "x",\n  "knip": {\n    "ignoreFiles": ["a"],\n    "workspaces": {\n      "w": { "ignore": ["b"] }\n    }\n  }\n}',
      'src/a.ts': '/** @public */\nexport const a = 1;\n/** @public */\nexport const b = 1;\n',
      'src/b.css': '/* @public */',
      'README.md': '@public',
    });
    const found = suppressions(root);
    expect(found.config).toBe('package.json');
    expect(found.list.map((s) => `${s.file}:${s.lines.join(',')} ${s.option}`)).toEqual([
      'package.json:4 ignoreFiles',
      'package.json:6 workspaces.w.ignore',
      'src/a.ts:1,3 @public',
    ]);
  });

  it('finds nothing in a clean app, and skips a tracked file since deleted', () => {
    const root = app({ 'knip.jsonc': '{ "entry": ["a.ts"] }', 'a.ts': '// fine\n' });
    rmSync(path.join(root, 'a.ts'));
    expect(suppressions(root)).toEqual({ config: 'knip.jsonc', list: [] });
  });
});

describe('suppressionsMessage', () => {
  const config = {
    file: 'knip.jsonc',
    lines: [23],
    option: 'ignoreDependencies',
    values: ['axe-core'],
    fix: 'delete it.',
  };
  const tag = {
    file: 'a.ts',
    lines: [5, 11],
    option: '@public',
    values: [],
    fix: 'delete the tag.',
  };

  it('says what hides what, and how to fix each', () => {
    expect(suppressionsMessage({ config: 'knip.jsonc', list: [config, tag] })).toBe(
      [
        'knip.jsonc and the code hide what the weekly audit should find. Fix each finding instead of suppressing it (shared rules, "Fix weekly-audit findings rather than suppressing them"):',
        '- `knip.jsonc:23` `ignoreDependencies` (`axe-core`): delete it.',
        '- `a.ts:5, 11` `@public`: delete the tag.',
        '`entry`, `project` and `paths` stay allowed: they tell knip where code starts.',
      ].join('\n'),
    );
    expect(suppressionsMessage({ config: 'knip.jsonc', list: [tag] })).toMatch(/^the code hides/);
    expect(
      suppressionsMessage({ config: 'knip.jsonc', list: [{ ...config, lines: [] }] }),
    ).toContain('\n- `knip.jsonc` `ignoreDependencies` (`axe-core`): delete it.\n');
  });

  it('writes names and globs as code, so the issue shows them as they are', () => {
    const globs = { ...config, option: 'ignore', values: ['src/**/*.gen.ts', 'a`b'] };
    expect(suppressionsMessage({ config: 'knip.jsonc', list: [globs] })).toContain(
      '`ignore` (`src/**/*.gen.ts`, `` a`b ``)',
    );
  });

  it('annotates each place, escaping what GitHub would read as a new line', () => {
    expect(annotations([tag, { ...config, lines: [], fix: 'a\nb 100%' }])).toEqual([
      '::error file=a.ts,line=5::@public hides knip findings: delete the tag.',
      '::error file=a.ts,line=11::@public hides knip findings: delete the tag.',
      '::error file=knip.jsonc,line=1::ignoreDependencies hides knip findings: a%0Ab 100%25',
    ]);
  });

  it("escapes the , and : that would end a file's name", () => {
    expect(annotations([{ ...tag, file: 'src/a,b:c.ts', lines: [3] }])).toEqual([
      '::error file=src/a%2Cb%3Ac.ts,line=3::@public hides knip findings: delete the tag.',
    ]);
  });
});

describe('cli', () => {
  it('passes a clean app, saying so', () => {
    const lines = /** @type {string[]} */ ([]);
    expect(cli([], app({ 'knip.json': '{}' }), (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual(['No knip suppressions in knip.json or the code.']);
  });

  it('fails one with a suppression, annotating when asked', () => {
    const root = app({ 'knip.json': '{\n"ignore": ["x"]\n}' });
    const lines = /** @type {string[]} */ ([]);
    expect(cli(['--annotate'], root, (l) => lines.push(l))).toBe(1);
    expect(lines[0]).toMatch(/^::error file=knip.json,line=2::ignore hides knip findings: /);
    expect(lines[1]).toMatch(/^knip.json hides what the weekly audit should find\./);
    expect(cli([], root, () => {})).toBe(1);
  });
});
