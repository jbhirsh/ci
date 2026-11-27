// Test helper (not a test): a throwaway app checkout with the files given,
// committed to a git repo whose `origin/main` holds them, so tests can read
// settings both from the working tree and from a ref.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * @param {Record<string, string>} files repo-relative path → content
 * @returns {string} the checkout's root
 */
export function testApp(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'app-'));
  const all = { 'package.json': '{}', ...files };
  writeFiles(root, all);
  /** @param {string[]} args */
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], {
      stdio: 'ignore',
      env: {
        ...gitEnv(),
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  git('init', '-q', '-b', 'main');
  git('add', '--', ...Object.keys(all));
  git('commit', '-q', '--no-gpg-sign', '-m', 'app');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return root;
}

/**
 * Writes files under a root, making their folders.
 *
 * @param {string} root
 * @param {Record<string, string>} files
 */
export function writeFiles(root, files) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
}

/** The environment less any GIT_* a hook running the tests left behind. */
function gitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
}
