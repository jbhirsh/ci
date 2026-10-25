// The app a shared script runs for. Every script runs from the app's
// checkout (its working directory, or APP_ROOT when that's set, as the
// self-tests and local runs against a sibling checkout do), never from this
// repo, and this repo installs nothing at run time: a package a script needs
// (Prettier, Playwright) comes from the app's own node_modules, through
// importFromApp, so it's the version the app already tests with.
//
// Each app keeps its settings for the shared tooling in `.github/ci.json`,
// one top-level key per tool (`mutation`, `visuals`, `review`, …); each
// tool's module header says what its key holds.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The app's checkout: APP_ROOT if set, else the working directory. */
export function appRoot() {
  return path.resolve(process.env.APP_ROOT || process.cwd());
}

/**
 * Imports `name` from the app's node_modules, not this repo's.
 *
 * @param {string} name
 * @param {string} [root]
 * @returns {Promise<unknown>}
 */
export async function importFromApp(name, root = appRoot()) {
  const require = createRequire(path.join(root, 'package.json'));
  return import(pathToFileURL(require.resolve(name)).href);
}

/**
 * The app's settings for one tool: its key in `.github/ci.json`, or `{}` when
 * the file or the key is missing.
 *
 * @param {string} tool
 * @param {string} [root]
 * @returns {Record<string, unknown>}
 */
export function appConfig(tool, root = appRoot()) {
  let text;
  try {
    text = readFileSync(path.join(root, '.github', 'ci.json'), 'utf8');
  } catch {
    return {};
  }
  /** @type {unknown} */
  const parsed = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('.github/ci.json must hold an object');
  }
  const section = /** @type {Record<string, unknown>} */ (parsed)[tool];
  if (section === undefined) return {};
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new Error(`.github/ci.json: "${tool}" must be an object`);
  }
  return /** @type {Record<string, unknown>} */ (section);
}
