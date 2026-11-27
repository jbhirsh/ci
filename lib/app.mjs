// The app a shared script runs for. Every script runs from the app's
// checkout (its working directory, or APP_ROOT when that's set, as the
// self-tests and local runs against a sibling checkout do), never from this
// repo. A package the app runs itself (Prettier, Playwright, knip) comes
// from the app's own node_modules, through importFromApp (requireFromApp
// for a synchronous caller), so it's the version the app already tests
// with; a library only this repo's code imports (pixelmatch, pngjs) is this
// repo's `dependencies`, installed by the action that needs it
// (lib/pixels.mjs). A tool that installs one of the app's packages on its
// own, without the rest, reads the version the app's lockfile pins
// (appPackageVersion), so it runs the release the app tests with.
//
// Each app keeps its settings for the shared tooling in `.github/ci.json`,
// one top-level key per tool (`mutation`, `review`, `gif`, …); each
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
 * Requires `name` from the app's node_modules, for a CommonJS package a
 * synchronous caller needs (TypeScript's API).
 *
 * @param {string} name
 * @param {string} [root]
 * @returns {unknown}
 */
export function requireFromApp(name, root = appRoot()) {
  return createRequire(path.join(root, 'package.json'))(name);
}

/** Where an app keeps its settings, relative to its checkout. */
export const SETTINGS_FILE = '.github/ci.json';

/**
 * The app's whole `.github/ci.json`, or `{}` when it has none.
 *
 * @param {string} [root]
 * @returns {Record<string, unknown>}
 */
export function appSettings(root = appRoot()) {
  let text;
  try {
    text = readFileSync(path.join(root, SETTINGS_FILE), 'utf8');
  } catch {
    return {};
  }
  /** @type {unknown} */
  const parsed = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${SETTINGS_FILE} must hold an object`);
  }
  return /** @type {Record<string, unknown>} */ (parsed);
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
  const section = appSettings(root)[tool];
  if (section === undefined) return {};
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new Error(`${SETTINGS_FILE}: "${tool}" must be an object`);
  }
  return /** @type {Record<string, unknown>} */ (section);
}

/**
 * The app's Playwright: `@playwright/test`, or else `playwright`, from the
 * node_modules at `root` (the app's, or a folder that holds only Playwright,
 * as the probe installs it).
 *
 * @param {string} root
 * @returns {Promise<typeof import('playwright')>}
 */
export async function appPlaywright(root) {
  /** @type {unknown} */
  let module;
  try {
    module = await importFromApp('@playwright/test', root);
  } catch {
    module = await importFromApp('playwright', root);
  }
  // Resolved as CommonJS, its exports come as the default export (Playwright
  // Test's is a function, `test`, carrying the rest).
  const { default: cjs } = /** @type {{ default?: unknown }} */ (module);
  return /** @type {typeof import('playwright')} */ (
    (typeof cjs === 'object' || typeof cjs === 'function') && cjs !== null && 'webkit' in cjs
      ? cjs
      : module
  );
}

/** The app's npm lockfile, relative to its checkout. */
export const LOCKFILE = 'package-lock.json';

/** A version npm can install as it stands: a release, not a range or a URL. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The version of `name` a parsed npm lockfile (lockfileVersion 2 or 3, its
 * `packages` map) pins at the top of node_modules. Throws, naming the file,
 * when it pins none, or something that isn't a plain release.
 *
 * @param {unknown} lock
 * @param {string} name
 * @returns {string}
 */
export function lockedVersion(lock, name) {
  const packages =
    typeof lock === 'object' && lock !== null && 'packages' in lock ? lock.packages : undefined;
  const entry =
    typeof packages === 'object' && packages !== null
      ? /** @type {Record<string, unknown>} */ (packages)[`node_modules/${name}`]
      : undefined;
  const version =
    typeof entry === 'object' && entry !== null && 'version' in entry ? entry.version : undefined;
  if (version === undefined) throw new Error(`${LOCKFILE} pins no version of ${name}`);
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error(`${LOCKFILE}: ${name}'s version must be a release, such as 1.2.3`);
  }
  return version;
}

/**
 * The version of `name` the app's lockfile pins, so a tool can install that
 * one release without the app's other packages (the probe's Playwright).
 * Throws, naming the file, when it has none, or pins none.
 *
 * @param {string} root
 * @param {string} name
 * @returns {string}
 */
export function appPackageVersion(root, name) {
  let text;
  try {
    text = readFileSync(path.join(root, LOCKFILE), 'utf8');
  } catch {
    throw new Error(`no ${LOCKFILE}: the app's lockfile pins its packages' versions`);
  }
  /** @type {unknown} */
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    throw new Error(`${LOCKFILE} isn't JSON`);
  }
  return lockedVersion(lock, name);
}
