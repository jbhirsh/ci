// The Files job of the pictures route (.github/workflows/pictures.yml,
// ci#133): takes the pictures a Claude session pushed to a `pictures/<name>`
// branch and writes the ones FILES names into a fresh folder, for
// pictures/from-branch/action.yml to upload as the run's artifact, which
// pictures/attach then attaches. A session can push a branch and dispatch a
// workflow but can't upload a file, so this is how its own pictures (a
// screenshot of GitHub's page, say) reach a description.
//
//   node pictures/branch.mjs name          checks BRANCH, sets the step output `branch`
//   node pictures/branch.mjs fetch <dir>   checks every other input, then writes the
//                                          named files into <dir>, which must not exist
//   node pictures/branch.mjs delete        deletes BRANCH (already gone is fine)
//
// Every input comes from whoever dispatched the run, so each is checked here,
// where it enters, and trusted after:
//   - BRANCH is `pictures/` then one name by the block's rule (a word
//     character, then word characters, `.` and `-`, no `--`, no `..`, not
//     ending in `.` or `.lock`), at most 100 characters: nothing else, so the
//     delete can't reach `main` or any other branch, and no value is an
//     option or another ref.
//   - FILES is parseFiles' (pictures/inputs.mjs), with no segment starting
//     with `-` or `.` (upload-artifact leaves hidden files out).
//   - HOST_PR and TARGET are numbers with nothing around them, as the run's
//     concurrency group is named for HOST_PR as given (an empty HOST_PR says
//     to set PICTURES_HOST_PR).
//   - The rest is pictures/attach's own check (parseInputs), run here first
//     so a bad TARGET stops the run before anything is uploaded.
//
// The branch is never checked out. Its tree and blobs are read through the
// REST API at `refs/heads/<branch>`, and only the named paths are taken,
// each a regular file (mode 100644: no link, no submodule, nothing
// executable) of at most the 10 MB GitHub attaches. ci is public and
// upload-artifact follows links, so a link on the branch, checked out, could
// put a runner's file in the artifact; read as a blob, it never becomes one.
// checkFiles (pictures/files.mjs) then holds each to its picture type.
//
// The delete goes by the branch's name, not the commit read: a push to the
// same branch after its tree was read is deleted with it, unread. GitHub has
// no conditional ref delete, so a check of its commit first would only
// narrow that; a session pushes once and uses a new name per dispatch
// (CONTRIBUTING.md, "Pictures from a session").
//
// This job holds only the Actions token (contents write, to read the branch
// and delete it), never the person's: pictures.yml's header says what the
// route trusts, and what it doesn't guard against.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { ATTACH_MAX_BYTES } from '../lib/attach.mjs';
import { ghApi, statusOf } from '../lib/comment.mjs';
import { checkFiles } from './files.mjs';
import { parseFiles, parseInputs, parseRepo } from './inputs.mjs';

/** @typedef {import('../lib/comment.mjs').Api} Api */
/** @typedef {import('./inputs.mjs').Picture} Picture */

/** The only branches the route reads and deletes. */
export const PREFIX = 'pictures/';

/** The longest branch name taken, prefix included. */
export const MAX_BRANCH = 100;

/** The artifact the Files job uploads and Attach downloads. */
export const ARTIFACT = 'pictures';

/**
 * BRANCH, exactly as given: `pictures/<name>`, or a `pictures: …` refusal.
 *
 * @param {string | undefined} value
 */
export function parseBranch(value) {
  const branch = value ?? '';
  const name = branch.startsWith(PREFIX) ? branch.slice(PREFIX.length) : '';
  if (
    branch.length > MAX_BRANCH ||
    !/^\w[\w.-]*$/.test(name) ||
    name.includes('--') ||
    name.includes('..') ||
    name.endsWith('.') ||
    name.endsWith('.lock')
  ) {
    throw new Error(
      `pictures: BRANCH is ${PREFIX}<name> (letters, digits, _, . and -, no -- or .., at most ${MAX_BRANCH} characters in all), not ${JSON.stringify(branch)}`,
    );
  }
  return branch;
}

/**
 * FILES, as parseFiles reads it, with no segment that starts with `-` (an
 * option, wherever a path is passed on) or `.` (a hidden file, which
 * upload-artifact leaves out).
 *
 * @param {string | undefined} value
 * @returns {Picture[]}
 */
export function parseNamedFiles(value) {
  const files = parseFiles(value);
  for (const { path: file } of files) {
    if (file.split('/').some((s) => s.startsWith('-') || s.startsWith('.'))) {
      throw new Error(
        `pictures: ${JSON.stringify(file)} has a name starting with - or ., which the route doesn't take`,
      );
    }
  }
  return files;
}

/**
 * Every input but BRANCH, checked as pictures/attach will check it, before
 * anything is read.
 *
 * @param {Record<string, string | undefined>} env
 */
export function parseRouteInputs(env) {
  const host = env.HOST_PR ?? '';
  if (host.trim() === '') {
    throw new Error(
      'pictures: no host PR: pass host-pr, or set the repository variable PICTURES_HOST_PR to a PR whose description may be overwritten',
    );
  }
  // The concurrency group is named for HOST_PR as given: " 7" would be PR 7
  // in another group, editing its description beside a run of pr-gif's.
  // TARGET is held to the same, so the two numbers read alike.
  for (const [name, value] of [
    ['HOST_PR', host],
    ['TARGET', env.TARGET ?? ''],
  ]) {
    if (!/^[1-9]\d*$/.test(value)) {
      throw new Error(
        `pictures: ${name} is a number with nothing around it, not ${JSON.stringify(value)}`,
      );
    }
  }
  const files = parseNamedFiles(env.FILES);
  const inputs = parseInputs({ ...env, RUN_ID: env.GITHUB_RUN_ID, ARTIFACT });
  return { ...inputs, files };
}

/**
 * @typedef {object} TreeEntry One entry of a recursive tree.
 * @property {string} path
 * @property {string} mode
 * @property {string} type
 * @property {string} sha
 * @property {number} [size]
 */

/**
 * The branch's tree, read through the API at `refs/heads/<branch>`.
 *
 * @param {Api} api
 * @param {string} repo
 * @param {string} branch
 * @returns {Map<string, TreeEntry>}
 */
function treeOf(api, repo, branch) {
  /** @type {{ ref?: string; object?: { type?: string; sha?: string } }} */
  let ref;
  try {
    ref = /** @type {typeof ref} */ (api('GET', `repos/${repo}/git/ref/heads/${branch}`));
  } catch (error) {
    if (statusOf(error) === 404) {
      throw new Error(`pictures: ${repo} has no branch ${branch}: push it before dispatching`, {
        cause: error,
      });
    }
    throw error;
  }
  if (ref?.ref !== `refs/heads/${branch}` || ref.object?.type !== 'commit') {
    throw new Error(`pictures: refs/heads/${branch} isn't a branch's commit`);
  }
  const commit = /** @type {{ tree: { sha: string } }} */ (
    api('GET', `repos/${repo}/git/commits/${ref.object.sha}`)
  );
  const tree = /** @type {{ tree: TreeEntry[]; truncated: boolean }} */ (
    api('GET', `repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`)
  );
  if (tree.truncated) {
    throw new Error(`pictures: ${branch} holds too many files to read: push only the pictures`);
  }
  return new Map(tree.tree.map((e) => [e.path, e]));
}

/**
 * Writes the named files from the branch into `dir`, a folder that must not
 * exist yet, then checks them as pictures.
 *
 * @param {{ api: Api; repo: string; branch: string; files: readonly Picture[]; dir: string }} options
 */
export function readBranch({ api, repo, branch, files, dir }) {
  const entries = treeOf(api, repo, branch);
  /** @type {Array<{ file: string; entry: TreeEntry }>} */
  const named = [];
  for (const { path: file } of files) {
    const entry = entries.get(file);
    if (!entry) throw new Error(`pictures: ${branch} has no ${file}`);
    if (entry.type !== 'blob' || entry.mode !== '100644') {
      const what =
        entry.mode === '120000' ? 'a link' : entry.type === 'commit' ? 'a submodule' : entry.type;
      throw new Error(
        `pictures: ${file} on ${branch} isn't a plain file (mode ${entry.mode}: ${what})`,
      );
    }
    if ((entry.size ?? Infinity) > ATTACH_MAX_BYTES) {
      throw new Error(`pictures: ${file} on ${branch} is over the 10 MB GitHub attaches`);
    }
    named.push({ file, entry });
  }
  mkdirSync(dir);
  for (const { file, entry } of named) {
    const blob = /** @type {{ content: string; encoding: string }} */ (
      api('GET', `repos/${repo}/git/blobs/${entry.sha}`)
    );
    const bytes = Buffer.from(blob.content, 'base64');
    if (blob.encoding !== 'base64' || bytes.length !== entry.size) {
      throw new Error(`pictures: ${file}'s blob didn't come back whole`);
    }
    const local = path.join(dir, file);
    mkdirSync(path.dirname(local), { recursive: true });
    writeFileSync(local, bytes, { flag: 'wx' });
  }
  checkFiles(dir, files);
}

/**
 * Deletes the branch; one already gone (a run redone) is no failure. GitHub
 * answers 422 for a delete it refuses too (a ruleset), so only its "Reference
 * does not exist" counts as gone.
 *
 * @param {{ api: Api; repo: string; branch: string; log: (line: string) => void }} options
 */
export function deleteBranch({ api, repo, branch, log }) {
  try {
    api('DELETE', `repos/${repo}/git/refs/heads/${branch}`);
    log(`pictures: deleted ${branch}`);
  } catch (error) {
    const status = statusOf(error);
    const gone =
      status === 404 || (status === 422 && /Reference does not exist/.test(String(error)));
    if (!gone) throw error;
    log(`pictures: ${branch} was already gone`);
  }
}

/**
 * @typedef {object} Context What main is handed, for tests.
 * @property {Record<string, string | undefined>} [env]
 * @property {Api} [api]
 * @property {(name: string, value: string) => void} [output]
 * @property {(line: string) => void} [log]
 * @property {(line: string) => void} [error]
 */

/**
 * The command line; returns its exit code.
 *
 * @param {readonly string[]} argv
 * @param {Context} [context]
 */
export function main(argv, context = {}) {
  const {
    env = process.env,
    api = ghApi,
    output = setOutput,
    log = console.log,
    error = console.error,
  } = context;
  const [command, dir, ...rest] = argv;
  const usage =
    rest.length > 0 ||
    !(
      (command === 'name' && dir === undefined) ||
      (command === 'delete' && dir === undefined) ||
      (command === 'fetch' && dir !== undefined)
    );
  if (usage) {
    error('usage: node pictures/branch.mjs name | fetch <dir> | delete');
    return 2;
  }
  try {
    const branch = parseBranch(env.BRANCH);
    if (command === 'name') {
      output('branch', branch);
    } else if (command === 'delete') {
      const repo = parseRepo(env.REPO);
      deleteBranch({ api, repo, branch, log });
    } else {
      const { repo, files } = parseRouteInputs(env);
      readBranch({ api, repo, branch, files, dir: /** @type {string} */ (dir) });
      log(`pictures: ${files.length} picture(s) from ${branch}`);
    }
    return 0;
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
