// Publishing a PR's GIFs: one commit on the app's pictures branch
// (`screenshots`, or the `gif.branch` setting), under a folder named for the
// PR, and the Before/After table for the PR description, each picture linked
// by that commit's SHA so a later push to the branch can't change what an
// old PR shows. The same for every app, whether its GIFs came from a browser
// (cli.mjs) or from videos its CI recorded (videos.mjs).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Over this, a PR description may not show a GIF. */
export const GIF_WARN_BYTES = 5 * 1024 * 1024;

/**
 * The owner/name of a GitHub remote, for the raw links: https (with or
 * without a token or `.git`), `git@github.com:`, `ssh://`, an SSH host alias
 * such as `github.com-work`, or a local git proxy's URL that ends in them
 * (http://127.0.0.1:41799/git/owner/name, as a sandbox's remote is).
 *
 * @param {string} url
 */
export function repoFromRemote(url) {
  const trimmed = url.trim();
  const github = /github\.com[^/:]*[/:](?:\d+\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (github) return github[1];
  const proxy =
    /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/.*?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      trimmed,
    );
  if (proxy) return proxy[1];
  throw new Error(`origin isn't a GitHub repository (${url}); pass --repo owner/name`);
}

/**
 * The raw link to a file on the pictures branch, fixed at one commit.
 *
 * @param {string} repo
 * @param {string} sha
 * @param {string} file
 */
export function rawUrl(repo, sha, file) {
  return `https://raw.githubusercontent.com/${repo}/${sha}/${file}`;
}

/**
 * A scenario's GIFs' names in its PR's folder.
 *
 * @param {string} name
 */
export function gifNames(name) {
  return {
    before: `${name}-before.gif`,
    after: `${name}-after.gif`,
    side: `${name}-side-by-side.gif`,
  };
}

/**
 * @typedef {object} Published One scenario's GIFs, as paths on the pictures branch, or null for one not made.
 * @property {string} name
 * @property {string | null} before
 * @property {string | null} after
 * @property {string | null} sideBySide
 */

/**
 * The PR description's table: a Before | After row per scenario (an
 * after-only one shows "(none)" before), and the side-by-side GIFs in a
 * table of their own, twice as wide, each linked by the commit's SHA.
 *
 * @param {string} repo
 * @param {string} sha
 * @param {readonly Published[]} scenarios
 * @param {{ width?: number; base?: string }} [options] width: each GIF's in the table; base: what "before" was built from
 */
export function markdownTable(repo, sha, scenarios, { width = 400, base = 'main' } = {}) {
  /**
   * @param {string | null} file
   * @param {number} w
   */
  const img = (file, w) =>
    file ? `<img src="${rawUrl(repo, sha, file)}" width="${w}">` : '(none)';
  /** @type {string[]} */
  const rows = [];
  const joined = scenarios.filter((s) => s.sideBySide);
  if (joined.length > 0) {
    rows.push('| Scenario | Before / After |', '|---|---|');
    for (const s of joined) rows.push(`| ${s.name} | ${img(s.sideBySide, 2 * width)} |`);
  }
  const pairs = scenarios.filter((s) => !s.sideBySide);
  if (pairs.length > 0) {
    if (rows.length > 0) rows.push('');
    rows.push(`| Scenario | Before (\`${base}\`) | After |`, '|---|---|---|');
    for (const s of pairs)
      rows.push(`| ${s.name} | ${img(s.before, width)} | ${img(s.after, width)} |`);
  }
  return rows.join('\n');
}

/**
 * A GIF's size for the log, and a warning when it's too big for a PR to show.
 *
 * @param {string} file
 * @param {number} bytes
 */
export function sizeNote(file, bytes) {
  const size =
    bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(bytes / 1024)} KB`;
  return bytes > GIF_WARN_BYTES
    ? `pr-gif: ${file} is ${size}, over 5 MB, which a PR may not show: record a shorter flow, a narrower one (--width) or fewer frames (--fps)`
    : `pr-gif: ${file} is ${size}`;
}

/** What a picture branch new to an app holds first: no deploys from it. */
export const BRANCH_VERCEL_JSON = '{\n  "git": { "deploymentEnabled": false }\n}\n';

/**
 * @typedef {(args: string[], options?: { env?: Record<string, string | undefined>; allowFail?: boolean }) => { status: number | null; stdout: string; stderr: string }} Git
 *   Runs git in the app's checkout.
 */

/**
 * Git in `root`, returning what it printed; a failure throws unless
 * `allowFail`.
 *
 * @param {string} root
 * @returns {Git}
 */
export function gitIn(root) {
  return (args, { env, allowFail = false } = {}) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    const out = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    if (out.status !== 0 && !allowFail) {
      throw new Error(`git ${args[0]} failed: ${(out.stderr || out.stdout).trim().slice(-800)}`);
    }
    return out;
  };
}

/**
 * The commit adding `files` (each [path on the branch, local file]) on top
 * of the branch's tip as origin has it, built in a scratch index so the
 * checkout and its own index are never touched. A branch origin doesn't
 * have yet starts here, with a vercel.json that turns its deploys off.
 *
 * @param {Git} git
 * @param {readonly (readonly [string, string])[]} files
 * @param {string} message
 * @param {string} branch
 * @param {string} scratch a directory for the scratch index
 * @returns {{ commit: string; parent: string | null }}
 */
export function commitOnTip(git, files, message, branch, scratch) {
  const fetched = git(['fetch', '-q', 'origin', `refs/heads/${branch}`], { allowFail: true });
  const parent = fetched.status === 0 ? git(['rev-parse', 'FETCH_HEAD']).stdout.trim() : null;
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
  rmSync(env.GIT_INDEX_FILE, { force: true });
  /** @param {string} file */
  const add = (file) => git(['hash-object', '-w', file], { env }).stdout.trim();
  if (parent) git(['read-tree', parent], { env });
  else {
    const vercel = path.join(scratch, 'vercel.json');
    writeFileSync(vercel, BRANCH_VERCEL_JSON);
    git(['update-index', '--add', '--cacheinfo', `100644,${add(vercel)},vercel.json`], { env });
  }
  for (const [file, local] of files) {
    git(['update-index', '--add', '--cacheinfo', `100644,${add(local)},${file}`], { env });
  }
  const tree = git(['write-tree'], { env }).stdout.trim();
  const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], {
    env,
  }).stdout.trim();
  return { commit, parent };
}

/**
 * Adds `files` to the pictures branch in one commit and, if `push`, pushes
 * it, trying again on the new tip (up to three times) when someone else's
 * push moved the branch on meanwhile; returns the commit's SHA. Unpushed, the
 * commit is still in the repository, and the error (or log) says how to push
 * it.
 *
 * @param {Git} git
 * @param {readonly (readonly [string, string])[]} files
 * @param {{ message: string; branch: string; push: boolean; log?: (line: string) => void }} options
 */
export function publishFiles(git, files, { message, branch, push, log = console.log }) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'pr-gif-index-'));
  try {
    for (let attempt = 1; ; attempt += 1) {
      const { commit, parent } = commitOnTip(git, files, message, branch, scratch);
      if (!push) {
        log(
          `pr-gif: committed ${commit} but didn't push it: git push origin ${commit}:refs/heads/${branch}`,
        );
        return commit;
      }
      const pushed = git(['push', '-q', 'origin', `${commit}:refs/heads/${branch}`], {
        allowFail: true,
      });
      if (pushed.status === 0) {
        log(`pr-gif: pushed ${commit.slice(0, 7)} to ${branch}`);
        return commit;
      }
      const remote = git(['ls-remote', 'origin', `refs/heads/${branch}`], {
        allowFail: true,
      }).stdout;
      const tip = remote.split(/\s/)[0] || null;
      // Only a branch that moved on is worth another go, on its new tip.
      if (tip === parent || attempt >= 3) {
        throw new Error(
          `pr-gif: pushing ${commit} to ${branch} failed (${(pushed.stderr || pushed.stdout).trim().slice(-400)}); ` +
            `push it with: git push origin ${commit}:refs/heads/${branch}`,
        );
      }
      log(`pr-gif: ${branch} moved on; adding the GIFs to its new tip…`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
