// changes.mjs against GitHub: the PR's description and commits through the
// REST API with the Actions token (GH_TOKEN), whose edits start no workflow,
// and the pictures of the counts (counts.mjs) attached with a person's token
// (UPLOAD_TOKEN), which GitHub requires for an attachment. A commit by a bot
// (a baseline refresh, say) or a merge (Update branch) isn't one of the
// author's changes and is left out. Each commit's files come from its own
// commit endpoint, a page of 100 at a time.
//
//   node run.mjs   (env: GH_TOKEN, GITHUB_REPOSITORY, NUMBER; optional:
//                   UPLOAD_TOKEN, TOKEN_LOGIN, EVENT_ACTION, SENDER)
//
// One run: pick the level the description fits at (changes.mjs chooseLevel);
// for each pair of counts it needs, reuse a picture the description's index
// names, after fetching its link signed out and comparing the bytes' hash
// with the image it would draw (an index is the PR author's to edit, so it is
// only a claim); upload what is missing, through a staging block of
// `![<hash>](./<file>)` lines that `gh pr edit --attach` rewrites to links;
// then write the description once, with the staging block gone and the index
// holding every link it uses. Without a token that may attach, or when a
// pair's pictures can't be had, its counts are plain text, and the run says so.
//
// HARD RULES for this job (action.yml says why, as it runs on
// `pull_request_target`, with a token, for a PR it doesn't trust):
//   - it checks out nothing and runs none of the PR's code: the PR is read as
//     data through the API;
//   - UPLOAD_TOKEN reaches only the `gh … --attach` call; GH_TOKEN, the
//     Actions token, makes every other call;
//   - an uploaded file's name is its content hash and size, never anything
//     from the PR;
//   - the index and the staging block are read only inside their own markers,
//     and a link is used only in GitHub's attachment form;
//   - at most MAX_PAIRS pairs are uploaded in a run;
//   - nothing waits on a timer: a link is checked once, when reused.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachToDescription } from '../lib/attach.mjs';
import { ghApi } from '../lib/comment.mjs';
import { ghIn } from '../lib/gh.mjs';
import { pages } from '../lib/github.mjs';
import { chooseLevel, dropBlock, fill, ownBlock, placed, plain, putBlock } from './changes.mjs';
import { ENTRY_CHARS, hashOf, images, indexText, picture, readIndex } from './counts.mjs';

/** How many times a write is worked out again because the description moved under it. */
const ATTEMPTS = 3;

/** The most pairs of counts one run uploads (two files each, as GitHub's limit is 50 an edit). */
export const MAX_PAIRS = 25;

/** A link's length, which every attachment link has: for measuring before any exists. */
const LINK_STAND_IN = `https://github.com/user-attachments/assets/${'0'.repeat(36)}`;

/** What the markers around the index and the staging block cost, before their content. */
const BLOCK_CHARS = 140;

/**
 * @typedef {object} Io
 * @property {() => string} body the description
 * @property {(body: string) => void} write
 * @property {() => import('./changes.mjs').Commit[]} commits the PR's commits
 *   by someone other than a bot, oldest first, with their files
 * @property {(link: string, sha: string) => Promise<boolean>} verify whether
 *   the link, fetched signed out, answers with bytes that hash to `sha`
 * @property {((files: { file: string, svg: string }[], body: string, was: string) => string) | null} upload
 *   attaches the files to the description, which is `body`, a staging block
 *   added to `was`, and returns the description as it is then; null when the
 *   run may not upload (no token, or the edit is the upload's own)
 * @property {(line: string) => void} log
 */

/**
 * The io for one PR.
 *
 * @param {{ api: import('../lib/comment.mjs').Api, repo: string, number: number,
 *   log: (line: string) => void, upload?: Io['upload'], verify?: Io['verify'] }} options
 * @returns {Io}
 */
export function gitHubIo({
  api,
  repo,
  number,
  log,
  upload = null,
  verify = (link, sha) => fetchVerify(link, sha, log),
}) {
  const issue = `repos/${repo}/issues/${number}`;
  return {
    body: () => String(/** @type {{ body?: string | null }} */ (api('GET', issue)).body ?? ''),
    write: (body) => {
      api('PATCH', issue, { body });
    },
    commits: () =>
      /** @type {{ sha: string, commit: { message: string }, parents: unknown[], author: { login: string } | null, committer: { login: string } | null }[]} */ (
        pages(api, `repos/${repo}/pulls/${number}/commits`)
      )
        .filter((c) => c.parents.length < 2 && !(c.author ?? c.committer)?.login.endsWith('[bot]'))
        .map((c) => ({
          sha: c.sha,
          subject: c.commit.message.split('\n')[0],
          files: /** @type {{ filename: string, additions: number, deletions: number }[]} */ (
            pages(api, `repos/${repo}/commits/${c.sha}`, 'files')
          ).map((f) => ({ path: f.filename, added: f.additions, removed: f.deletions })),
        })),
    verify,
    upload,
    log,
  };
}

/**
 * Whether a link answers, signed out, with bytes that hash to `sha`. Asked
 * once, never retried or waited on: a link not yet live just isn't reused.
 * Why a link failed is logged, as a notice.
 *
 * @param {string} link
 * @param {string} sha
 * @param {(line: string) => void} [log]
 * @returns {Promise<boolean>}
 */
export async function fetchVerify(link, sha, log = () => {}) {
  try {
    const response = await fetch(link, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) {
      log(`::notice::pr-changes: ${link} answered ${response.status}, not its bytes`);
      return false;
    }
    const same = hashOf(new Uint8Array(await response.arrayBuffer())) === sha;
    if (!same) log(`::notice::pr-changes: ${link} answered with other bytes than were attached`);
    return same;
  } catch (error) {
    log(
      `::notice::pr-changes: ${link} did not answer (${error instanceof Error ? error.message : error})`,
    );
    return false;
  }
}

/**
 * The upload, with gh: the files written under `dir` (named by their hash and
 * size alone), attached to PR `number` by a person's token.
 *
 * @param {{ repo: string, number: number, token: string, dir: string, view: () => string, log: (line: string) => void, run?: import('../lib/gh.mjs').Command }} options
 *   `run` is gh in `dir`, for a test to stand in for
 * @returns {NonNullable<Io['upload']>}
 */
export function ghUpload({ repo, number, token, dir, view, log, run = ghIn(dir) }) {
  // The person's token is for this one call: every other call uses the Actions token.
  /** @type {import('../lib/gh.mjs').Command} */
  const gh = (args, options = {}) =>
    run(args, { ...options, env: { ...process.env, GH_TOKEN: token } });
  return (files, body, was) => {
    mkdirSync(dir, { recursive: true });
    try {
      for (const { file, svg } of files) writeFileSync(path.join(dir, file), svg);
      return attachToDescription({
        repo,
        pr: String(number),
        cwd: dir,
        files: files.map((f) => f.file),
        was,
        body,
        view,
        gh,
        prefix: 'pr-changes',
        noun: 'picture',
        log,
        span: (text) => {
          const at = ownBlock(text, 'staging');
          return at ? text.slice(at.from, at.to) : '';
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * The pairs of counts a description shows at a level, each once, in order.
 *
 * @param {readonly import('./changes.mjs').Commit[]} commits
 * @param {import('./changes.mjs').Level} level
 * @returns {[number, number][]}
 */
export function pairsAt(commits, level) {
  if (level === 'totals') return [];
  /** @type {Map<string, [number, number]>} */
  const found = new Map();
  for (const c of commits) {
    if (c.files.length === 0) continue;
    const add = (/** @type {number} */ a, /** @type {number} */ r) =>
      found.set(`${a},${r}`, [a, r]);
    add(
      c.files.reduce((n, f) => n + f.added, 0),
      c.files.reduce((n, f) => n + f.removed, 0),
    );
    if (level === 'full') for (const f of c.files) add(f.added, f.removed);
  }
  return [...found.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

/**
 * The links for the pairs a description shows: reused from its index after
 * checking each, and uploaded when missing and the run may.
 *
 * @param {Io} io
 * @param {string} body
 * @param {readonly [number, number][]} pairs
 * @returns {Promise<Map<string, string>>} image hash → link
 */
async function resolve(io, body, pairs) {
  /** @type {Map<string, string>} */
  const known = new Map();
  const claimed = readIndex(body);
  /** @type {{ pair: [number, number], missing: { file: string, svg: string, sha: string }[] }[]} */
  const wanted = [];
  for (const pair of pairs) {
    /** @type {{ file: string, svg: string, sha: string }[]} */
    const missing = [];
    for (const image of images(...pair)) {
      const link = claimed.get(image.sha);
      if (link !== undefined && (await io.verify(link, image.sha))) known.set(image.sha, link);
      // A run that may not upload must not take away a picture the description already
      // shows because one fetch of it failed: it would have nothing to put back. The
      // description is the author's, so what it shows is theirs to show.
      else if (link !== undefined && !io.upload && body.includes(`"${link}"`)) {
        io.log(
          '::notice::pr-changes: kept a picture the description shows, which could not be checked again',
        );
        known.set(image.sha, link);
      } else missing.push(image);
    }
    if (missing.length > 0) wanted.push({ pair, missing });
  }
  if (wanted.length === 0) return known;
  if (!io.upload) {
    io.log(
      `::notice::pr-changes: ${wanted.length} pair(s) of counts have no picture and this run may not upload: they stay plain text`,
    );
    return known;
  }
  const uploading = wanted.slice(0, MAX_PAIRS);
  if (wanted.length > MAX_PAIRS) {
    io.log(
      `::notice::pr-changes: ${wanted.length} new pairs of counts, over the ${MAX_PAIRS} a run uploads: the rest stay plain text`,
    );
  }
  const files = uploading.flatMap((w) => w.missing);
  // The description is read again just before the edit, which overwrites it:
  // a person may have saved a change while the links were being checked.
  const was = io.body();
  const staging = files.map((f) => `![${f.sha}](./${f.file})`).join('\n');
  /** @type {string} */
  let after;
  try {
    after = io.upload(files, putBlock(was, 'staging', staging), was);
  } catch (error) {
    // Whatever gh left in the description, the final write drops the staging block.
    io.log(
      `::warning::pr-changes: attaching the pictures failed (${error instanceof Error ? error.message : error}): their counts stay plain text`,
    );
    return known;
  }
  const uploaded = readIndex(after);
  for (const f of files) {
    const link = uploaded.get(f.sha);
    if (link !== undefined) known.set(f.sha, link);
    else
      io.log(`::warning::pr-changes: no link came back for a picture; its counts stay plain text`);
  }
  return known;
}

/**
 * Fills the PR's change slots, writing only when the description changes.
 * It does nothing, and reads no commit, for a description with no slot. The
 * description is read again just before the write, and the edit worked out
 * again if a person changed it meanwhile, as describe does.
 *
 * @param {Io} io
 * @param {{ repo: string, number: number }} where
 * @returns {Promise<boolean>} whether the description was written
 */
export async function changes(io, where) {
  const first = io.body();
  if (placed(first).length === 0) return false;
  const commits = io.commits();

  /**
   * @param {number} a
   * @param {number} r
   */
  const stand = (a, r) => picture(a, r, { small: LINK_STAND_IN, large: LINK_STAND_IN });
  const reserve = (/** @type {number} */ n) => BLOCK_CHARS + 2 * n * ENTRY_CHARS;
  const level = chooseLevel(first, commits, where, {
    pair: stand,
    reserve: reserve(pairsAt(commits, 'full').length),
  });
  const pairs = level === null ? [] : pairsAt(commits, level);
  const known = pairs.length > 0 ? await resolve(io, first, pairs) : new Map();

  /**
   * @param {number} a
   * @param {number} r
   */
  const pair = (a, r) => {
    const [small, large] = images(a, r).map((i) => known.get(i.sha));
    return small !== undefined && large !== undefined
      ? picture(a, r, { small, large })
      : plain(a, r);
  };

  let current = io.body();
  for (let attempt = 1; ; attempt++) {
    // The staging block, if an upload left one, is gone from what is written.
    const clean = dropBlock(current, 'staging');
    const idx = (/** @type {string} */ text) =>
      indexText(new Map([...known].filter(([, link]) => text.includes(link))));
    const ask = indexText(known);
    const filled = fill(clean, commits, where, {
      pair,
      reserve: ask === '' ? 0 : ask.length + BLOCK_CHARS,
    });
    const index = idx(filled.body);
    const out =
      index === '' ? dropBlock(filled.body, 'index') : putBlock(filled.body, 'index', index);
    if (filled.problem) io.log(`::warning::pr-changes: ${filled.problem}`);
    if (out === current) return false;
    const now = io.body();
    if (now === current) {
      io.write(out);
      return true;
    }
    if (attempt === ATTEMPTS) {
      throw new Error(`the description kept changing: gave up after ${ATTEMPTS} reads`);
    }
    current = now;
    if (placed(current).length === 0) return false;
  }
}

/**
 * Whether this run may upload, and why not: it needs a token that may attach,
 * and it isn't woken by the upload's own edit (an `edited` event whose sender
 * is the token's own account), which would only find what was just uploaded.
 * Known limits of that rule: when a push's run is waiting and an upload's
 * edit queues a run behind it, GitHub keeps only the newer, so the push's
 * pairs stay plain until the next event; and where the token is the owner's
 * own account, the owner's hand edit of a description doesn't upload either.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function uploadAllowed(env) {
  if ((env.UPLOAD_TOKEN ?? '') === '') {
    return { ok: false, why: 'no token that may attach, so the counts are plain text' };
  }
  const own =
    env.EVENT_ACTION === 'edited' && env.SENDER !== undefined && env.SENDER === env.TOKEN_LOGIN;
  if (own)
    return { ok: false, why: "this run was woken by the token's own edit, so it uploads nothing" };
  return { ok: true };
}

/** @param {Record<string, string | undefined>} env */
export async function main(env) {
  const repo = env.GITHUB_REPOSITORY ?? '';
  const number = Number(env.NUMBER);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number) || number < 1) {
    throw new Error('pr-changes needs GITHUB_REPOSITORY and NUMBER');
  }
  const log = console.log;
  const verdict = uploadAllowed(env);
  if (!verdict.ok) log(`::notice::pr-changes: ${verdict.why}`);
  // The token is for the attach call alone: take it out of the environment
  // every other gh call inherits.
  const token = env.UPLOAD_TOKEN ?? '';
  delete env.UPLOAD_TOKEN;
  const view = () =>
    String(
      /** @type {{ body?: string | null }} */ (ghApi('GET', `repos/${repo}/issues/${number}`))
        .body ?? '',
    );
  const upload = verdict.ok
    ? ghUpload({
        repo,
        number,
        token,
        dir: path.join(env.RUNNER_TEMP ?? '/tmp', 'pr-changes'),
        view,
        log,
      })
    : null;
  return changes(gitHubIo({ api: ghApi, repo, number, log, upload }), { repo, number });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.env);
}
