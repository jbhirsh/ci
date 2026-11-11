// A throwaway app checkout for the tests: these files committed on branch
// `topic`, with a bare remote to push to. Not part of the tool.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A checkout holding these files, committed, with a bare remote to push to.
 *
 * @param {Record<string, string | Buffer>} files
 */
export function repo(files) {
  const base = mkdtempSync(path.join(tmpdir(), 'baselines-'));
  const remote = path.join(base, 'remote.git');
  const root = path.join(base, 'app');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  mkdirSync(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@b.c', ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  git('init', '-q', '-b', 'topic');
  git('remote', 'add', 'origin', remote);
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('push', '-q', 'origin', 'topic');
  return { root, remote, git };
}
