// Test data for audit/'s tests: a throwaway app checkout, and the three
// apps' knip configs from their main before jbhirsh/ci#34 removed what they
// ignored. Not part of the tool.
//
// Git runs with no GIT_* variable from outside, as a hook's GIT_DIR would
// point it at this repository, and without the user's config
// (mutation/test-repo.mjs says more). Unlike that module's `repo`, an app
// here links only TypeScript 6's API as its `typescript`, as the apps alias
// it: this repo's own `typescript` is TypeScript 7, which has none.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFiles } from '../mutation/test-repo.mjs';

/** This repo's TypeScript 6, its JavaScript API, as an app installs it. */
const TYPESCRIPT = path.dirname(
  createRequire(import.meta.url).resolve('@typescript/typescript6/package.json'),
);

/** @type {string[]} */
const made = [];

/** Removes every app `app` made. */
export function cleanApps() {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * A git checkout holding these files, staged, with `typescript` installed
 * (TypeScript 6's API, as the apps alias it).
 *
 * @param {Record<string, string>} files
 */
export function app(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'audit-app-'));
  made.push(root);
  writeFiles(root, files);
  mkdirSync(path.join(root, 'node_modules'));
  symlinkSync(TYPESCRIPT, path.join(root, 'node_modules', 'typescript'));
  writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const args of [
    ['init', '-q'],
    ['add', '.'],
  ]) {
    execFileSync('git', args, { cwd: root, env, stdio: 'ignore' });
  }
  return root;
}

/** The three apps' knip configs as their main stood before jbhirsh/ci#34, verbatim. */
export const APP_CONFIGS = {
  'BoardGames.knip.jsonc': `{
  // Dead code for the weekly audit (weekly-audit.yml): files nothing
  // reaches, exports nothing imports, dependencies nothing uses. Its plugins
  // find most entry points (Vite, Vitest, Playwright, the package scripts,
  // the workflows); these are the ones they can't see.
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": [
    // Vercel Functions (a file starting \`_\` is a module, not a function).
    "api/[^_]*.ts",
    // Run as a child process by extract-rules-text.mjs.
    "scripts/ocr-pdfs.mjs",
    // Scenarios passed to \`npm run pr-gif\` on the command line, and the
    // setup module .github/ci.json names: jbhirsh/ci's GIF tool loads them.
    "scripts/gif-scenarios/*.ts",
    "scripts/gif-setup.ts",
    // The README's screenshots, a Playwright project only when README_SHOTS is set.
    "e2e/readme.shots.ts",
  ],
  // e2e/theme.spec.ts loads axe's browser build by path
  // (createRequire().resolve), which knip doesn't follow. jbhirsh/ci's
  // actions run the rest from this repo's node_modules: the weekly audit's
  // jscpd, and the README screenshot comparison's pixelmatch and pngjs.
  "ignoreDependencies": ["axe-core", "jscpd", "pixelmatch", "pngjs"],
}
`,
  'fog-and-frontier.knip.json': `{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": ["scripts/gif-scenarios/*.ts", "scripts/gif-setup.ts"],
  "ignoreDependencies": ["jscpd", "pixelmatch", "pngjs"]
}
`,
  'sift.knip.jsonc': `{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  // Command-line tools run by hand or by workflows, not imported by anything.
  "entry": ["scripts/*.mjs"],
  // Autolinked as a native module (package.json "expo.autolinking"), and
  // loaded with require() by path, never imported by its package name.
  // expo-system-ui: Expo needs it for app.json's userInterfaceStyle on
  // Android only, and Sift is iOS-only (CLAUDE.md, "App Identity").
  // jscpd, pixelmatch, pngjs: run by jbhirsh/ci's actions from this repo's
  // node_modules (the weekly audit's jscpd; the README screenshot
  // comparison's pixelmatch and pngjs).
  "ignoreDependencies": ["expo-musickit", "expo-system-ui", "jscpd", "pixelmatch", "pngjs"],
  // The native module's wrappers are required by path as one object
  // (AppleMusicProvider, useResolvedArtwork), which knip can't follow; the
  // native bridge check (scripts/check-native-bridge.mjs) holds them to the
  // Swift module instead.
  "ignoreIssues": {
    "modules/expo-musickit/src/index.ts": ["exports", "types"],
  },
}
`,
};
