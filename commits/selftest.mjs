// Self-test of the commit-message check against an app's checkout:
// `node commits/selftest.mjs <app dir>`. It reads the last commits on the
// checkout's HEAD the way the check reads a PR's (from git rather than the
// API, which needs a PR) and runs every message through the rules, so a
// message shape the parser can't take fails here before it fails a PR.
// main's own history is squash- and rebase-merged by people and bots over
// years, so what the rules say about it is printed, not judged.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { problems } from './check.mjs';

/** How far back to read. */
export const DEPTH = 200;

/**
 * The checkout's last commits, as the check sees them. `git log` names no
 * GitHub login, so Dependabot is recognised by its author name.
 *
 * @param {string} root
 * @returns {import('./check.mjs').Commit[]}
 */
export function gitCommits(root) {
  const out = execFileSync('git', ['log', `-n${DEPTH}`, '--format=%h%x00%P%x00%an%x00%B%x1e'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record !== '')
    .map((record) => {
      const [sha = '', parents = '', author = '', message = ''] = record.split('\0');
      return {
        sha,
        login: author === 'dependabot[bot]' ? author : '',
        parents: parents.split(' ').filter(Boolean).length,
        message: message.replace(/\n+$/, ''),
      };
    });
}

/**
 * Runs the rules over the app's history and returns what to print; throws
 * when the history can't be read.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function selftest(root) {
  const commits = gitCommits(root);
  if (commits.length === 0) throw new Error(`no commits in ${root}`);
  const flagged = commits.filter((commit) => problems(commit).length > 0);
  return [
    `commits: read ${commits.length} commits; the rules would flag ${flagged.length} of them.`,
    ...flagged.slice(0, 10).map((c) => `  ${c.sha} ${c.message.split('\n')[0]}`),
  ];
}

/**
 * Runs the self-test on the app at `argv[0]` and returns the exit code.
 *
 * @param {string[]} argv
 * @param {(line: string) => void} [log]
 * @returns {number}
 */
export function cli(argv, log = console.log) {
  try {
    for (const line of selftest(path.resolve(argv[0] ?? '.'))) log(line);
    return 0;
  } catch (error) {
    log(`commits self-test failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cli(process.argv.slice(2));
}
