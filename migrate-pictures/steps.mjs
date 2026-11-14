// The migration's steps (ci#33), each reading and adding to one state
// folder, which the workflow carries from run to run as an artifact:
//
//   meta.json          the app, its branch, and each step run so far
//   pictures.bundle    a git bundle of the picture branches (inventory)
//   inventory.json     every post linking picture history, each link resolved
//   plan.json, plan.md what will be uploaded and which posts change
//   host.json          the upload host PR, its repo, and its description before the first upload
//   mapping.jsonl      picture blob → attachment URL, a line per upload, appended at once
//   posts/<key>.json   each rewritten post: its original body and the body written
//   rewrite.md, verify.md, undo.md   each step's report
//
// Every step can be run again. upload skips what mapping.jsonl has; rewrite
// skips a post already rewritten, never replaces a saved original, and
// leaves (and lists) a post edited by hand since its last rewrite; undo
// restores only a post whose body is still the one written, and the host's
// description while it holds the uploads. A post GitHub won't let the step
// read or edit is listed and the step goes on; a rate limit still in force
// after the retries stops it. A step whose
// time runs out (github.mjs's OutOfTime) saves what it did and says to run
// it again from that run.
//
// Nothing here deletes a branch: the owner does, after verify's report,
// keeping pictures.bundle.

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkGh } from '../lib/gh.mjs';
import { findLinks, rewriteText } from './links.mjs';
import { ATTACH_MAX_BYTES, makePlan, planReport, postLabel } from './plan.mjs';
import { branchFiles, bundle, fetchPictures, openBundle, readBlob, resolver } from './pictures.mjs';
import { ApiError, OutOfTime, realClock } from './github.mjs';
import { editPost, listPosts, readPost } from './posts.mjs';

/** @typedef {import('./github.mjs').Client} Client */
/** @typedef {import('./github.mjs').Clock} Clock */
/** @typedef {import('./posts.mjs').Post} Post */
/** @typedef {import('./plan.mjs').Inventory} Inventory */
/** @typedef {import('./plan.mjs').Plan} Plan */
/** @typedef {import('./plan.mjs').LinkedPost} LinkedPost */

/** Pictures attached a command: gh's limit (ci#33's trial T1). */
export const BATCH = 50;

/** The attachment links gh writes for `![<blob>](./…)`. */
const UPLOADED =
  /!\[([0-9a-f]{40})\]\((https:\/\/github\.com\/user-attachments\/assets\/[\w-]+)\)/g;

/**
 * @typedef {object} Context What every step is given.
 * @property {string} state the state folder
 * @property {Client} api
 * @property {(line: string) => void} log
 * @property {string} [token] for git's fetch of a private repository
 * @property {Clock} [clock]
 * @property {(args: string[], cwd: string) => void} [gh] runs gh (for tests)
 * @property {typeof globalThis.fetch} [fetch] signed-out reads of the attachments
 * @property {string} [remote] where inventory fetches the branches from (for tests)
 */

/**
 * @param {string} state
 * @param {string} file
 */
const readJson = (state, file) => JSON.parse(readFileSync(path.join(state, file), 'utf8'));

/**
 * @param {string} state
 * @param {string} file
 * @param {unknown} value
 */
const writeJson = (state, file, value) => {
  mkdirSync(path.dirname(path.join(state, file)), { recursive: true });
  writeFileSync(path.join(state, file), `${JSON.stringify(value, null, 1)}\n`);
};

/**
 * The state's file, or a message saying which step makes it.
 *
 * @param {string} state
 * @param {string} file
 * @param {string} step
 */
function need(state, file, step) {
  if (!existsSync(path.join(state, file))) {
    throw new Error(
      `migrate-pictures: no ${file} in the state: run ${step} first, and pass its run's id as from-run`,
    );
  }
  return readJson(state, file);
}

/**
 * What GitHub said when it refused to read or edit this post (gone, hidden,
 * not the token's to edit, or a body it won't take), as `<status> (<its
 * message>)`; rethrows anything else, a rate limit still in force included.
 *
 * @param {unknown} error
 */
function refusal(error) {
  if (error instanceof ApiError && !error.limited && [403, 404, 410, 422].includes(error.status)) {
    return `${error.status}${error.detail ? ` (${error.detail})` : ''}`;
  }
  throw error;
}

/** The first line of the host PR's description while it holds uploads. */
const HOST_HEADER = 'Pictures moved off the picture branch (jbhirsh/ci#33)';

/**
 * Picture blob → attachment URL, from mapping.jsonl.
 *
 * @param {string} state
 * @returns {Map<string, string>}
 */
export function readMapping(state) {
  const file = path.join(state, 'mapping.jsonl');
  if (!existsSync(file)) return new Map();
  return new Map(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const { blob, url } = JSON.parse(line);
        return [blob, url];
      }),
  );
}

/**
 * Opens the state's bundle in a scratch folder.
 *
 * @param {string} state
 */
function openState(state) {
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-pictures-'));
  openBundle(path.join(state, 'pictures.bundle'), dir);
  return dir;
}

/**
 * Every post of the repos with its links into `repo`, resolved; with the
 * count of links left alone, by ref.
 *
 * @param {Client} api
 * @param {{ repo: string; repos: string[]; branch: string; legacy: string }} meta
 * @param {ReturnType<typeof resolver>} res
 * @param {(line: string) => void} log
 */
async function scan(api, { repo, repos, branch, legacy }, res, log) {
  /** @type {LinkedPost[]} */
  const posts = [];
  /** @type {Record<string, number>} */
  const kept = {};
  /** @type {Record<string, number>} */
  const scanned = {};
  for (const from of repos) {
    const all = await listPosts(api, from, log);
    scanned[from] = all.length;
    for (const post of all) {
      const links = findLinks(post.body, repo, { branch, legacy }).map((link) => ({
        ...link,
        ...res.resolve(link),
      }));
      for (const link of links.filter((l) => l.status === 'keep'))
        kept[link.ref] = (kept[link.ref] ?? 0) + 1;
      const picture = links.filter((l) => l.status !== 'keep');
      if (picture.length > 0) posts.push({ ...post, links: picture });
    }
  }
  return { posts, kept, scanned };
}

/**
 * inventory: fetches and bundles the picture branches, reads every post,
 * and resolves each link.
 *
 * @param {Context} context
 * @param {{ repo: string; repos: string[]; branch: string; legacy: string }} meta
 */
export async function inventory(
  { state, api, log, token, remote },
  { repo, repos, branch, legacy },
) {
  const meta = { repo, repos, branch, legacy };
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-pictures-'));
  try {
    const { tip, legacyBranches } = fetchPictures({ dir, ...meta, token, remote });
    bundle(dir, path.join(state, 'pictures.bundle'));
    const { posts, kept, scanned } = await scan(api, meta, resolver(dir, meta), log);
    /** @type {Inventory} */
    const found = {
      ...meta,
      tip,
      legacyBranches,
      scanned,
      posts,
      kept,
      files: branchFiles(dir, meta.branch),
    };
    writeJson(state, 'inventory.json', found);
    const links = posts.reduce((n, post) => n + post.links.length, 0);
    log(
      `migrate-pictures: ${posts.length} posts hold ${links} links into picture history; run plan next`,
    );
    return found;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * plan: what will be uploaded, where, and which posts change; the report.
 *
 * @param {Context} context
 * @param {{ host: number | null; includeOthers: boolean }} options
 */
export function plan({ state, log }, options) {
  /** @type {Inventory} */
  const found = need(state, 'inventory.json', 'inventory');
  const made = makePlan(found, options);
  writeJson(state, 'plan.json', made);
  const report = planReport(found, made, { batch: BATCH });
  writeFileSync(path.join(state, 'plan.md'), report);
  log(
    `migrate-pictures: ${made.pictures.length} pictures, ${made.rewrite.length} posts to rewrite; plan.md has the rest`,
  );
  return report;
}

/** @type {(args: string[], cwd: string) => void} */
function runGh(args, cwd) {
  const result = spawnSync('gh', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${result.stderr || result.error?.message}`);
}

/**
 * upload: attaches each planned picture not yet in mapping.jsonl to the
 * host PR's description, BATCH a command, recording each URL as it comes
 * back. The host's description is replaced each batch, so it should be a
 * throwaway PR of the token's owner (a closed trial PR, or a draft).
 *
 * @param {Context} context
 * @param {{ host: number; batch?: number }} options
 */
export async function upload(context, { host, batch = BATCH }) {
  const { state, api, log, gh = runGh } = context;
  /** @type {Plan} */
  const planned = need(state, 'plan.json', 'plan');
  const { repo } = planned;
  if (gh === runGh) checkGh();
  const pr =
    /** @type {{ body: string | null; user: { login: string }; pull_request?: unknown }} */ (
      await api.get(`repos/${repo}/issues/${host}`)
    );
  if (!pr.pull_request)
    throw new Error(
      `migrate-pictures: #${host} is an issue; host-pr must be a PR (issues can't take attachments)`,
    );
  // Its description is replaced, so it must hold no picture link the
  // rewrite would need, and it's saved once, for undo.
  /** @type {import('./plan.mjs').Inventory} */
  const found = need(state, 'inventory.json', 'inventory');
  if (found.posts.some((post) => post.repo === repo && post.kind === 'issue' && post.id === host)) {
    throw new Error(
      `migrate-pictures: #${host} links pictures the migration rewrites: pick another host-pr`,
    );
  }
  if (existsSync(path.join(state, 'host.json'))) {
    const saved = readJson(state, 'host.json');
    if (saved.pr !== host) {
      throw new Error(
        `migrate-pictures: this migration's uploads went to #${saved.pr}: pass host-pr ${saved.pr}`,
      );
    }
  } else writeJson(state, 'host.json', { pr: host, repo, original: pr.body ?? '' });
  const mapping = readMapping(state);
  const todo = planned.pictures.filter((p) => p.attach === 'ok' && !mapping.has(p.blob));
  log(`migrate-pictures: ${mapping.size} uploaded already, ${todo.length} to go, to #${host}`);
  if (todo.length === 0) return 0;
  const dir = openState(state);
  const work = mkdtempSync(path.join(tmpdir(), 'migrate-pictures-files-'));
  let done = 0;
  try {
    for (let i = 0; i < todo.length; i += batch) {
      const some = todo.slice(i, i + batch);
      for (const p of some) {
        const bytes = readBlob(dir, p.blob);
        if (bytes.length > ATTACH_MAX_BYTES)
          throw new Error(`migrate-pictures: ${p.blob} grew past 10 MB`);
        writeFileSync(path.join(work, `${p.blob}.${p.ext}`), bytes);
      }
      const body = [
        `${HOST_HEADER}, ${some.length} at a time: each batch replaces this description.`,
        '',
        ...some.map((p) => `![${p.blob}](./${p.blob}.${p.ext})`),
        '',
      ].join('\n');
      writeFileSync(path.join(work, 'body.md'), body);
      // The edit and each picture count against the hourly write limit.
      await api.pace.take(some.length + 1);
      gh(
        [
          'pr',
          'edit',
          String(host),
          '--repo',
          repo,
          '--body-file',
          'body.md',
          ...some.flatMap((p) => ['--attach', `./${p.blob}.${p.ext}`]),
        ],
        work,
      );
      const after =
        /** @type {{ body: string | null }} */ (await api.get(`repos/${repo}/issues/${host}`))
          .body ?? '';
      const got = new Map([...after.matchAll(UPLOADED)].map((m) => [m[1], m[2]]));
      const lines = some
        .filter((p) => got.has(p.blob))
        .map((p) =>
          JSON.stringify({ blob: p.blob, url: got.get(p.blob), ext: p.ext, size: p.size }),
        );
      if (lines.length > 0)
        appendFileSync(path.join(state, 'mapping.jsonl'), `${lines.join('\n')}\n`);
      done += lines.length;
      for (const p of some) rmSync(path.join(work, `${p.blob}.${p.ext}`), { force: true });
      if (lines.length < some.length) {
        throw new Error(
          `migrate-pictures: gh left ${some.length - lines.length} of ${some.length} pictures unlinked in #${host}; run upload again from this run to retry them`,
        );
      }
      log(`migrate-pictures: ${mapping.size + done} of ${mapping.size + todo.length} uploaded`);
    }
  } catch (error) {
    if (!(error instanceof OutOfTime)) throw error;
    log(
      `migrate-pictures: out of time after ${done} uploads; run upload again from this run to carry on`,
    );
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
  return 0;
}

/**
 * @typedef {object} Saved A rewritten post, in posts/<key>.json.
 * @property {Post} post the post as the inventory read it, its body the original
 * @property {string} original the body before the first rewrite
 * @property {string} written the body the last rewrite wrote
 */

/**
 * The new URL for each link of the inventory, from the mapping.
 *
 * @param {Inventory} found
 * @param {Map<string, string>} mapping
 */
function replacements(found, mapping) {
  /** @type {Map<string, string>} */
  const to = new Map();
  for (const post of found.posts) {
    for (const link of post.links) {
      const url = link.blob ? mapping.get(link.blob) : undefined;
      if (url) to.set(link.url, url);
    }
  }
  return to;
}

/**
 * rewrite: swaps each uploaded picture's links for its attachment URL in
 * every planned post, saving the original first. A post the token may not
 * edit is reported, not failed.
 *
 * @param {Context} context
 */
export async function rewrite(context) {
  const { state, api, log } = context;
  /** @type {Inventory} */
  const found = need(state, 'inventory.json', 'inventory');
  /** @type {Plan} */
  const planned = need(state, 'plan.json', 'plan');
  const mapping = readMapping(state);
  if (mapping.size === 0)
    throw new Error(
      'migrate-pictures: nothing uploaded yet: run upload first, and pass its run as from-run',
    );
  const to = replacements(found, mapping);
  const byKey = new Map(found.posts.map((post) => [post.key, post]));
  /** @type {string[]} */
  const report = [`## Picture migration: rewrite of ${planned.repo}`, ''];
  let edited = 0;
  let same = 0;
  /** @type {string[]} */
  const refused = [];
  /** @type {string[]} */
  const moved = [];
  try {
    for (const key of planned.rewrite) {
      const post = /** @type {LinkedPost} */ (byKey.get(key));
      /** @type {Post} */
      let live;
      try {
        live = await readPost(api, post);
      } catch (error) {
        refused.push(
          `- ${postLabel(post)}: ${refusal(error)} reading it: gone or hidden since the inventory`,
        );
        continue;
      }
      const next = rewriteText(live.body, planned.repo, (url) => to.get(url));
      if (next === live.body) {
        same++;
        continue;
      }
      // The original is saved before the edit, and an earlier run's is
      // never replaced, so undo always has the text before any rewrite. An
      // edit that fails some other way may still have landed, so its entry
      // stays: verify and undo read whether the post holds the original or
      // the written text.
      const file = `posts/${key}.json`;
      /** @type {Saved | null} */
      const before = existsSync(path.join(state, file)) ? readJson(state, file) : null;
      if (before && live.body !== before.written && live.body !== before.original) {
        // Edited by hand since an earlier rewrite: rewriting it again would
        // let undo put back the original over that edit.
        refused.push(
          `- ${postLabel(post)}: edited since an earlier rewrite: change its links by hand`,
        );
        continue;
      }
      if (live.body !== post.body && !before)
        moved.push(`- ${postLabel(post)}: edited since the inventory; its live text was rewritten`);
      // The post without its links, which the state's inventory holds.
      writeJson(state, file, {
        post: { ...post, links: undefined },
        original: live.body,
        ...before,
        written: next,
      });
      try {
        await editPost(api, post, next);
        edited++;
      } catch (error) {
        const status = refusal(error);
        // Refused, so not written: the saved entry goes back to what it was.
        if (before) writeJson(state, file, before);
        else rmSync(path.join(state, file));
        refused.push(
          `- ${postLabel(post)} by \`${post.author}\`: GitHub refused the edit, ${status}: change its links by hand`,
        );
      }
    }
  } catch (error) {
    if (!(error instanceof OutOfTime)) throw error;
    report.push('**Out of time: run rewrite again from this run to carry on.**', '');
  }
  report.push(
    `Rewrote ${edited} post(s); ${same} needed nothing (done before, or nothing of theirs uploaded); ${refused.length} refused.`,
  );
  if (refused.length) report.push('', '### Refused', '', ...refused);
  if (moved.length) report.push('', '### Edited since the inventory', '', ...moved);
  const text = `${report.join('\n')}\n`;
  writeFileSync(path.join(state, 'rewrite.md'), text);
  log(text);
  return refused.length > 0 ? 1 : 0;
}

/**
 * Whether an attachment answers 200 with a picture, signed out, retrying
 * for up to a minute (an edited-in attachment goes live a moment after,
 * ci#33's trial T1).
 *
 * @param {string} url
 * @param {{ fetch: typeof globalThis.fetch; clock: Clock }} options
 */
async function answers(url, { fetch, clock }) {
  let last = '';
  for (let tries = 0; tries < 12; tries++) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      await response.body?.cancel();
      const type = response.headers.get('content-type') ?? '';
      if (response.status === 200 && /^(image|video)\//.test(type)) return null;
      last = `${response.status} ${type}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await clock.wait(5000);
  }
  return last;
}

/**
 * verify: reads every post again, fresh, and fails unless none links
 * picture history, every rewritten post still holds what was written, and
 * every attachment answers signed out. Its report is what the owner reads
 * before deleting the branch.
 *
 * @param {Context} context
 */
export async function verify(context) {
  const { state, api, log, clock = realClock, fetch = globalThis.fetch } = context;
  /** @type {Inventory} */
  const found = need(state, 'inventory.json', 'inventory');
  const mapping = readMapping(state);
  const dir = openState(state);
  /** @type {string[]} */
  const problems = [];
  const report = [`## Picture migration: verify of ${found.repo}`, ''];
  try {
    const now = await scan(api, found, resolver(dir, found), log);
    const left = now.posts.flatMap((post) =>
      post.links.map((link) => `- ${postLabel(post)}: \`${link.url}\` (${link.status})`),
    );
    if (left.length)
      problems.push(`### Still linking picture history (${left.length})`, '', ...left, '');
    /** @type {string[]} */
    const changed = [];
    const saved = existsSync(path.join(state, 'posts'))
      ? readdirSync(path.join(state, 'posts'))
      : [];
    let rewritten = 0;
    for (const file of saved) {
      /** @type {Saved} */
      const entry = readJson(state, `posts/${file}`);
      try {
        // The original means the edit never landed: its links are listed above.
        const { body } = await readPost(api, entry.post);
        if (body === entry.written) rewritten++;
        else if (body !== entry.original)
          changed.push(
            `- ${postLabel(entry.post)}: edited since the rewrite, so undo can't restore it`,
          );
      } catch (error) {
        changed.push(`- ${postLabel(entry.post)}: ${refusal(error)} reading it: gone or hidden`);
      }
    }
    if (changed.length)
      problems.push(`### Changed since the rewrite (${changed.length})`, '', ...changed, '');
    /** @type {string[]} */
    const dead = [];
    for (const [blob, url] of mapping) {
      const why = await answers(url, { fetch, clock });
      if (why) dead.push(`- ${url} (picture ${blob}): ${why}`);
    }
    if (dead.length)
      problems.push(
        `### Attachments that don't answer signed out (${dead.length})`,
        '',
        ...dead,
        '',
      );
    const unlinked = found.files.filter((file) => !mapping.has(file.blob));
    report.push(
      '| | |',
      '|---|---|',
      `| Posts read again | ${Object.values(now.scanned).reduce((a, b) => a + b, 0)} |`,
      `| Links into picture history left | ${left.length} |`,
      `| Posts holding the rewrite (originals saved for undo) | ${rewritten} |`,
      `| Attachments checked | ${mapping.size} |`,
      `| Links left alone (other refs) | ${Object.values(now.kept).reduce((a, b) => a + b, 0)} |`,
      `| Branch files no post linked (only in the bundle) | ${unlinked.length} |`,
      '',
      problems.length
        ? '**Not ready: keep the branch until each problem below is solved.**'
        : `**Ready.** Save \`pictures.bundle\` from this run's artifact, then delete \`${found.branch}\`${found.legacyBranches.length ? ` and ${found.legacyBranches.join(', ')}` : ''}. To bring it back: \`git push origin ${found.tip}:refs/heads/${found.branch}\` from the bundle.`,
      '',
      ...problems,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const text = `${report.join('\n')}\n`;
  writeFileSync(path.join(state, 'verify.md'), text);
  log(text);
  return problems.length > 0 ? 1 : 0;
}

/**
 * undo: puts back each rewritten post's original body, where the post still
 * holds what the rewrite wrote, and the host PR's description while it
 * holds the uploads; lists the ones edited since.
 *
 * @param {Context} context
 */
export async function undo({ state, api, log }) {
  const dir = path.join(state, 'posts');
  const files = existsSync(dir) ? readdirSync(dir) : [];
  let restored = 0;
  let already = 0;
  /** @type {string[]} */
  const conflicts = [];
  let stopped = false;
  for (const file of files) {
    /** @type {Saved} */
    const entry = readJson(state, `posts/${file}`);
    try {
      const live = await readPost(api, entry.post);
      if (live.body === entry.original) already++;
      else if (live.body === entry.written) {
        await editPost(api, entry.post, entry.original);
        restored++;
      } else
        conflicts.push(
          `- ${postLabel(entry.post)}: edited since the rewrite; its original is in \`posts/${file}\``,
        );
    } catch (error) {
      if (error instanceof OutOfTime) {
        stopped = true;
        break;
      }
      conflicts.push(
        `- ${postLabel(entry.post)}: ${refusal(error)} reading or editing it; its original is in \`posts/${file}\``,
      );
    }
  }
  // The host PR's own description, while it still holds the uploads.
  if (!stopped && existsSync(path.join(state, 'host.json'))) {
    const { pr, repo, original } = readJson(state, 'host.json');
    /** @type {Post} */
    const host = {
      key: '',
      repo,
      kind: 'issue',
      id: pr,
      number: null,
      html: `https://github.com/${repo}/pull/${pr}`,
      author: '',
      updatedAt: '',
      body: '',
    };
    try {
      if ((await readPost(api, host)).body.startsWith(HOST_HEADER)) {
        await editPost(api, host, original);
        restored++;
      }
    } catch (error) {
      if (!(error instanceof OutOfTime))
        conflicts.push(`- the host, #${pr}: ${refusal(error)}; its original is in \`host.json\``);
      else stopped = true;
    }
  }
  const text = [
    '## Picture migration: undo',
    '',
    ...(stopped ? ['**Out of time: run undo again from this run to carry on.**', ''] : []),
    `Restored ${restored} post(s); ${already} already held their original; ${conflicts.length} left as they are.`,
    ...(conflicts.length ? ['', ...conflicts] : []),
    '',
  ].join('\n');
  writeFileSync(path.join(state, 'undo.md'), text);
  log(text);
  return conflicts.length > 0 || stopped ? 1 : 0;
}
