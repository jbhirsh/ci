// The picture branch's history in a bare clone, and what each link into the
// repository points at there (ci#33's migration).
//
// The clone holds only picture refs: the branch (`screenshots`) and any
// legacy `pr-screenshots/*` branch still on GitHub. So a commit the clone
// has is picture history, which deleting the branches would lose, and a
// commit it lacks (main's, a PR head's, the README bot's) is kept alive by
// another ref and its links are left alone. A bundle of the clone goes in
// the run's state, for the owner to keep and to restore the branch from;
// later steps open the bundle rather than fetching again, so they see the
// files the inventory saw even if the branch moved.
//
// A link resolves to:
//   migrate     a file (blob) in picture history: uploaded, then the link rewritten
//   keep        a ref outside picture history: left alone
//   unresolved  a picture ref whose file isn't there: listed
//   listed      a folder (`tree/`) or commit link into picture history,
//               which no one attachment replaces: listed for the owner
//
// `pr-screenshots/<topic>/<file>` links are broken today (those branches
// are gone; their files sit under `<topic>/` on `screenshots`), so one
// whose branch is gone resolves to `<branch>:<topic>/<file>`, or to the
// newest commit in the clone that has that path, and the migration repairs
// it.

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

/** @typedef {import('./links.mjs').Link} Link */

/**
 * @typedef {object} Resolved What a link points at.
 * @property {'migrate' | 'keep' | 'unresolved' | 'listed'} status
 * @property {string} [blob] the file's blob SHA, for migrate
 * @property {number} [size] its bytes
 * @property {string} [at] the commit and path it was read at (`<sha>:<path>`)
 * @property {boolean} [repaired] a legacy branch's link, broken today
 */

/**
 * @typedef {object} BranchFile
 * @property {string} path
 * @property {string} blob
 * @property {number} size
 */

/**
 * Runs git in `dir`; its output, or null when it fails.
 *
 * @param {string} dir
 * @param {string[]} args
 */
export function tryGit(dir, args) {
  const result = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Runs git in `dir`; its output, or throws with git's message.
 *
 * @param {string} dir
 * @param {string[]} args
 * @returns {string}
 */
export function git(dir, args) {
  const result = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args[args[0] === '-c' ? 2 : 0]}: ${result.stderr || result.error?.message || 'failed'}`,
    );
  }
  return result.stdout;
}

/**
 * Fetches the picture branches into a new bare repository at `dir`.
 *
 * @param {{ dir: string; repo: string; branch: string; legacy: string; token?: string; remote?: string }} options
 *   token: sent as a header (never put in a URL or the config), for a private repository;
 *   remote: where to fetch from, GitHub's copy of `repo` unless given (for tests)
 * @returns {{ tip: string; legacyBranches: string[] }}
 */
export function fetchPictures({
  dir,
  repo,
  branch,
  legacy,
  token,
  remote = `https://github.com/${repo}`,
}) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet', '--bare']);
  const auth = token
    ? [
        '-c',
        `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      ]
    : [];
  git(dir, [
    ...auth,
    'fetch',
    '--quiet',
    remote,
    `+refs/heads/${branch}:refs/heads/${branch}`,
    `+refs/heads/${legacy}/*:refs/heads/${legacy}/*`,
  ]);
  return {
    tip: git(dir, ['rev-parse', `refs/heads/${branch}`]).trim(),
    legacyBranches: git(dir, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${legacy}/`])
      .split('\n')
      .filter(Boolean),
  };
}

/**
 * Writes a bundle of every ref in the clone.
 *
 * @param {string} dir
 * @param {string} file
 */
export function bundle(dir, file) {
  git(dir, ['bundle', 'create', file, '--all']);
}

/**
 * Opens a bundle as a bare repository at `dir`, its refs as they were.
 *
 * @param {string} file
 * @param {string} dir
 */
export function openBundle(file, dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet', '--bare']);
  git(dir, ['fetch', '--quiet', file, '+refs/heads/*:refs/heads/*']);
}

/**
 * Every file on the branch's tip.
 *
 * @param {string} dir
 * @param {string} branch
 * @returns {BranchFile[]}
 */
export function branchFiles(dir, branch) {
  return git(dir, ['ls-tree', '-r', '-l', `refs/heads/${branch}`])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t');
      const [, , blob, size] = meta.split(/\s+/);
      return { path, blob, size: Number(size) };
    });
}

/**
 * A resolver for links in one clone, remembering what it has looked up.
 *
 * @param {string} dir
 * @param {{ branch: string; legacy: string }} names
 */
export function resolver(dir, { branch, legacy }) {
  /** @type {Map<string, Resolved>} */
  const seen = new Map();

  /** @param {string} ref */
  const commitOf = (ref) => {
    const name = /^[0-9a-f]{7,40}$/.test(ref) ? ref : `refs/heads/${ref}`;
    return tryGit(dir, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`])?.trim() ?? null;
  };

  /**
   * @param {string} commit
   * @param {string} path
   * @returns {Resolved | null}
   */
  const blobAt = (commit, path) => {
    const spec = `${commit}:${path}`;
    const type = tryGit(dir, ['cat-file', '-t', spec])?.trim();
    if (type !== 'blob') return null;
    const blob = git(dir, ['rev-parse', spec]).trim();
    const size = Number(git(dir, ['cat-file', '-s', blob]).trim());
    return { status: 'migrate', blob, size, at: `${commit.slice(0, 12)}:${path}` };
  };

  /**
   * @param {Link} link
   * @returns {Resolved}
   */
  function resolve(link) {
    const isLegacy = link.ref.startsWith(`${legacy}/`);
    const commit = commitOf(link.ref);
    if (!commit && !isLegacy) {
      // Main's commits, a PR's head, another branch: not picture history.
      // The clone has only picture refs, so any other name isn't one.
      return { status: 'keep' };
    }
    if (link.form === 'tree' || link.form === 'commit') return { status: 'listed' };
    if (commit) return blobAt(commit, link.path) ?? { status: 'unresolved' };
    // A legacy branch that's gone: its topic's folder on the branch, or the
    // newest picture commit that has the path.
    const topic = link.ref.slice(legacy.length + 1);
    const path = `${topic}/${link.path}`;
    const tip = commitOf(branch);
    const onTip = tip ? blobAt(tip, path) : null;
    if (onTip) return { ...onTip, repaired: true };
    const log = tryGit(dir, ['log', '--all', '--format=%H', '--', path]) ?? '';
    for (const sha of log.split('\n').filter(Boolean)) {
      const found = blobAt(sha, path);
      if (found) return { ...found, repaired: true };
    }
    return { status: 'unresolved', repaired: true };
  }

  return {
    /**
     * @param {Link} link
     * @returns {Resolved}
     */
    resolve(link) {
      const key = `${link.form} ${link.ref} ${link.path}`;
      let found = seen.get(key);
      if (!found) {
        found = resolve(link);
        seen.set(key, found);
      }
      return found;
    },
  };
}

/**
 * A blob's bytes.
 *
 * @param {string} dir
 * @param {string} blob
 */
export function readBlob(dir, blob) {
  const result = spawnSync('git', ['-C', dir, 'cat-file', 'blob', blob], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git cat-file: no blob ${blob}`);
  return result.stdout;
}
