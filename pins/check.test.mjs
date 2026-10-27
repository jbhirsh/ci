import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  caretFor,
  dependabotFindings,
  expoManaged,
  explains,
  findings,
  isPinnedImage,
  isPinnedRange,
  isReason,
  main,
  notes,
  packageFindings,
  pinOnLine,
  rangeOf,
  yamlFiles,
  yamlFindings,
} from './check.mjs';

/** A throwaway checkout holding these files. */
function checkout(/** @type {Record<string, string>} */ files) {
  const root = mkdtempSync(path.join(tmpdir(), 'pins-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

/** @param {Record<string, unknown>} pkg */
const json = (pkg) => JSON.stringify(pkg, null, 2);

describe('isReason', () => {
  it('takes a few words', () => {
    expect(isReason('TS 7 has no JS API')).toBe(true);
    expect(isReason('Apollo does not accept graphql 17 yet')).toBe(true);
  });

  it('turns away a version label, a commit or a word or two', () => {
    for (const text of [
      'v2.9.0',
      ' v7.0.11',
      'e7477775783ea5526144ba13e8db5eec57747ce8 v2',
      'pinned',
      'keep it',
      '',
    ]) {
      expect(isReason(text)).toBe(false);
    }
  });
});

describe('rangeOf', () => {
  it('reads the range after an npm alias', () => {
    expect(rangeOf('npm:@typescript/typescript6@~6.0.2')).toBe('~6.0.2');
    expect(rangeOf('npm:typescript@^7.0.2')).toBe('^7.0.2');
    expect(rangeOf(' ^1.2.3 ')).toBe('^1.2.3');
  });

  it('is null for a spec naming no registry version', () => {
    for (const spec of [
      'file:modules/x',
      'link:../y',
      'workspace:*',
      'git+https://a/b.git',
      'github:a/b',
      'a/b',
      'https://x/y.tgz',
    ]) {
      expect(rangeOf(spec)).toBeNull();
    }
  });
});

describe('isPinnedRange', () => {
  it.each([
    '1.2.3',
    '=1.2.3',
    'v1.2.3',
    '1.2.3-beta.1',
    '~1.2.3',
    '~1.2',
    '1.2',
    '1.2.x',
    '<1.5',
    '<=2',
    '>=1 <1.5',
    '^1.2.3 <1.5.0',
    '1.0.0 - 1.4.0',
    '^1 || 1.2.3',
  ])('pins %s', (range) => expect(isPinnedRange(range)).toBe(true));

  it.each([
    '^1.2.3',
    '<2',
    '>=1.2.3 <2',
    '>=1 <2.0.0',
    '^0.10.4',
    '1',
    '1.x',
    '1.x.x',
    '~1',
    '~1.x',
    '*',
    'x',
    '',
    'latest',
    '>=1.2.3',
    '>1',
  ])('leaves %s free', (range) => expect(isPinnedRange(range)).toBe(false));
});

describe('caretFor', () => {
  it('offers the caret of a single version', () => {
    expect(caretFor('~6.0.2')).toBe('^6.0.2');
    expect(caretFor('10.0.0')).toBe('^10.0.0');
    expect(caretFor('=v1.2')).toBe('^1.2');
    expect(caretFor('1.2.x')).toBe('^1.2');
  });

  it('offers nothing for a range', () => {
    expect(caretFor('>=1 <2')).toBeNull();
    expect(caretFor('1.0.0 - 1.4.0')).toBeNull();
  });
});

describe('notes and explains', () => {
  it('reads a string or a list of strings', () => {
    expect(notes('a')).toEqual(['a']);
    expect(notes(['a', 1, 'b'])).toEqual(['a', 'b']);
    expect(notes(undefined)).toEqual([]);
    expect(notes({ a: 'b' })).toEqual([]);
  });

  const entries = [
    'eslint-plugin-import and eslint-plugin-jsx-a11y -> eslint: $eslint: neither accepts ESLint 10 yet.',
    'test-renderer: 1.3 bundles a React 19.3 reconciler; delete with the SDK upgrade.',
    'react.',
  ];

  it('finds a package named in a note that says why', () => {
    expect(explains(entries, 'eslint-plugin-import')).toBe(true);
    expect(explains(entries, 'eslint-plugin-jsx-a11y')).toBe(true);
    expect(explains(entries, 'test-renderer')).toBe(true);
    expect(explains(['typescript@6: typescript-eslint loads its JS API.'], 'typescript')).toBe(
      true,
    );
  });

  it("doesn't take a longer name, a name inside another, or a note with no reason", () => {
    expect(explains(entries, 'import')).toBe(false);
    expect(explains(entries, 'eslint-plugin')).toBe(false);
    expect(explains(entries, 'test')).toBe(false);
    expect(explains(entries, 'react')).toBe(false);
  });
});

describe('packageFindings', () => {
  const pkg = {
    dependencies: { react: '19.2.3', vite: '^7.1.0', mine: 'file:./mine' },
    devDependencies: { typescript: 'npm:@typescript/typescript6@~6.0.2', runner: '10.0.0' },
    optionalDependencies: { odd: '>=1 <1.5' },
    overrides: { 'eslint-plugin-import': { eslint: '$eslint' }, zod: '^4' },
    '//pins': ['runner 10.0.0: its patch under patches/ is for this release only.'],
    '//overrides': ['eslint-plugin-import -> eslint: it has no release accepting ESLint 10.'],
  };

  it('lists each pin and override with no reason, on its line', () => {
    const text = json(pkg);
    const lines = text.split('\n');
    const found = packageFindings(text);
    expect(found.map((f) => [f.line, lines[f.line - 1]?.trim().split(':')[0]])).toEqual([
      [3, '"react"'],
      [8, '"typescript"'],
      [12, '"odd"'],
      [18, '"zod"'],
    ]);
    expect(found[0]?.message).toBe(
      'react 19.2.3 holds it below its next major: use ^19.2.3, or say why in "//pins".',
    );
    expect(found[2]?.message).toBe(
      'odd >=1 <1.5 holds it below its next major: or say why in "//pins".',
    );
    expect(found[3]?.message).toContain('the override of zod has no reason');
  });

  it('reads an override keyed with a version selector by its name', () => {
    const text = json({
      overrides: { 'foo@^1': { bar: '2' }, '@s/baz@2': '3' },
      '//overrides': [
        'foo: its 1.x pulls a bar with a known advisory.',
        '@s/baz: same reason as foo here.',
      ],
    });
    expect(packageFindings(text)).toEqual([]);
  });

  it('leaves out the packages something else chooses', () => {
    expect(
      packageFindings(json(pkg), new Set(['react', 'typescript', 'odd'])).map((f) => f.line),
    ).toEqual([18]);
  });

  it('finds nothing in a package.json with no pins', () => {
    expect(
      packageFindings(json({ name: 'x', dependencies: { a: '^1' }, devDependencies: { b: 7 } })),
    ).toEqual([]);
  });
});

describe('expoManaged', () => {
  it('is empty without Expo', () => {
    expect(expoManaged(checkout({}), { dependencies: { react: '19.2.3' } })).toEqual(new Set());
  });

  it("is what Expo's SDK chooses, and expo, less the app's excludes", () => {
    const root = checkout({
      'node_modules/expo/bundledNativeModules.json': json({
        react: '19.2.3',
        'expo-blur': '~57.0.3',
        async: '2.2.0',
      }),
    });
    const pkg = { dependencies: { expo: '~57.0.31' }, expo: { install: { exclude: ['async'] } } };
    expect(expoManaged(root, pkg)).toEqual(new Set(['expo', '@types/react', 'react', 'expo-blur']));
  });

  it('says to install first when the list is missing', () => {
    expect(() => expoManaged(checkout({}), { devDependencies: { expo: '~57' } })).toThrow(
      'run this after the install',
    );
  });
});

describe('dependabotFindings', () => {
  const text = `version: 2
updates:
  - package-ecosystem: npm
    # graphql 17 breaks Apollo Server's peer range;
    # delete this once Apollo accepts it.
    ignore:
      - dependency-name: graphql
        update-types: ["version-update:semver-major"]
  - package-ecosystem: npm
    ignore:
      - dependency-name: "loose"
      # Expo's SDK owns these versions; bump them in an SDK upgrade.
      - dependency-name: "expo"
        update-types: ["version-update:semver-major"]
      - dependency-name: expo-*
      # v1.2
      - dependency-name: also-loose
    groups:
      all:
        patterns: ["*"]
  - package-ecosystem: github-actions
    ignore: # majors only
      - dependency-name: "actions/x"
`;

  it('lists the ignore entries with no comment saying why above them', () => {
    expect(dependabotFindings(text, '.github/dependabot.yml')).toEqual([
      {
        file: '.github/dependabot.yml',
        line: 11,
        message: 'the ignore rule for loose has no reason: say why in a comment above it.',
      },
      expect.objectContaining({ line: 17, message: expect.stringContaining('also-loose') }),
      expect.objectContaining({ line: 23, message: expect.stringContaining('actions/x') }),
    ]);
  });

  it("reads an ignore list written at its key's own indent", () => {
    const flat = `updates:
  - package-ecosystem: npm
    ignore:
    - dependency-name: eslint
      versions: [">=10"]
    groups:
      all:
        patterns: ["*"]
`;
    expect(dependabotFindings(flat, 'd.yml').map((f) => f.line)).toEqual([4]);
  });

  it('lets one comment explain the entries below it, up to the next comment', () => {
    const group = `updates:
  - ignore:
      # Expo's SDK owns these versions; bump them in an SDK upgrade.
      - dependency-name: expo
      - dependency-name: expo-*
      - dependency-name: react-native
      # (unrelated)
      - dependency-name: appended-later
`;
    expect(dependabotFindings(group, 'd.yml').map((f) => f.line)).toEqual([8]);
  });
});

describe('isPinnedImage', () => {
  it('pins a version tag or a digest', () => {
    expect(isPinnedImage('rhysd/actionlint:1.7.12')).toBe(true);
    expect(isPinnedImage('node:24.1-alpine')).toBe(true);
    expect(isPinnedImage('ghcr.io/a/b@sha256:abc')).toBe(true);
  });

  it('leaves a major, a name or latest free', () => {
    expect(isPinnedImage('rhysd/actionlint:latest')).toBe(false);
    expect(isPinnedImage('node:24')).toBe(false);
    expect(isPinnedImage('localhost:5000/img')).toBe(false);
    expect(isPinnedImage('alpine')).toBe(false);
  });
});

describe('pinOnLine', () => {
  it.each([
    [
      '      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567',
      'actions/checkout is used at 0123456789abcdef0123456789abcdef01234567, below its major',
    ],
    [
      "        uses: 'peter-evans/create-pull-request@v7.0.11'",
      'peter-evans/create-pull-request is used at v7.0.11, below its major',
    ],
    ['  - uses: docker://alpine:3.20', 'the image alpine:3.20 is pinned to a version'],
    ['    image: postgres:16.4', 'the image postgres:16.4 is pinned to a version'],
    ['    container: node:24.11-alpine', 'the image node:24.11-alpine is pinned to a version'],
    [
      '        run: docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12 -color',
      'the image rhysd/actionlint:1.7.12 is pinned to a version',
    ],
    ['          node-version: 24.1.0', 'node-version holds 24.1.0, below its major'],
    ['        lycheeVersion: v0.24.2', 'lycheeVersion holds v0.24.2, below its major'],
    ['    default: "8.30.1"', 'default holds 8.30.1, below its major'],
  ])('finds %s', (line, message) => expect(pinOnLine(line)).toBe(message));

  it.each([
    '      - uses: actions/checkout@v7',
    '      - uses: jbhirsh/ci/review@main',
    '      - uses: ./.github/actions/local',
    '      - uses: docker://alpine:latest',
    '    image: node:24',
    '        run: docker run --rm -v "$PWD:/repo" rhysd/actionlint:latest',
    '          node-version: 24',
    '    default: latest',
    '    timeout-minutes: 1.5',
    '        run: echo 1.2.3',
  ])('leaves %s alone', (line) => expect(pinOnLine(line)).toBeNull());
});

describe('yamlFindings', () => {
  const text = `jobs:
  a:
    steps:
      - uses: a/one@0123456789abcdef0123456789abcdef01234567 # v2.9.0
      # The bot opens PRs as this release does; v8 drops the token input.
      - uses: a/two@v7.0.11
      - uses: a/three@v1.2.3 # pinned: v1.3 renamed the output we read
      # lychee by release, since run.mjs reads its JSON report.
      - name: Run
        if: true
        uses: a/four@v2.9.0
        with:
          lycheeVersion: v0.24.2
      - name: Free
        with:
          tool-version: 1.2.3
`;

  it('lists the pins with no reason on their line, above it or above their step', () => {
    expect(yamlFindings(text, 'w.yml')).toEqual([
      {
        file: 'w.yml',
        line: 4,
        message:
          'a/one is used at 0123456789abcdef0123456789abcdef01234567, below its major: follow the major, or say why in a comment beside it.',
      },
      expect.objectContaining({
        line: 16,
        message: expect.stringContaining('tool-version holds 1.2.3'),
      }),
    ]);
  });

  it("reads an input's default as a version only under an input named for one", () => {
    const action = `inputs:
  threshold:
    description: How close is close enough.
    default: '0.5'
  tool-version:
    description: Which release.
    default: 1.2.3
`;
    expect(yamlFindings(action, 'action.yml').map((f) => f.line)).toEqual([7]);
  });

  it('reads a commented-out line as no pin', () => {
    expect(yamlFindings('    # - uses: a/b@v1.2.3\n', 'w.yml')).toEqual([]);
  });
});

describe('yamlFiles', () => {
  it('finds the workflows and every action.yml, outside installed and built folders', () => {
    const root = checkout({
      '.github/workflows/ci.yml': '',
      '.github/workflows/notes.md': '',
      '.github/actions/x/action.yaml': '',
      '.github/dependabot.yml': '',
      'tool/action.yml': '',
      'tool/other.yml': '',
      'node_modules/a/action.yml': '',
      'ios/action.yml': '',
      '.hidden/action.yml': '',
    });
    expect(yamlFiles(root)).toEqual([
      '.github/actions/x/action.yaml',
      '.github/workflows/ci.yml',
      'tool/action.yml',
    ]);
  });
});

describe('findings and main', () => {
  const pinned = checkout({
    'package.json': json({ devDependencies: { typescript: '~6.0.2' } }),
    '.github/dependabot.yml': 'updates:\n  - ignore:\n      - dependency-name: x\n',
    '.github/workflows/ci.yml': 'steps:\n  - uses: a/b@v1.2.3\n',
    '.nvmrc': '24.1.0\n',
  });

  it('reads package.json, Dependabot, the workflows and the Node version', () => {
    expect(findings(pinned).map((f) => `${f.file}:${f.line}`)).toEqual([
      'package.json:3',
      '.github/dependabot.yml:3',
      '.github/workflows/ci.yml:2',
      '.nvmrc:1',
    ]);
  });

  it('prints each as an annotation in Actions and fails', () => {
    /** @type {string[]} */
    const out = [];
    expect(main(pinned, { log: (l) => out.push(l), actions: true })).toBe(1);
    expect(out[0]).toBe(
      '::error file=package.json,line=3::typescript ~6.0.2 holds it below its next major: use ^6.0.2, or say why in "//pins".',
    );
    expect(out.at(-1)).toBe('pins: 4 pinned without a reason (pins/check.mjs says what counts).');
  });

  it('passes a checkout with nothing pinned, printing file:line otherwise', () => {
    /** @type {string[]} */
    const out = [];
    expect(main(checkout({ '.nvmrc': '24\n' }), { log: (l) => out.push(l), actions: false })).toBe(
      0,
    );
    expect(out).toEqual(['pins: nothing is pinned without a reason.']);
    out.length = 0;
    main(pinned, { log: (l) => out.push(l), actions: false });
    expect(out[3]).toBe('.nvmrc:1: Node 24.1.0 is below its major: write the major alone.');
  });
});
