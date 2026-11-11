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
// left local. The description is read just before each edit, so an edit
// made meanwhile by someone else is kept unless it lands in those seconds.
// The alt text's `GIF:` is what PR visuals counts when its pictures come
// from the visual baselines (ci#33), since the URL can't say what it
// holds. Markdown images can't take a width, so `cellWidth` doesn't apply
// there. Needs gh ≥ 2.99 (lib/gh.mjs), and a token that may attach: a
// person's, such as the apps' BOT_PR_TOKEN; GitHub refuses the Actions
// token ("attaching files requires write access to the repository").

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
 * A command run in `cwd`, returning what it printed; a failure throws
 * unless `allowFail`.
 *
 * @param {string} command
 * @param {string} cwd
 * @returns {Git}
 */
function commandIn(command, cwd) {
  return (args, { env, allowFail = false } = {}) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
    const out = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    if (out.status !== 0 && !allowFail) {
      throw new Error(
        `${command} ${args[0]} failed: ${(out.stderr || out.stdout).trim().slice(-800)}`,
      );
    }
    return out;
  };
}

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

/** The most files one `gh pr edit --attach` takes, per gh's manual. */
export const ATTACH_LIMIT = 50;

/**
 * The markers around a scenario's block in the PR's description.
 *
 * @param {string} key the scenario's name: no space, `<`, `>` or `--`, any
 *   of which could end the HTML comment the marker is
 */
export function blockMarkers(key) {
  if (!/^[^\s<>]+$/.test(key) || key.includes('--')) {
    throw new Error(
      `pr-gif: a scenario named ${JSON.stringify(key)} can't mark its block in a PR description; rename it`,
    );
  }
  return { start: `<!-- pr-gif:${key} -->`, end: `<!-- /pr-gif:${key} -->` };
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
  const { start, end } = blockMarkers(key);
  const marked = `${start}\n${block}\n${end}`;
  const found = findBlock(body, key);
  if (found) return body.slice(0, found.from) + marked + body.slice(found.to);
  return body.trimEnd() ? `${body.trimEnd()}\n\n${marked}\n` : `${marked}\n`;
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
  const { start, end } = blockMarkers(key);
  for (let from = body.lastIndexOf(start); from !== -1; from = body.lastIndexOf(start, from - 1)) {
    const to = body.indexOf(end, from);
    if (to !== -1) return { from, to: to + end.length };
    if (from === 0) break;
  }
  return null;
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

/**
 * gh in `cwd`, returning what it printed; a failure throws unless
 * `allowFail`.
 *
 * @param {string} cwd
 * @returns {Gh}
 */
export function ghIn(cwd) {
  return commandIn('gh', cwd);
}

/**
 * Uploads the scenarios' GIFs to the PR as attachments and puts each
 * scenario's table in its description, at most ATTACH_LIMIT files a
 * command. Returns the description as gh left it.
 *
 * @param {{ repo: string; pr: string; cwd: string; scenarios: readonly Published[]; base?: string; gh?: Gh; log?: (line: string) => void }} options
 *   pr: its number; scenarios: each GIF as a path relative to `cwd`. gh must
 *   be one that can attach (lib/gh.mjs's checkGh, which the attach action
 *   runs first).
 */
export function attachToPr({ repo, pr, cwd, scenarios, base, gh = ghIn(cwd), log = console.log }) {
  const files = shownFiles(scenarios);
  const read = () =>
    gh(['pr', 'view', pr, '--repo', repo, '--json', 'body', '--jq', '.body']).stdout.replace(
      /\n$/,
      '',
    );
  let body = read();
  for (const s of scenarios) body = withBlock(body, s.name, attachmentTable(s, { base }));
  const bodyFile = path.join(cwd, `.pr-gif-body-${pr}.md`);
  try {
    for (let i = 0; i < files.length; i += ATTACH_LIMIT) {
      if (i > 0) body = read();
      writeFileSync(bodyFile, body);
      const batch = files.slice(i, i + ATTACH_LIMIT);
      try {
        gh([
          'pr',
          'edit',
          pr,
          '--repo',
          repo,
          '--body-file',
          bodyFile,
          ...batch.flatMap((file) => ['--attach', `./${file}`]),
        ]);
      } catch (error) {
        throw new Error(
          `pr-gif: attaching to #${pr} stopped after ${i} of ${files.length} GIFs; its description may still reference the rest locally (./…): run it again to attach them`,
          { cause: error },
        );
      }
    }
  } finally {
    rmSync(bodyFile, { force: true });
  }
  const after = read();
  const local = files.filter((file) => after.includes(`](./${file})`));
  if (local.length > 0) {
    throw new Error(
      `pr-gif: gh uploaded the GIFs but left ${local.join(', ')} referenced locally in #${pr}'s description: gh's --attach no longer rewrites references as attachToPr expects (gif/publish.mjs)`,
    );
  }
  log(
    `pr-gif: attached ${files.length} GIF${files.length === 1 ? '' : 's'} to #${pr}'s description`,
  );
  return after;
}
