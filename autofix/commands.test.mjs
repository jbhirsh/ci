import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { testApp } from '../review/testApp.mjs';
import { appFacts, commandProblem, entryProblem } from './commands.mjs';

const CI = `name: CI
jobs:
  ci:
    steps:
      - name: Bundle size budget
        run: test 1 -lt 2
      - name: "Quoted step" # why
        run: true
`;

/** @type {import('./commands.mjs').AppFacts} */
const facts = {
  scripts: new Set(['lint', 'test', 'check']),
  bins: new Set(['vite', 'playwright']),
  makeTargets: new Set(['check']),
  read: (file) => (file === '.github/workflows/ci.yml' ? CI : null),
};

describe('appFacts', () => {
  it("reads the app's scripts, its lockfile's bins and its make targets", () => {
    const root = testApp({
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }),
      'package-lock.json': JSON.stringify({
        packages: {
          '': {},
          'node_modules/@playwright/test': { bin: { playwright: 'cli.js' } },
          'node_modules/tsx': { bin: 'dist/cli.mjs' },
        },
      }),
      Makefile: 'check: lint\n\tnpm run check\nX := 1\n',
    });
    const read = appFacts(root);
    expect([...read.scripts]).toEqual(['lint']);
    expect([...read.bins].sort()).toEqual(['playwright', 'tsx']);
    expect([...read.makeTargets]).toEqual(['check']);
    expect(read.read('Makefile')).toContain('check:');
    expect(read.read('missing')).toBeNull();
  });
  it('falls back to node_modules/.bin, and to nothing', () => {
    const root = testApp({ 'node_modules/.bin/eslint': '' });
    expect([...appFacts(root).bins]).toEqual(['eslint']);
    expect([...appFacts(testApp({})).bins]).toEqual([]);
  });
});

describe('commandProblem', () => {
  it('passes what the app can run', () => {
    for (const ok of [
      'npm run lint',
      'npm run -s check',
      'npm test',
      'npm ci',
      'npm audit --omit=dev --audit-level=high',
      'npx vite build',
      'npx --yes playwright test --project=phone',
      'npx expo-doctor@latest',
      'npx @scope/tool@1.2.3',
      'make check',
      'git diff --exit-code src/gql/',
      'test -z "$(git status --porcelain src/gql/)"',
    ]) {
      expect(commandProblem(ok, facts), ok).toBeNull();
    }
  });
  it('names what it cannot', () => {
    expect(commandProblem('npm run format:check', facts)).toBe(
      'package.json has no "format:check" script',
    );
    expect(commandProblem('npm install', facts)).toContain("isn't one of");
    expect(commandProblem('npx knip', facts)).toContain('"knip"');
    expect(commandProblem('make lint', facts)).toContain('"lint" target');
    expect(commandProblem('yarn lint', facts)).toContain('"yarn"');
    expect(commandProblem('npm test', { ...facts, scripts: new Set() })).toContain('"test"');
  });
});

describe('entryProblem', () => {
  it('checks every part of a command, ignoring the note after it', () => {
    expect(entryProblem('`npm run lint && git diff` (a note: `npm run nope`)', facts)).toBeNull();
    expect(entryProblem('`npm run lint && npm run nope`', facts)).toContain('"nope"');
  });
  it("checks a step entry against the workflow's step names", () => {
    expect(
      entryProblem('the "Bundle size budget" step of `.github/workflows/ci.yml` (copy)', facts),
    ).toBeNull();
    expect(entryProblem('the "Quoted step" step of `.github/workflows/ci.yml`', facts)).toBeNull();
    expect(entryProblem('the "Nope" step of `.github/workflows/ci.yml`', facts)).toContain(
      'no step named "Nope"',
    );
    expect(entryProblem('the "X" step of `.github/workflows/gone.yml`', facts)).toContain(
      "doesn't exist",
    );
  });
  it('fails an entry in neither form', () => {
    expect(entryProblem('run the linter', facts)).toContain('must start with');
  });
  it('never throws, whatever the entry says', () => {
    fc.assert(
      fc.property(fc.string(), (entry) => {
        const problem = entryProblem(entry, facts);
        expect(problem === null || typeof problem === 'string').toBe(true);
      }),
    );
  });
  it('passes `npm run <script>` for every script the app has', () => {
    const script = fc.stringMatching(/^[a-z][a-z0-9:_-]{0,15}$/);
    fc.assert(
      fc.property(fc.array(script, { minLength: 1 }), (scripts) => {
        const app = { ...facts, scripts: new Set(scripts) };
        for (const s of scripts) expect(entryProblem(`\`npm run ${s}\``, app)).toBeNull();
      }),
    );
  });
});
