// Reads an app's settings for the review and autofix tools, and the files
// they name, from the app's base branch rather than from the checkout.
//
// Why the base branch: on a pull request the checkout is the PR's own code,
// so a PR could otherwise rewrite the instructions its own review follows
// (`review.instructions` in `.github/ci.json`, or the guide file it names).
// restore.ts puts CLAUDE.md and `.claude/` back as the base holds them for
// the same reason. Autofix runs on `workflow_run` with the
// PR's branch checked out, so it reads the default branch the same way.
// With no ref (the self-tests, a local run) it reads the working tree.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appConfig } from '../lib/app.mjs';

/**
 * A file of the app as `ref` holds it (`origin/main`), or as the working
 * tree holds it when there's no ref; null when it doesn't exist there.
 *
 * @param {string} file repo-relative path
 * @param {{ root: string, ref?: string }} where
 * @returns {string | null}
 */
export function readAppFile(file, { root, ref }) {
  try {
    if (!ref) return readFileSync(path.join(root, file), 'utf8');
    return execFileSync('git', ['-C', root, 'show', `${ref}:${file}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * The app's settings for one tool (its key in `.github/ci.json`), read as
 * `ref` holds them.
 *
 * @param {string} tool
 * @param {{ root: string, ref?: string }} where
 * @returns {Record<string, unknown>}
 */
export function loadConfig(tool, { root, ref }) {
  if (!ref) return appConfig(tool, root);
  const text = readAppFile('.github/ci.json', { root, ref });
  if (text === null) return {};
  // appConfig reads a checkout; give it one holding just that file.
  const copy = mkdtempSync(path.join(tmpdir(), 'ci-config-'));
  mkdirSync(path.join(copy, '.github'));
  writeFileSync(path.join(copy, '.github', 'ci.json'), text);
  return appConfig(tool, copy);
}

/**
 * Throws on a key the tool doesn't read, so a typo in `.github/ci.json`
 * fails the self-test instead of silently doing nothing.
 *
 * @param {string} tool
 * @param {Record<string, unknown>} section
 * @param {string[]} known
 */
export function onlyKnownKeys(tool, section, known) {
  for (const key of Object.keys(section)) {
    if (!known.includes(key)) {
      throw new Error(`.github/ci.json: "${tool}.${key}" is not a setting (${known.join(', ')})`);
    }
  }
}

/**
 * A setting that must be a list of non-empty strings, or the default.
 *
 * @param {string} name e.g. `review.skip`
 * @param {unknown} value
 * @param {string[]} fallback
 * @returns {string[]}
 */
export function stringList(name, value, fallback) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim() !== '')) {
    throw new Error(`.github/ci.json: "${name}" must be a list of non-empty strings`);
  }
  return /** @type {string[]} */ (value);
}

/**
 * A tool's `engine` setting (review, autofix), which no longer chooses
 * anything: the Agent SDK is the only engine (jbhirsh/ci#68). Every app
 * still sets "sdk", so the key is accepted, as "sdk" alone, and ignored; a
 * later change drops it once no repo sets it.
 *
 * @param {string} name e.g. `review.engine`
 * @param {unknown} value
 */
export function checkEngine(name, value) {
  if (value === undefined || value === 'sdk') return;
  throw new Error(`.github/ci.json: "${name}" must be "sdk", the only engine, or be left out`);
}

/**
 * A tool's `advisor` setting: a model name, or null for none.
 *
 * @param {string} name e.g. `review.advisor`
 * @param {unknown} value
 * @returns {string | null}
 */
export function advisorSetting(name, value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && /^[a-z0-9][a-z0-9.-]*$/.test(value)) return value;
  throw new Error(`.github/ci.json: "${name}" must be a model name, such as "opus", or null`);
}
