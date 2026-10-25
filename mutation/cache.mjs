// The cache keys Stryker's incremental results are saved and restored under.
//
// Each run saves under a key of its own (a cache key can't be overwritten),
// so a prefix match restores the newest: `<prefix>-pr-<n>-` for a PR's own
// last results, `<prefix>-main-` for main's baseline (the last sweep, or a
// merge's incremental run). A PR's caches are visible to that PR alone and
// main's to every PR, so another PR's results never leak in. PRs are named
// by number, not branch, since a cache key may not hold a comma and a branch
// name may.
//
// With `cache.restartOn` set, a hash of those files joins a PR's key: a
// change to one (the dependencies, a shared test helper) restores none of
// the PR's earlier results, as Stryker's change detection sees only each
// mutant's own code and the tests covering it. With `cache.restoreMain`, a
// PR with no results of its own starts from main's baseline.
//
// Usage: node cache.mjs pr <number> | main
// Writes the outputs `key` (this run's) and `restore-keys` (newline-separated).

import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { appRoot } from '../lib/app.mjs';
import { readSettings } from './settings.mjs';

/**
 * A hash of the files the globs match under `root` (names and contents, in
 * path order), or '' when there are no globs.
 *
 * @param {string[]} globs
 * @param {string} root
 */
export function filesHash(globs, root) {
  if (globs.length === 0) return '';
  const files = [...new Set(globs.flatMap((glob) => globSync(glob, { cwd: root })))].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    try {
      hash
        .update(`${file}\0`)
        .update(readFileSync(path.join(root, file)))
        .update('\0');
    } catch {
      // A directory the glob matched: its files are matched on their own.
    }
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * This run's key and the prefixes to restore from.
 *
 * @param {{ prefix: string, pr: number | null, hash: string, restoreMain: boolean,
 *   runId: string, attempt: string }} args
 */
export function cacheKeys({ prefix, pr, hash, restoreMain, runId, attempt }) {
  const main = `${prefix}-main-`;
  if (pr === null) return { key: `${main}${runId}-${attempt}`, restoreKeys: [main] };
  const own = `${prefix}-pr-${pr}-${hash ? `${hash}-` : ''}`;
  return { key: `${own}${runId}-${attempt}`, restoreKeys: restoreMain ? [own, main] : [own] };
}

/**
 * The command line. Returns the exit code.
 *
 * @param {string[]} args
 * @param {string} [root]
 * @param {Record<string, string | undefined>} [env]
 */
export function main(args, root = appRoot(), env = process.env) {
  const [kind, number] = args;
  const pr = Number(number);
  if (!(kind === 'main' || (kind === 'pr' && Number.isInteger(pr) && pr > 0))) {
    console.error('Usage: cache.mjs pr <number> | main');
    return 2;
  }
  const { cache } = readSettings(root);
  const { key, restoreKeys } = cacheKeys({
    prefix: cache.prefix,
    pr: kind === 'pr' ? pr : null,
    hash: kind === 'pr' ? filesHash(cache.restartOn, root) : '',
    restoreMain: cache.restoreMain,
    runId: env.GITHUB_RUN_ID ?? 'local',
    attempt: env.GITHUB_RUN_ATTEMPT ?? '1',
  });
  setOutput('key', key);
  setOutput('restore-keys', restoreKeys.join('\n'));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
