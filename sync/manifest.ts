// The manifest of files every app holds in step with this repo (ci#109):
// `sync/manifest.json`, read and held to its rules here. The sync (a later
// change) opens one PR per app with the files that differ; this module only
// says which files those are, and refuses a manifest that could make that
// PR wrong. It reads nothing from an app.
//
//   {
//     "files": [
//       {
//         "path": ".github/workflows/pr-changes.yml",   in the app
//         "source": ".github/workflows/pr-changes.yml", in this repo
//         "apps": ["BoardGames", "fog-and-frontier", "sift"],
//         "variants": { "sift": { "source": "…", "why": "…" } },   optional
//         "companions": [ { "key": ["autofix", "exempt", "PR changes"], "value": "…" } ]
//       }
//     ],
//     "unsynced": [ { "source": "gif/callers/pr-gif.yml", "why": "…" } ]
//   }
//
// - A file is held in step in each app of its `apps`, byte for byte, from its
//   `source`. A **variant** is a legitimate difference for one app: a whole
//   file in this repo, with the `why` the sync prints. It must be one of the
//   file's apps, and must differ from the canonical `source`, or it is no
//   difference. A difference exists only here: an app can't declare its own.
// - A **companion** is a key the file needs in the app's `.github/ci.json`
//   (an `autofix.exempt` entry for a workflow that runs on `pull_request`),
//   as a path of keys and a string. The sync sets it only when it adds the
//   file, and never overwrites a key the app already holds. Here it is only
//   checked: segments that name no object member and a value that is a string.
// - **unsynced** lists every canonical caller (`<tool>/callers/*.yml`) and
//   reusable workflow (`workflow_call`) in this repo that no file above
//   carries, each with the reason the apps hold no copy of it yet. The
//   coverage test fails one that is neither synced nor listed, so adding a
//   tool means its canonical caller plus one line here.
// - Removing an entry never deletes an app's file: the sync only adds and
//   updates.
//
// Every path is relative to its root (the app's, or this repo's), written
// with `/`, with no empty, `.` or `..` segment and no control or invisible
// formatting character (a bidirectional override could make a path read as
// another), so no entry can point outside a checkout. Also refused: a path
// under `.git` (any case: a write there is not a change anyone reviews), two
// entries whose paths differ only by case (one file on a case-insensitive
// disk), and a path that is a folder another entry's path is inside. The
// app's `.github/ci.json` is never a synced path: it is the app's own
// settings, and companions are the one way the sync touches it. A path may be
// anywhere else, not only under `.github/`: a shared tool's file can live
// beside the code, and the PR the sync opens meets the app's required checks
// like any other.

import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_FILE } from '../lib/app.ts';

export type Companion = { key: string[]; value: string };
export type Variant = { source: string; why: string };
export type Entry = {
  /** where the app holds it */
  path: string;
  /** where this repo holds it */
  source: string;
  apps: string[];
  /** by app */
  variants: Record<string, Variant>;
  companions: Companion[];
};
export type Unsynced = { source: string; why: string };
export type Manifest = { files: Entry[]; unsynced: Unsynced[] };
export type Resolved = {
  path: string;
  source: string;
  why: string | undefined;
  companions: Companion[];
};

/**
 * The apps that hold synced files: a copy of the apps in ci.yml's `Against`
 * matrix (a YAML list a script can't import), which a test holds equal.
 */
export const APPS = ['BoardGames', 'fog-and-frontier', 'sift'];

/** This repo's checkout. */
export const CI_ROOT = fileURLToPath(new URL('..', import.meta.url));

const MANIFEST = 'sync/manifest.json';
/** Keys that would reach an object's prototype when a companion is set. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * What is wrong with a manifest path, or null: it must be relative, written
 * with `/`, and made of ordinary segments.
 */
export function pathProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return 'must be a non-empty string';
  if (value.includes('\\')) return 'must be written with "/" only';
  if (/[\p{Cc}\p{Cf}]/u.test(value))
    return 'must have no control or invisible formatting character';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return 'must be relative';
  const segments = value.split('/');
  if (segments.some((segment) => ['', '.', '..'].includes(segment))) {
    return 'must have no empty, "." or ".." segment';
  }
  if (segments[0].toLowerCase() === '.git') return 'must not be under .git';
  return null;
}

/**
 * Pushes a problem for each key of `value` that isn't in `known`, so a typo
 * (`variant`) is refused rather than ignored.
 */
function unknownKeys(
  value: Record<string, unknown>,
  known: string[],
  at: string,
  problems: string[],
) {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) problems.push(`${at}: unknown key "${key}"`);
  }
}

/**
 * @returns whether it is a valid path
 */
function checkPath(value: unknown, at: string, problems: string[]): boolean {
  const problem = pathProblem(value);
  if (problem) problems.push(`${at} ${problem}`);
  return problem === null;
}

/**
 * @param value
 * @param at
 * @param apps this file's apps, as far as they were valid
 * @param source this file's canonical source
 * @param problems
 */
function checkVariants(
  value: unknown,
  at: string,
  apps: string[],
  source: string | undefined,
  problems: string[],
) {
  if (!isObject(value)) return void problems.push(`${at} must be an object of app → variant`);
  for (const [app, variant] of Object.entries(value)) {
    const where = `${at}.${app}`;
    if (!apps.includes(app)) problems.push(`${where}: "${app}" is not one of this file's apps`);
    if (!isObject(variant)) {
      problems.push(`${where} must be an object with a source and a why`);
      continue;
    }
    unknownKeys(variant, ['source', 'why'], where, problems);
    if (checkPath(variant.source, `${where}.source`, problems) && variant.source === source) {
      problems.push(`${where}.source is the canonical source: a variant must differ`);
    }
    if (!isText(variant.why)) problems.push(`${where}.why must say why the app differs`);
  }
}

function checkCompanions(value: unknown, at: string, problems: string[]) {
  if (!Array.isArray(value)) return void problems.push(`${at} must be an array`);
  const seen = new Set();
  value.forEach((companion, i) => {
    const where = `${at}[${i}]`;
    if (!isObject(companion)) return void problems.push(`${where} must be an object`);
    unknownKeys(companion, ['key', 'value'], where, problems);
    const { key } = companion;
    if (!Array.isArray(key) || key.length === 0 || !key.every(isText)) {
      problems.push(`${where}.key must be a non-empty array of key names`);
    } else {
      if (key.some((segment) => UNSAFE_KEYS.has(segment))) {
        problems.push(`${where}.key may not use ${[...UNSAFE_KEYS].join(', ')}`);
      }
      const id = JSON.stringify(key);
      if (seen.has(id)) problems.push(`${where}.key repeats an earlier companion`);
      seen.add(id);
    }
    if (!isText(companion.value)) problems.push(`${where}.value must be a non-empty string`);
  });
}

function checkEntry(entry: unknown, at: string, problems: string[]) {
  if (!isObject(entry)) return void problems.push(`${at} must be an object`);
  unknownKeys(entry, ['path', 'source', 'apps', 'variants', 'companions'], at, problems);
  if (checkPath(entry.path, `${at}.path`, problems) && entry.path === SETTINGS_FILE) {
    problems.push(`${at}.path is ${SETTINGS_FILE}: the app's own settings are never synced`);
  }
  const source =
    checkPath(entry.source, `${at}.source`, problems) && typeof entry.source === 'string'
      ? entry.source
      : undefined;
  let apps: string[] = [];
  if (!Array.isArray(entry.apps) || entry.apps.length === 0) {
    problems.push(`${at}.apps must be a non-empty array`);
  } else {
    for (const app of entry.apps) {
      if (!APPS.includes(app)) problems.push(`${at}.apps: "${String(app)}" is not an app`);
    }
    if (new Set(entry.apps).size !== entry.apps.length) problems.push(`${at}.apps repeats an app`);
    apps = entry.apps.filter((app) => APPS.includes(app));
  }
  if ('variants' in entry) checkVariants(entry.variants, `${at}.variants`, apps, source, problems);
  if ('companions' in entry) checkCompanions(entry.companions, `${at}.companions`, problems);
}

/**
 * Everything wrong with a parsed manifest, for any value at all: an empty
 * list means it is one. Never throws.
 */
export function manifestProblems(value: unknown): string[] {
  if (!isObject(value)) return ['the manifest must be an object'];
  const problems: string[] = [];
  unknownKeys(value, ['files', 'unsynced'], 'manifest', problems);
  const { files, unsynced } = value;
  if (!Array.isArray(files)) problems.push('files must be an array');
  if (!Array.isArray(unsynced)) problems.push('unsynced must be an array');
  const paths: Map<string, string> = new Map();
  const carried: Set<string> = new Set();
  if (Array.isArray(files)) {
    files.forEach((entry, i) => {
      const at = `files[${i}]`;
      checkEntry(entry, at, problems);
      if (!isObject(entry)) return;
      if (typeof entry.path === 'string') {
        const key = entry.path.toLowerCase();
        const first = paths.get(key);
        if (first) problems.push(`${at}.path "${entry.path}" is already ${first} (case aside)`);
        else paths.set(key, `${at}.path`);
        for (const [other, where] of paths) {
          if (key.startsWith(`${other}/`)) problems.push(`${at}.path is inside ${where}, a file`);
          if (other.startsWith(`${key}/`)) problems.push(`${where} is inside ${at}.path, a file`);
        }
      }
      if (typeof entry.source === 'string') carried.add(entry.source);
      if (isObject(entry.variants)) {
        for (const variant of Object.values(entry.variants)) {
          if (isObject(variant) && typeof variant.source === 'string') carried.add(variant.source);
        }
      }
    });
  }
  if (Array.isArray(unsynced)) {
    const listed = new Set();
    unsynced.forEach((entry, i) => {
      const at = `unsynced[${i}]`;
      if (!isObject(entry)) return void problems.push(`${at} must be an object`);
      unknownKeys(entry, ['source', 'why'], at, problems);
      if (checkPath(entry.source, `${at}.source`, problems)) {
        if (listed.has(entry.source)) problems.push(`${at}.source is listed twice`);
        listed.add(entry.source);
        if (carried.has(String(entry.source))) {
          problems.push(`${at}.source is synced by a file above: it is not unsynced`);
        }
      }
      if (!isText(entry.why)) problems.push(`${at}.why must say why no app holds a copy`);
    });
  }
  return problems;
}

const manifestError = (problems: string[]): Error =>
  new Error(`${MANIFEST}:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);

/**
 * Parses and validates a manifest's text; optional parts get their empty value.
 */
export function parseManifest(text: string): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw manifestError([`is not JSON: ${error instanceof Error ? error.message : error}`]);
  }
  const problems = manifestProblems(value);
  if (problems.length > 0) throw manifestError(problems);
  const { files, unsynced } = value as {
    files: (Omit<Entry, 'variants' | 'companions'> & Partial<Entry>)[];
    unsynced: Unsynced[];
  };
  return {
    files: files.map((entry) => ({ variants: {}, companions: [], ...entry })),
    unsynced,
  };
}

/**
 * What is at `file`, a link itself rather than what it points to, or null.
 */
export function lstatOrNull(file: string) {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

/**
 * Whether a regular file is at `file` (not a folder, not a link: a link could
 * point outside the checkout).
 */
const isFile = (file: string) => lstatOrNull(file)?.isFile() === true;

/**
 * Reads this repo's manifest and checks it against the files it names: every
 * source exists, and a variant's bytes differ from the canonical's.
 *
 * @param root this repo's checkout
 */
export function loadManifest(root: string = CI_ROOT): Manifest {
  const manifest = parseManifest(readFileSync(path.join(root, MANIFEST), 'utf8'));
  const problems: string[] = [];
  const exists = (source: string, at: string) => {
    const found = isFile(path.join(root, source));
    if (!found) problems.push(`${at} "${source}" is not a file in jbhirsh/ci`);
    return found;
  };
  manifest.files.forEach((entry, i) => {
    const canonical = exists(entry.source, `files[${i}].source`);
    for (const [app, variant] of Object.entries(entry.variants)) {
      const at = `files[${i}].variants.${app}.source`;
      if (!exists(variant.source, at) || !canonical) continue;
      const same = readFileSync(path.join(root, variant.source)).equals(
        readFileSync(path.join(root, entry.source)),
      );
      if (same) problems.push(`${at} "${variant.source}" is identical to the canonical`);
    }
  });
  manifest.unsynced.forEach((entry, i) => exists(entry.source, `unsynced[${i}].source`));
  if (problems.length > 0) throw manifestError(problems);
  return manifest;
}

/**
 * The files an app holds in step: for each, where the app keeps it, the
 * source of its content (the app's variant when it has one, with the reason),
 * and its companions.
 */
export function resolve(manifest: Manifest, app: string): Resolved[] {
  if (!APPS.includes(app)) throw new Error(`unknown app "${app}" (the apps: ${APPS.join(', ')})`);
  return manifest.files
    .filter((entry) => entry.apps.includes(app))
    .map((entry) => {
      const variant = entry.variants[app];
      return {
        path: entry.path,
        source: variant ? variant.source : entry.source,
        why: variant?.why,
        companions: entry.companions,
      };
    });
}

/**
 * Why a companion can't be set in an app's `.github/ci.json`, or null: every
 * folder on the way to its key that the app already holds must be an object.
 * The last key may exist (it is never overwritten) or not.
 *
 * @param settings the app's parsed ci.json
 * @param key
 */
export function companionProblem(settings: Record<string, unknown>, key: string[]): string | null {
  let at: unknown = settings;
  for (const [i, segment] of key.slice(0, -1).entries()) {
    if (!isObject(at) || !Object.hasOwn(at, segment)) return null;
    at = at[segment];
    if (!isObject(at)) {
      return `${SETTINGS_FILE}: "${key.slice(0, i + 1).join('.')}" is not an object, so "${key.join('.')}" can't be set`;
    }
  }
  return null;
}
