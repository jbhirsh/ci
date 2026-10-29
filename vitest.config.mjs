import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.mjs'],
    exclude: ['node_modules/**'],
    // A test never writes to the runner's own summary or outputs: on CI a
    // tool's test (visual-baselines' compare, say) would otherwise put its
    // made-up result on the run's page. A test that checks them points
    // them at a file of its own.
    env: { GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' },
    coverage: {
      provider: 'v8',
      include: ['**/*.mjs'],
      exclude: ['**/*.test.mjs', '*.config.*', 'node_modules/**', 'coverage/**'],
      // Every file on its own, as in the apps.
      thresholds: { perFile: true, lines: 80 },
    },
  },
});
