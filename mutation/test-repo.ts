// Throwaway app checkouts for the mutation tests: a git repository in a
// temporary directory, with this repo's node_modules linked in so the
// scripts find Prettier there as they would in an app.
//
// Git runs with no GIT_* variable from outside (a git hook's GIT_DIR would
// point every command, the scripts' own included, at the repository being
// committed to) and without the user's config (signing, hooks, aliases):
// `isolateGit` clears them from this process, for the scripts' calls, and
// `repo` passes the same environment to its own.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IDENTITY = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

/**
 * Clears inherited GIT_* variables from this process and sets an identity;
 * returns a function putting them back.
 */
export function isolateGit() {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
  Object.assign(process.env, IDENTITY);
  return () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  };
}

/** @type {string[]} */
const made = [];

/** Removes every repository `repo` made. */
export function cleanRepos() {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Writes files under `root`, making their directories.
 *
 * @param {string} root
 * @param {Record<string, string>} files
 */
export function writeFiles(root, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
}

/**
 * A repository on `main` whose first commit holds `files`, with a function
 * to commit more and one to run git in it.
 *
 * @param {Record<string, string>} files
 */
export function repo(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'mutation-app-'));
  made.push(root);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    ...IDENTITY,
  };
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', args, {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  symlinkSync(path.join(HERE, '..', 'node_modules'), path.join(root, 'node_modules'));
  git('init', '-q', '-b', 'main');
  /**
   * @param {Record<string, string>} more
   * @param {string[]} [remove]
   */
  const commit = (more, remove = []) => {
    writeFiles(root, more);
    for (const file of remove) git('rm', '-q', file);
    if (Object.keys(more).length > 0) git('add', '--', ...Object.keys(more));
    git('commit', '-q', '--allow-empty', '-m', 'change');
  };
  commit({ ...files, '.gitignore': 'node_modules\n' });
  return { root, git, commit };
}
