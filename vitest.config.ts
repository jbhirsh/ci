import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    // .stryker-tmp holds Stryker's sandbox copies of the repo, left behind by
    // an interrupted run: they are not this checkout's tests.
    exclude: ['node_modules/**', '.stryker-tmp/**'],
    // A test never writes to the runner's own summary or outputs: on CI a
    // tool's test (a compare action's, say) would otherwise put its
    // made-up result on the run's page. A test that checks them points
    // them at a file of its own.
    env: { GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' },
    // Each test file's temporary directories in one of its own, removed when
    // the file ends: Stryker reruns the tests for every mutant, and what they
    // left in /tmp filled the disk (lib/test-tmpdir.ts).
    setupFiles: ['lib/test-tmpdir.ts'],
    // A hang limit, never the success path. Vitest's 5 s default is far above
    // what these tests need on a quiet machine (the slowest git-driven ones take
    // well under a second) but not on a starved runner: in ci#127's run, tests
    // that start real processes ran 15-140x slower than usual, ~250 ms a
    // process start against ~7 ms, and two of them hit 5 s while the suite as a
    // whole was fine. A test that really hangs still ends here.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['**/*.ts'],
      exclude: ['**/*.test.ts', '*.config.*', 'node_modules/**', 'coverage/**', '.stryker-tmp/**'],
      // Every file on its own, as in the apps.
      thresholds: { perFile: true, lines: 80 },
    },
  },
});
