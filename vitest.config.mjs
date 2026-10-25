import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.mjs'],
    exclude: ['node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['**/*.mjs'],
      exclude: ['**/*.test.mjs', '*.config.*', 'node_modules/**', 'coverage/**'],
      // Every file on its own, as in the apps.
      thresholds: { perFile: true, lines: 80 },
    },
  },
});
