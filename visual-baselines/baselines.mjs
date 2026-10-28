// The baselines folders in the app's checkout (settings.mjs: `folders`), and
// what a rewrite does with them: empties them before fresh baselines are
// written, so one no test takes any more goes, then commits whatever changed
// in them to the branch the rewrite ran on. The folders are found from the
// files git knows (tracked, or new and not ignored), so a folder that's gone
// still has its deletions staged.

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { matchesAny } from '../visuals/match.mjs';

/** @typedef {(command: string, args: string[]) => string} Run */

/**
 * Runs a command in the checkout, returning its output; its errors show in
 * the job's log.
 *
 * @param {string} root
 * @returns {Run}
 */
export function runIn(root) {
  return (command, args) =>
    execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
}

/**
 * The branch the workflow ran on, checked before anything changes: a
 * rewrite commits to it, so a run on a tag, or a local run outside Actions,
 * stops here rather than after wiping and committing.
 *
 * @param {Record<string, string | undefined>} env
 */
export function branchOf(env) {
  const name = env.GITHUB_REF_NAME ?? '';
  if (env.GITHUB_REF_TYPE !== 'branch' || name === '') {
    throw new Error(
      "a rewrite runs on a branch, in GitHub Actions: dispatch it on the PR's branch",
    );
  }
  return name;
}

/**
 * The folders among these files' ancestors that match the globs, sorted.
 *
 * @param {string[]} files repository paths
 * @param {string[]} globs
 */
export function matchingFolders(files, globs) {
  const found = new Set();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (matchesAny(dir, globs)) found.add(dir);
    }
  }
  return [...found].sort();
}

/**
 * The files git knows in the checkout: tracked, and new ones it doesn't
 * ignore.
 *
 * @param {Run} run
 */
export function knownFiles(run) {
  // -z: paths as they are, never quoted (git quotes non-ASCII names).
  return run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean);
}

/**
 * Deletes the baselines folders, returning them.
 *
 * @param {string} root
 * @param {string[]} globs
 * @param {Run} run
 */
export function wipe(root, globs, run) {
  const folders = matchingFolders(knownFiles(run), globs);
  for (const folder of folders) rmSync(path.join(root, folder), { recursive: true, force: true });
  return folders;
}

/**
 * Commits what changed in the baselines folders and pushes it to `branch`,
 * with a subject and a body (the commit check wants both). Returns false,
 * having committed nothing, when nothing changed.
 *
 * @param {{ globs: string[], branch: string, by: string, run: Run }} options
 *   `by`: what rewrote them, for the body (a workflow and its run's link)
 */
export function commit({ globs, branch, by, run }) {
  const folders = matchingFolders(knownFiles(run), globs);
  if (folders.length === 0) return false;
  run('git', ['add', '--', ...folders]);
  try {
    run('git', ['diff', '--cached', '--quiet', '--', ...folders]);
    return false;
  } catch {
    // Staged changes: `git diff --quiet` exits 1.
  }
  run('git', [
    '-c',
    'user.name=github-actions[bot]',
    '-c',
    'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit',
    // Only the baselines folders, whatever else the command staged.
    '--only',
    '-m',
    'Update the visual baselines',
    '-m',
    `Rewritten on CI by ${by}.`,
    '--',
    ...folders,
  ]);
  run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  return true;
}
