// Publishing a PR's GIFs: one commit on the app's pictures branch
// (`screenshots`, or the `gif.branch` setting), under a folder named for the
// PR, and the Before/After table for the PR description, each picture linked
// by that commit's SHA so a later push to the branch can't change what an
// old PR shows. The same for every app, whether its GIFs came from a browser
// (cli.mjs) or from videos its CI recorded (videos.mjs).
//
// Or the GIFs go up as the PR's attachments, and nothing is committed: the
// pr-gif.yml workflow's attach job (workflow.mjs) calls attachToPr, which
// writes each scenario's table into the PR's description between
// `<!-- pr-gif:<scenario> -->` markers (replacing an earlier one), each GIF
// referenced by its local path (`![GIF: <scenario> after](./pr-gif/…)`), and
// runs `gh pr edit --body-file … --attach ./pr-gif/…`. gh uploads each file
// and rewrites the reference to it in place with the uploaded URL
// (`https://github.com/user-attachments/assets/<id>`; tried in ci#33's
// trial T1), so there is nothing to read back but a check that none is
// left local (the markers are lib/blocks.mjs's, the upload
// lib/attach.mjs's). The description is read just before each edit, so an
// edit made meanwhile by someone else is kept unless it lands in those
// seconds.
// The alt text's `GIF:` is what PR visuals counts when its pictures come
// from the visual baselines (ci#33), since the URL can't say what it
// holds. Markdown images can't take a width, so `cellWidth` doesn't apply
// there. Needs gh ≥ 2.99 (lib/gh.mjs), and a token that may attach: a
// person's, such as the apps' BOT_PR_TOKEN; GitHub refuses the Actions
// token ("attaching files requires write access to the repository").
//
// Each block starts with the commit its GIFs were recorded at ("Recorded at
// `abc1234`.", "Recorded automatically at …" for pr-gif-attach.yml's), so an
// old one shows it. Only an automatic block is ever dropped (withoutBlock),
// once the PR no longer changes its scenario, or marked "Not updated for
// `<sha>`: …" (staleNote) when a later recording of it failed; a block
// attached by hand is never dropped or marked, though a later recording of
// its scenario replaces it, as any recording does. With `headSha`,
// attachToPr stops before its first edit once the PR's head has moved past
// it (HeadMovedError), so a run for an older push never overwrites a newer
// one's GIFs; once it has edited, it attaches the rest whatever the head.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { attachToDescription } from '../lib/attach.mjs';
import { blocksFor } from '../lib/blocks.mjs';
import { commandIn, ghIn } from '../lib/gh.mjs';

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
 * @typedef {import('../lib/gh.mjs').Command} Git Runs git in the app's checkout.
 */

/**
 * Git in `root`, returning what it printed; a failure throws unless
 * `allowFail`.
 *
 * @param {string} root
 * @returns {Git}
 */
export function gitIn(root) {
  return commandIn('git', root);
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

/** The scenarios' blocks in a PR's description: `<!-- pr-gif:<scenario> -->`. */
const blocks = blocksFor('pr-gif', { named: 'a scenario named', where: 'a PR description' });

/**
 * The markers around a scenario's block in the PR's description.
 *
 * @param {string} key the scenario's name: no space, `<`, `>` or `--`, any
 *   of which could end the HTML comment the marker is
 */
export function blockMarkers(key) {
  return blocks.markers(key);
}

/**
 * The description with the scenario's block in it: in place of an earlier
 * one, or after the rest.
 *
 * @param {string} body
 * @param {string} key
 * @param {string} block the table, without its markers
 */
export function withBlock(body, key, block) {
  return blocks.write(body, key, block);
}

/**
 * Where the scenario's block is in the description, markers included, or
 * null: the last start that an end follows, so a marker left without its
 * pair (an edit gone wrong) stays as it is, with what follows it.
 *
 * @param {string} body
 * @param {string} key
 * @returns {{ from: number; to: number } | null}
 */
export function findBlock(body, key) {
  return blocks.find(body, key);
}

/**
 * The description without the scenario's block, nor the blank line that
 * kept it apart from what came before; unchanged when it has none.
 *
 * @param {string} body
 * @param {string} key
 */
export function withoutBlock(body, key) {
  return blocks.remove(body, key);
}

/**
 * The names of every scenario block in the description, in order.
 *
 * @param {string} body
 */
export function blockKeys(body) {
  return blocks.keys(body);
}

/** A "Not updated" note at the start of a block's first line. */
const STALE = /^\*\*Not updated for [^\n]*?\.\*\* /;

/**
 * Whether the scenario's block was attached automatically
 * (pr-gif-attach.yml), so it may be dropped or marked: one attached by
 * hand never is.
 *
 * @param {string} body
 * @param {string} key
 */
export function isAutomatic(body, key) {
  const found = findBlock(body, key);
  if (!found) return false;
  const { start } = blockMarkers(key);
  const line = body
    .slice(found.from + start.length)
    .replace(/^\n/, '')
    .split('\n')[0]
    .replace(STALE, '');
  return /^Recorded automatically at `[0-9a-f]{7,40}`\./.test(line);
}

/**
 * The description with the scenario's block marked "Not updated" by `note`,
 * in place of any earlier note, or with its note taken off when `note` is
 * null; unchanged when it has no such block.
 *
 * @param {string} body
 * @param {string} key
 * @param {string | null} note one line, as staleText writes it
 */
export function staleNote(body, key, note) {
  const found = findBlock(body, key);
  if (!found) return body;
  const { start } = blockMarkers(key);
  const at = found.from + start.length + (body[found.from + start.length] === '\n' ? 1 : 0);
  const rest = body.slice(at, found.to).replace(STALE, '');
  return body.slice(0, at) + (note ? `${note} ` : '') + rest + body.slice(found.to);
}

/**
 * The note for a block whose scenario's later recording failed.
 *
 * @param {string} sha the commit that recording was for
 * @param {string} runUrl the run that failed
 */
export function staleText(sha, runUrl) {
  return `**Not updated for \`${sha.slice(0, 7)}\`: recording failed ([run](${runUrl})).**`;
}

/**
 * The line a block starts with: the commit its GIFs were recorded at.
 *
 * @param {string} sha
 * @param {{ automatic?: boolean; noBefore?: boolean }} [options]
 *   automatic: pr-gif-attach.yml's; noBefore: an automatic recording whose
 *   "before" couldn't be played (cli.mjs's --before-may-fail)
 */
export function recordedLine(sha, { automatic = false, noBefore = false } = {}) {
  return (
    `Recorded ${automatic ? 'automatically ' : ''}at \`${sha.slice(0, 7)}\`.` +
    (noBefore ? " No before: main couldn't play this scenario." : '')
  );
}

/**
 * The GIFs a scenario's table shows, so the ones attached: the side-by-side
 * GIF alone when there is one.
 *
 * @param {readonly Published[]} scenarios
 * @returns {string[]}
 */
export function shownFiles(scenarios) {
  return scenarios.flatMap(
    (s) =>
      /** @type {string[]} */ (s.sideBySide ? [s.sideBySide] : [s.before, s.after].filter(Boolean)),
  );
}

/**
 * One scenario's table for the description, each GIF referenced by its
 * local path (from the directory gh runs in) for gh to upload and replace.
 *
 * @param {Published} scenario its GIFs' local paths
 * @param {{ base?: string }} [options] base: what "before" was built from
 */
export function attachmentTable(scenario, { base = 'main' } = {}) {
  const { name } = scenario;
  /**
   * @param {string | null} file
   * @param {string} what
   */
  const img = (file, what) => (file ? `![GIF: ${name} ${what}](./${file})` : '(none)');
  if (scenario.sideBySide) {
    return [
      '| Scenario | Before / After |',
      '|---|---|',
      `| ${name} | ${img(scenario.sideBySide, 'before and after')} |`,
    ].join('\n');
  }
  return [
    `| Scenario | Before (\`${base}\`) | After |`,
    '|---|---|---|',
    `| ${name} | ${img(scenario.before, 'before')} | ${img(scenario.after, 'after')} |`,
  ].join('\n');
}

/**
 * @typedef {Git} Gh Runs gh in the directory the GIFs' paths are relative to.
 */

/** The PR's head moved past the commit the GIFs were recorded for. */
export class HeadMovedError extends Error {}

/**
 * Uploads the scenarios' GIFs to the PR as attachments and puts each
 * scenario's table in its description, at most ATTACH_LIMIT files a
 * command. Returns the description as gh left it.
 *
 * `change` makes the new description from the one read just before the
 * first edit: by default each scenario's table put in (withBlock). When
 * there is nothing to attach, the description is edited once if it
 * changed, and not at all if not. With `headSha`, the read before the
 * first edit also reads the PR's head, and a head other than it stops the
 * run (HeadMovedError) before anything is edited.
 *
 * @param {{ repo: string; pr: string; cwd: string; scenarios: readonly Published[]; base?: string; gh?: Gh; log?: (line: string) => void; headSha?: string; change?: (body: string) => string }} options
 *   pr: its number; scenarios: each GIF as a path relative to `cwd`. gh must
 *   be one that can attach (lib/gh.mjs's checkGh, which the attach action
 *   runs first).
 */
export function attachToPr({
  repo,
  pr,
  cwd,
  scenarios,
  base,
  gh = ghIn(cwd),
  log = console.log,
  headSha,
  change = (body) =>
    scenarios.reduce((b, s) => withBlock(b, s.name, attachmentTable(s, { base })), body),
}) {
  const files = shownFiles(scenarios);
  const view = () =>
    /** @type {{ body: string; headRefOid: string }} */ (
      JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'body,headRefOid']).stdout)
    );
  const read = () => {
    const { body, headRefOid } = view();
    if (headSha && headRefOid !== headSha) {
      throw new HeadMovedError(
        `pr-gif: #${pr}'s head moved on to ${headRefOid.slice(0, 7)} from ${headSha.slice(0, 7)}, which these GIFs are for: that push's own run attaches its GIFs`,
      );
    }
    return body;
  };
  const was = read();
  // Once the first edit is in, the rest must follow, or its local
  // references would stay: no head check after it.
  return attachToDescription({
    repo,
    pr,
    cwd,
    files,
    was,
    body: change(was),
    view: () => view().body,
    gh,
    prefix: 'pr-gif',
    noun: 'GIF',
    log,
  });
}
