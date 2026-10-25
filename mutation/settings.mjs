// The app's settings for mutation testing: the `mutation` key of its
// `.github/ci.json`, each one optional, and the Stryker config they point at.
// Every key is checked here (an unknown one is refused, so a typo can't
// silently fall back to a default):
//
//   strykerConfig      The Stryker config file (default `stryker.config.json`).
//                      Its `mutate` globs are the one list of what is
//                      mutated: a PR's scope and the sweep's shards both read
//                      them, so neither can drift from it.
//   wiring             Globs of the files Stryker's own setup rests on,
//                      besides the Stryker config and `.github/ci.json`,
//                      which always count (default: `package.json`,
//                      `package-lock.json`, `patches/**` and
//                      `.github/workflows/mutation.yml`). A PR with nothing to
//                      mutate that changes one of them runs the smoke scope,
//                      so a broken setup still shows at PR time; list the
//                      test runner's config and the setup files it loads.
//   smoke              The smoke scope: a few small files the `mutate` globs
//                      take (default none, so such a PR skips Stryker too).
//   testSubjects       Whether a changed test file stands for the source it
//                      covers (`x.test.ts` or `__tests__/x.test.ts` beside
//                      `x.ts`), mutated whole, so a PR that only weakens a
//                      test is still tested against that code (default true).
//   formatCheck        Whether a file whose change is formatting alone, by
//                      the app's Prettier, is left out (default true).
//   perFileThreshold   A score every mutated file must reach on its own, on
//                      the lines the run mutated (null, the default, for no
//                      per-file gate: Stryker's `thresholds.break` alone).
//                      Needs the `json` reporter in the Stryker config.
//   nodeOptions        NODE_OPTIONS for Stryker's runs (default none).
//   install            The command that installs the app (default `npm ci`).
//   cache.prefix       The incremental results' cache key prefix (default
//                      `stryker-incremental`): `<prefix>-pr-<n>-…` per PR,
//                      `<prefix>-main-…` for main's baseline.
//   cache.restoreMain  Whether a PR's first run starts from main's baseline
//                      (the last sweep or merge) when the PR has no results
//                      of its own yet (default true).
//   cache.restartOn    Globs of files every result depends on that Stryker's
//                      change detection can't see (default none): their hash
//                      joins a PR's cache key, so a change to one starts the
//                      PR over.
//   push.timeoutMinutes  How long a push to main's incremental run may take
//                      before it stops as a pass (default 170).
//   sweep.shards       How many shards the monthly sweep splits into
//                      (default 8).
//   sweep.timeoutMinutes  Each shard job's limit (default 180).
//
// `node settings.mjs` writes them as step outputs for the composite actions.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { appConfig, appRoot } from '../lib/app.mjs';
import { isRecord, readText } from './report.mjs';

/**
 * @typedef {{
 *   strykerConfig: string,
 *   wiring: string[],
 *   smoke: string[],
 *   testSubjects: boolean,
 *   formatCheck: boolean,
 *   perFileThreshold: number | null,
 *   nodeOptions: string,
 *   install: string,
 *   cache: { prefix: string, restoreMain: boolean, restartOn: string[] },
 *   push: { timeoutMinutes: number },
 *   sweep: { shards: number, timeoutMinutes: number },
 * }} Settings
 */

/** @returns {Settings} */
export function defaults() {
  return {
    strykerConfig: 'stryker.config.json',
    wiring: ['package.json', 'package-lock.json', 'patches/**', '.github/workflows/mutation.yml'],
    smoke: [],
    testSubjects: true,
    formatCheck: true,
    perFileThreshold: null,
    nodeOptions: '',
    install: 'npm ci',
    cache: { prefix: 'stryker-incremental', restoreMain: true, restartOn: [] },
    push: { timeoutMinutes: 170 },
    sweep: { shards: 8, timeoutMinutes: 180 },
  };
}

/** @param {unknown} value */
const isStrings = (value) => Array.isArray(value) && value.every((v) => typeof v === 'string');
/** @param {unknown} value */
const isPositive = (value) => Number.isInteger(value) && Number(value) > 0;

/**
 * Checks one section's keys against the defaults' types, returning the merged
 * section. Throws naming the key on anything unknown or mistyped.
 *
 * @template {Record<string, unknown>} T
 * @param {Record<string, unknown>} given
 * @param {T} base
 * @param {string} where
 * @returns {T}
 */
function merge(given, base, where) {
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [key, value] of Object.entries(given)) {
    const name = `${where}${key}`;
    if (!(key in base)) throw new Error(`mutation: unknown setting "${name}"`);
    const fallback = base[key];
    if (key === 'perFileThreshold') {
      if (value !== null && !(typeof value === 'number' && value >= 0 && value <= 100)) {
        throw new Error(`mutation: "${name}" must be a score from 0 to 100, or null`);
      }
    } else if (Array.isArray(fallback)) {
      if (!isStrings(value)) throw new Error(`mutation: "${name}" must be a list of strings`);
    } else if (typeof fallback === 'number') {
      if (!isPositive(value)) throw new Error(`mutation: "${name}" must be a positive integer`);
    } else if (isRecord(fallback)) {
      if (!isRecord(value)) throw new Error(`mutation: "${name}" must be an object`);
      out[key] = merge(value, fallback, `${name}.`);
      continue;
    } else if (typeof value !== typeof fallback) {
      throw new Error(`mutation: "${name}" must be a ${typeof fallback}`);
    }
    out[key] = value;
  }
  return /** @type {T} */ (out);
}

/**
 * The app's settings: its `mutation` section over the defaults.
 *
 * @param {Record<string, unknown>} section
 * @returns {Settings}
 */
export function parseSettings(section) {
  return merge(section, defaults(), '');
}

/**
 * The app's settings, read from its checkout.
 *
 * @param {string} [root]
 * @returns {Settings}
 */
export function readSettings(root = appRoot()) {
  return parseSettings(appConfig('mutation', root));
}

/**
 * The files Stryker's setup rests on: the settings' list, plus the Stryker
 * config and `.github/ci.json`, which always count.
 *
 * @param {Settings} settings
 */
export function wiringGlobs(settings) {
  return [settings.strykerConfig, '.github/ci.json', ...settings.wiring];
}

/**
 * @typedef {{ mutate: string[], thresholds: Record<string, unknown>,
 *   reporters: string[], raw: Record<string, unknown> }} StrykerConfig
 */

/**
 * A Stryker config's text, checked for what the scripts read: a `mutate`
 * list of globs, and the thresholds and reporters when present.
 *
 * @param {string | null} text
 * @param {string} [name]
 * @returns {StrykerConfig}
 */
export function parseStrykerConfig(text, name = 'stryker.config.json') {
  if (text === null) throw new Error(`${name} not found`);
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${name} is not JSON`);
  }
  if (!isRecord(raw)) throw new Error(`${name} must hold an object`);
  if (!isStrings(raw.mutate)) throw new Error(`${name} has no mutate list`);
  const thresholds = isRecord(raw.thresholds) ? raw.thresholds : {};
  const reporters = isStrings(raw.reporters) ? raw.reporters : [];
  return {
    mutate: /** @type {string[]} */ (raw.mutate),
    thresholds,
    reporters: /** @type {string[]} */ (reporters),
    raw,
  };
}

/**
 * The app's Stryker config.
 *
 * @param {Settings} settings
 * @param {string} [root]
 */
export function readStrykerConfig(settings, root = appRoot()) {
  return parseStrykerConfig(
    readText(path.join(root, settings.strykerConfig)),
    settings.strykerConfig,
  );
}

/**
 * Stryker's `thresholds.break`, or null when it has none.
 *
 * @param {StrykerConfig} config
 */
export function breakThreshold(config) {
  const value = config.thresholds.break;
  return typeof value === 'number' ? value : null;
}

/**
 * Writes the settings the composite actions' steps read as outputs.
 *
 * @param {string} [root]
 */
export function main(root = appRoot()) {
  const settings = readSettings(root);
  setOutput('stryker-config', settings.strykerConfig);
  setOutput('node-options', settings.nodeOptions);
  setOutput('install', settings.install);
  setOutput('per-file-threshold', String(settings.perFileThreshold ?? ''));
  setOutput('cache-prefix', settings.cache.prefix);
  setOutput('restore-main', String(settings.cache.restoreMain));
  setOutput('push-timeout-minutes', String(settings.push.timeoutMinutes));
  setOutput('sweep-shards', String(settings.sweep.shards));
  setOutput('sweep-timeout-minutes', String(settings.sweep.timeoutMinutes));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
