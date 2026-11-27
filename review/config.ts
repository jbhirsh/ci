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
import { appConfig } from '../lib/app.ts';

/**
 * A file of the app as `ref` holds it (`origin/main`), or as the working
 * tree holds it when there's no ref; null when it doesn't exist there.
 *
 * @param file repo-relative path
 * @param where
 */
export function readAppFile(
  file: string,
  { root, ref }: { root: string; ref?: string },
): string | null {
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
 */
export function loadConfig(
  tool: string,
  { root, ref }: { root: string; ref?: string },
): Record<string, unknown> {
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
 */
export function onlyKnownKeys(tool: string, section: Record<string, unknown>, known: string[]) {
  for (const key of Object.keys(section)) {
    if (!known.includes(key)) {
      throw new Error(`.github/ci.json: "${tool}.${key}" is not a setting (${known.join(', ')})`);
    }
  }
}

/**
 * A setting that must be a list of non-empty strings, or the default.
 *
 * @param name e.g. `review.skip`
 * @param value
 * @param fallback
 */
export function stringList(name: string, value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim() !== '')) {
    throw new Error(`.github/ci.json: "${name}" must be a list of non-empty strings`);
  }
  return value as string[];
}

/**
 * A tool's `engine` setting (review, autofix), which no longer chooses
 * anything: the Agent SDK is the only engine (jbhirsh/ci#68). Every app
 * still sets "sdk", so the key is accepted, as "sdk" alone, and ignored; a
 * later change drops it once no repo sets it.
 *
 * @param name e.g. `review.engine`
 * @param value
 */
export function checkEngine(name: string, value: unknown) {
  if (value === undefined || value === 'sdk') return;
  throw new Error(`.github/ci.json: "${name}" must be "sdk", the only engine, or be left out`);
}

/**
 * A tool's `advisor` setting: a model name, or null for none.
 *
 * @param name e.g. `review.advisor`
 * @param value
 */
export function advisorSetting(name: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && /^[a-z0-9][a-z0-9.-]*$/.test(value)) return value;
  throw new Error(`.github/ci.json: "${name}" must be a model name, such as "opus", or null`);
}
