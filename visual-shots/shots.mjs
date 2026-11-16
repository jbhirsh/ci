// The screenshot job's side of visual review (ci#64): what it uploads for
// visual-review to compare, and, for a mockup, the patch it builds first.
//
//   node shots.mjs collect <out dir>   copies every PNG under the app's
//       `visual-review.folders` into <out dir>, paths kept, and writes
//       visual-shots.json beside them: the commit the shots are of (a
//       PR's head, its merge commit's second parent), the commit it's built
//       on (main's head, the first parent; for any other run, HEAD), the event,
//       and a mockup's issue
//   node shots.mjs mockup              checks MOCKUP_PATCH (base64) and
//       applies it to the checkout: only paths `mockupPaths` allows, never
//       a lockfile, no rename, copy, link or mode change. It needs
//       MOCKUP_ISSUE, and a run on the default branch (GITHUB_REF against
//       DEFAULT_BRANCH), the only mockups visual-review reads
//
// Run from the app's checkout. Both read the environment Actions sets
// (GITHUB_EVENT_NAME, GITHUB_REF), and mockup reads MOCKUP_PATCH, MOCKUP_ISSUE
// and DEFAULT_BRANCH, which the workflow passes through env, never spliced
// into a script.
// visual-review checks the manifest again where it reads it, since a PR's
// code writes it.

import { execFileSync } from 'node:child_process';
import { copyFileSync, globSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig, appRoot } from '../lib/app.mjs';
import { mockupMayChange, settings } from '../visual-review/settings.mjs';

/** The manifest's file name, beside the shots. */
export const MANIFEST = 'visual-shots.json';
/** The most a dispatch's inputs hold together, so a patch can't be more. */
export const MAX_PATCH_CHARS = 65_535;
const SHA = /^[0-9a-f]{40}$/;
const EVENTS = ['pull_request', 'push', 'workflow_dispatch'];

/**
 * @typedef {object} Manifest
 * @property {1} version
 * @property {string} sha the commit the shots are of
 * @property {string} base for a PR, its merge ref's first parent; else `sha`
 * @property {string} event pull_request, push or workflow_dispatch
 * @property {number | null} mockupIssue a mockup's issue, else null
 */

/**
 * The manifest, checked where it's read: it comes from an artifact a PR's
 * code wrote.
 *
 * @param {unknown} value
 * @returns {Manifest}
 */
export function parseManifest(value) {
  const m = /** @type {Record<string, unknown>} */ (
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
  );
  const issue = m.mockupIssue ?? null;
  if (
    m.version !== 1 ||
    typeof m.sha !== 'string' ||
    !SHA.test(m.sha) ||
    typeof m.base !== 'string' ||
    !SHA.test(m.base) ||
    typeof m.event !== 'string' ||
    !EVENTS.includes(m.event) ||
    (issue !== null && !(Number.isInteger(issue) && Number(issue) > 0))
  ) {
    throw new Error(`${MANIFEST} isn't one visual-shots wrote`);
  }
  return {
    version: 1,
    sha: m.sha,
    base: m.base,
    event: m.event,
    mockupIssue: /** @type {number | null} */ (issue),
  };
}

/**
 * A mockup's issue number from the dispatch input, checked: digits only.
 *
 * @param {string | undefined} text
 */
export function mockupIssue(text) {
  if (text === undefined || text === '') return null;
  if (!/^[1-9]\d{0,9}$/.test(text)) throw new Error('mockup_issue must be an issue number');
  return Number(text);
}

/**
 * The patch a mockup dispatch passed, decoded: base64 only, and within a
 * dispatch's size.
 *
 * @param {string} text
 */
export function decodePatch(text) {
  const compact = text.replace(/\s+/g, '');
  if (compact.length > MAX_PATCH_CHARS) {
    throw new Error(
      `mockup_patch is ${compact.length} characters; a dispatch holds at most ${MAX_PATCH_CHARS}`,
    );
  }
  if (compact === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error('mockup_patch must be base64 (git diff --binary | base64 -w0)');
  }
  return Buffer.from(compact, 'base64');
}

/**
 * Why a patch mustn't be applied, or null when it may.
 *
 * @param {{ files: string[], summary: string, s: import('../visual-review/settings.mjs').Settings }} options
 *   `files`: the paths `git apply --numstat -z` lists; `summary`: `git apply
 *   --summary`'s output
 */
export function patchProblem({ files, summary, s }) {
  if (files.length === 0) return 'mockup_patch changes nothing';
  if (/\b(rename|copy) /.test(summary)) return 'mockup_patch renames or copies a file';
  if (/\bmode change\b|\bmode 120000\b|\bmode 100755\b/.test(summary)) {
    return 'mockup_patch changes a mode or adds a link or an executable';
  }
  const refused = files.filter((f) => !mockupMayChange(f, s));
  if (refused.length > 0) {
    return `mockup_patch changes what a mockup may not: ${refused.join(', ')} (visual-review.mockupPaths; never a lockfile)`;
  }
  return null;
}

/**
 * The paths `git apply --numstat -z` lists: `added\tdeleted\tpath\0`, or
 * for a rename `added\tdeleted\t\0old\0new\0` (both kept, so both are
 * checked).
 *
 * @param {string} out
 */
export function numstatFiles(out) {
  const parts = out.split('\0');
  /** @type {string[]} */
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(?:-|\d+)\t(?:-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    if (m[1] === '') files.push(parts[++i], parts[++i]);
    else files.push(m[1]);
  }
  return files.filter((f) => f !== undefined && f !== '');
}

/**
 * Every PNG under the folders, as sorted paths in the checkout. The folders
 * are git-ignored in take mode, so the file system is read, not git.
 *
 * @param {string} root
 * @param {string[]} folders globs
 */
export function shotsUnder(root, folders) {
  const found = new Set(folders.flatMap((folder) => globSync(`${folder}/**/*.png`, { cwd: root })));
  return [...found].map((f) => f.split(path.sep).join('/')).sort();
}

/**
 * The commit the shots are of, and the one it's built on. A PR's run checks
 * out its merge commit: the PR's head is its second parent, main's head its
 * first. Any other run is of HEAD itself.
 *
 * @param {string} root
 * @param {string} event
 */
export function commitsOf(root, event) {
  const rev = (/** @type {string} */ r) =>
    execFileSync('git', ['rev-parse', r], { cwd: root, encoding: 'utf8' }).trim();
  if (event !== 'pull_request') return { sha: rev('HEAD'), base: rev('HEAD') };
  return { sha: rev('HEAD^2'), base: rev('HEAD^1') };
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {string} [root]
 */
export function main(argv, env, root = appRoot()) {
  const s = settings(appConfig('visual-review', root));
  if (!s)
    throw new Error('.github/ci.json has no visual-review key: visual-shots has nothing to do');
  const [command, out] = argv;
  if (command === 'collect') {
    if (!out) throw new Error('usage: shots.mjs collect <out dir>');
    const files = shotsUnder(root, s.folders);
    for (const file of files) {
      mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
      copyFileSync(path.join(root, file), path.join(out, file));
    }
    const event = env.GITHUB_EVENT_NAME ?? '';
    /** @type {Manifest} */
    const manifest = parseManifest({
      version: 1,
      ...commitsOf(root, event),
      event,
      mockupIssue: mockupIssue(env.MOCKUP_ISSUE),
    });
    writeFileSync(path.join(out, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    return `${files.length} shot(s) collected`;
  }
  if (command === 'mockup') {
    // A mockup's table goes to its issue, and visual-review takes only
    // dispatches on the default branch: anything else would run and post
    // nowhere, so it's refused before the build.
    if (mockupIssue(env.MOCKUP_ISSUE) === null) {
      throw new Error("mockup_issue is required: the plan's issue, which the table goes on");
    }
    const defaultBranch = env.DEFAULT_BRANCH ?? '';
    if (!defaultBranch || env.GITHUB_REF !== `refs/heads/${defaultBranch}`) {
      const branch = defaultBranch || 'the default branch';
      throw new Error(
        `a mockup runs by hand on ${branch} only (this run is on ${env.GITHUB_REF || 'no ref'}): visual review takes no other branch's mockup, so run it again on ${branch}`,
      );
    }
    const patch = decodePatch(env.MOCKUP_PATCH ?? '');
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mockup-')), 'mockup.patch');
    writeFileSync(file, patch);
    const git = (/** @type {string[]} */ args) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git(['apply', '--check', file]);
    const problem = patchProblem({
      files: numstatFiles(git(['apply', '--numstat', '-z', file])),
      summary: git(['apply', '--summary', file]),
      s,
    });
    if (problem) throw new Error(problem);
    git(['apply', file]);
    return 'mockup patch applied';
  }
  throw new Error('usage: shots.mjs collect <out dir> | shots.mjs mockup');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(main(process.argv.slice(2), process.env));
}
