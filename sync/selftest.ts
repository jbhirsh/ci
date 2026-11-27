// Self-test of the sync manifest against an app's checkout:
// `node sync/selftest.ts <app dir>`. It fails on a manifest error, and on
// the app's own state only where the sync could not put a file there; never
// on a difference. An app whose files differ from this repo's is the sync's
// whole job, and a change here must not turn its CI red. What it checks:
//
//   - this repo's manifest loads (manifest.ts says what that holds);
//   - the app's `.github/ci.json`, when it has one, is a JSON object, and every
//     companion the manifest would set in it can be (no key on its way is held
//     by something that isn't an object);
//   - each synced path is a regular file or absent, and no folder on its way
//     is a link or a file, where the sync could not write it.
//
// For a named app it then prints what the next sync would change there (the
// dry run's report, plan.ts), as information: a difference never fails it.
//
// The last two are the app's state, not the manifest's, and failing on them is
// deliberate: the sync would otherwise fail in the app's PR, later and harder
// to read. Only the entries that name the app are checked when it is known:
// APP_NAME, else the repository's own name in GITHUB_REPOSITORY (an app's own
// CI). CI's "Against <app>" jobs run in this repo, where that is no app's name,
// so they pass APP_NAME; run by hand without either, every entry is checked.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appSettings, SETTINGS_FILE } from '../lib/app.mjs';
import {
  APPS,
  CI_ROOT,
  companionProblem,
  loadManifest,
  lstatOrNull,
  resolve,
} from './manifest.ts';
import { changesFor, report } from './plan.ts';

/** @typedef {import('./manifest.ts').Manifest} Manifest */

/**
 * The app the self-test is for, or undefined when none is named.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
export function appName(env = process.env) {
  if (env.APP_NAME) {
    if (!APPS.includes(env.APP_NAME)) {
      throw new Error(`APP_NAME "${env.APP_NAME}" is not one of ${APPS.join(', ')}`);
    }
    return env.APP_NAME;
  }
  const repo = env.GITHUB_REPOSITORY?.split('/')[1];
  return repo && APPS.includes(repo) ? repo : undefined;
}

/**
 * Why a synced path can't be written in the app, or null: a link or a file on
 * the way where a folder belongs, or something that isn't a regular file at
 * the path itself. What is absent is fine: the sync makes it.
 *
 * @param {string} root the app's checkout
 * @param {string} file a synced path, relative to it
 * @returns {string | null}
 */
function pathProblem(root, file) {
  const segments = file.split('/');
  for (let i = 1; i <= segments.length; i++) {
    const at = segments.slice(0, i).join('/');
    const found = lstatOrNull(path.join(root, at));
    if (!found) return null;
    if (i < segments.length) {
      if (found.isSymbolicLink()) return `${at} is a link in the app, on the way to ${file}`;
      if (!found.isDirectory()) return `${at} is a file in the app, on the way to ${file}`;
    } else if (!found.isFile()) {
      return `${file} is not a regular file in the app`;
    }
  }
  return null;
}

/**
 * The app's `.github/ci.json`, with its file name on a JSON error.
 *
 * @param {string} root
 * @returns {Record<string, unknown>}
 */
function settingsOf(root) {
  try {
    return appSettings(root);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`${SETTINGS_FILE} is not JSON: ${error.message}`, { cause: error });
  }
}

/**
 * @param {string} root the app's checkout
 * @param {string} [app] the app it is, when known
 * @param {Manifest} [manifest] this repo's manifest, unless a test brings its own
 * @param {string} [ciRoot] the checkout its sources are read from
 * @returns {string[]} what to print; throws on the first problem
 */
export function selftest(root, app, manifest = loadManifest(), ciRoot = CI_ROOT) {
  const files = app ? resolve(manifest, app) : manifest.files;
  const settings = settingsOf(root);
  const problems = files.flatMap(({ path: file, companions }) => [
    pathProblem(root, file),
    ...companions.map(({ key }) => companionProblem(settings, key)),
  ]);
  const found = [...new Set(problems.filter((problem) => problem !== null))];
  if (found.length > 0) throw new Error(found.join('; '));
  if (!app) {
    return [`sync: ${files.length} synced files (no app named, so every entry) fit this checkout.`];
  }
  /** @param {string} file */
  const readApp = (file) =>
    lstatOrNull(path.join(root, file))?.isFile() ? readFileSync(path.join(root, file)) : null;
  const changes = changesFor(
    resolve(manifest, app),
    (source) => readFileSync(path.join(ciRoot, source)),
    readApp,
    settings,
  );
  return [
    `sync: ${app} holds ${files.length} synced files; they fit this checkout.`,
    ...report(app, changes, 'HEAD').map((line) => `sync: ${line}`),
  ];
}

/**
 * Runs the self-test on the app at `argv[0]` and returns the exit code.
 *
 * @param {string[]} argv
 * @param {(line: string) => void} [log]
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function cli(argv, log = console.log, env = process.env) {
  try {
    for (const line of selftest(path.resolve(argv[0] ?? '.'), appName(env))) log(line);
    return 0;
  } catch (error) {
    log(`sync self-test failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cli(process.argv.slice(2));
}
