import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPARE_COMMAND, checkVerify, jobsOf, runsAsJob } from './verify-check.mjs';

const E2E = `name: E2E
on:
  pull_request:
jobs:
  e2e:
    name: E2E Tests (Playwright)   # the required check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: npm ci
      - name: Install browsers
        run: npx playwright install --with-deps webkit
      - name: Notes
        run: |
          echo one
          echo two
      - name: Run Playwright tests
        run: 'npm run test:e2e'
  reports:
    needs: e2e
    uses: jbhirsh/ci/.github/workflows/job-reports.yml@main
`;

const SIFT = `jobs:
  visual:
    name: "Visual regression"
    steps:
    - uses: actions/checkout@v7
    - uses: jbhirsh/ci/visual-baselines/compare@main
      with:
        fresh: screenshots
  plain:
    steps:
      - run: >-
          folded
          text
      - run: make check
`;

describe('jobsOf', () => {
  it("reads each job's id, name, run steps and uses", () => {
    expect(jobsOf(E2E)).toEqual([
      {
        id: 'e2e',
        name: 'E2E Tests (Playwright)',
        runs: [
          'npm ci',
          'npx playwright install --with-deps webkit',
          'echo one\necho two',
          'npm run test:e2e',
        ],
        uses: ['actions/checkout@v7'],
      },
      {
        id: 'reports',
        name: undefined,
        runs: [],
        // A reusable workflow's `uses:` is the job's, not a step's.
        uses: [],
      },
    ]);
  });

  it('reads steps listed at the key’s own indent, quoted names and block scalars', () => {
    expect(jobsOf(SIFT)).toEqual([
      {
        id: 'visual',
        name: 'Visual regression',
        runs: [],
        uses: ['actions/checkout@v7', 'jbhirsh/ci/visual-baselines/compare@main'],
      },
      { id: 'plain', name: undefined, runs: ['folded\ntext', 'make check'], uses: [] },
    ]);
  });

  it('finds no jobs in a workflow without them', () => {
    expect(jobsOf('name: x\non: push\n')).toEqual([]);
    expect(jobsOf('jobs:\n')).toEqual([]);
  });
});

describe('runsAsJob', () => {
  const [job] = jobsOf(E2E);
  it.each([
    ['npm run test:e2e', true],
    ['npx playwright install --with-deps webkit && npm run test:e2e', true],
    ['npx playwright install --with-deps webkit&&npm run test:e2e', true],
    ['npm ci && npx playwright install --with-deps webkit && npm run test:e2e', true],
    // A step left out, or the job stopped short of its last.
    ['npm ci && npm run test:e2e', false],
    ['npx playwright install --with-deps webkit', false],
    ['npm run test:e2e && npx playwright install --with-deps webkit', false],
    ['npm run test:e2e -- --project=visual', false],
    ['npm run test:e2e && ', false],
    ['node compare.mjs', false],
  ])('%s: %s', (command, ok) => {
    expect(runsAsJob(job, command)).toBe(ok);
  });

  it('takes only COMPARE_COMMAND for a job comparing through the compare action', () => {
    const [visual] = jobsOf(SIFT);
    expect(runsAsJob(visual, COMPARE_COMMAND)).toBe(true);
    // Without its out dir, compare.mjs stops at its usage.
    expect(
      runsAsJob(visual, 'node "$VISUAL_BASELINES_TOOLS/compare.mjs" "$VISUAL_BASELINES_FRESH"'),
    ).toBe(false);
    expect(runsAsJob(visual, 'npm test')).toBe(false);
  });
});

describe('checkVerify', () => {
  /** @param {Record<string, string>} files */
  function app(files) {
    const root = mkdtempSync(path.join(tmpdir(), 'verify-'));
    mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(path.join(root, '.github/workflows', name), text);
    }
    return root;
  }

  it("passes the job's own command, naming its workflow", () => {
    expect(
      checkVerify(app({ 'e2e.yml': E2E, 'notes.txt': 'x' }), {
        check: 'E2E Tests (Playwright)',
        command: 'npx playwright install --with-deps webkit && npm run test:e2e',
      }),
    ).toBe(
      "visual-baselines: verify runs E2E Tests (Playwright)'s `npx playwright install --with-deps webkit && npm run test:e2e` (e2e.yml).",
    );
    // A job with no name goes by its id.
    expect(
      checkVerify(app({ 'sift.yaml': SIFT }), { check: 'plain', command: 'make check' }),
    ).toMatch(/sift\.yaml/);
  });

  it('refuses a command the job does not run, saying what it does', () => {
    expect(() =>
      checkVerify(app({ 'e2e.yml': E2E }), {
        check: 'E2E Tests (Playwright)',
        command: "npx playwright test --project='visual-*'",
      }),
    ).toThrow(
      /isn't what E2E Tests \(Playwright\) runs \(e2e\.yml: npm ci \/ npx playwright install --with-deps webkit/,
    );
    expect(() =>
      checkVerify(app({ 'e2e.yml': 'jobs:\n  x:\n    name: X\n' }), { check: 'X', command: 'y' }),
    ).toThrow(/x\.yml: no run steps|e2e\.yml: no run steps/);
  });

  it('refuses a check no job is named', () => {
    expect(() => checkVerify(app({ 'e2e.yml': E2E }), { check: 'Nope', command: 'x' })).toThrow(
      'visual-baselines.verify.check: no job in .github/workflows is named Nope',
    );
    expect(() =>
      checkVerify(mkdtempSync(path.join(tmpdir(), 'none-')), { check: 'Nope', command: 'x' }),
    ).toThrow(/no job/);
  });
});
