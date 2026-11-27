// Publishing a PR's GIFs: one commit on the app's pictures branch
// (`screenshots`, or the `gif.branch` setting), under a folder named for the
// PR, and the Before/After table for the PR description, each picture linked
// by that commit's SHA so a later push to the branch can't change what an
// old PR shows. The same for every app, whether its GIFs came from a browser
// (cli.ts) or from videos its CI recorded (videos.ts).
//
// Or the GIFs go up as the PR's attachments, and nothing is committed: the
// pr-gif.yml workflow's attach job (workflow.ts) calls attachToPr, which
// writes each scenario's table into the PR's description between
// `<!-- pr-gif:<scenario> -->` markers (replacing an earlier one; an author's
// empty pair under a change wins over a block of the tool's own elsewhere,
// which is removed, unless a block attached by hand follows it: withBlock says),
// each GIF
// referenced by its local path (`![GIF: <scenario> after](./pr-gif/…)`), and
// runs `gh pr edit --body-file … --attach ./pr-gif/…`. gh uploads each file
// and rewrites the reference to it in place with the uploaded URL
// (`https://github.com/user-attachments/assets/<id>`; tried in ci#33's
// trial T1), so there is nothing to read back but a check that none is
// left local (the markers are lib/blocks.ts's, the upload
// lib/attach.ts's, both shared with pictures/). The description is read
// just before each edit, so an edit made meanwhile by someone else is kept
// unless it lands in those seconds.
// The alt text's `GIF:` is what the review looks for as a picture of motion,
// since the URL can't say what it holds. Markdown images can't take a width, so `cellWidth` doesn't apply
// there. Needs gh ≥ 2.99 (lib/gh.ts), and a token that may attach: a
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
import { attachToDescription } from '../lib/attach.ts';
import { blocksFor } from '../lib/blocks.ts';
import { commandIn, ghIn } from '../lib/gh.ts';
import type { Command } from '../lib/gh.ts';

/** Over this, a PR description may not show a GIF. */
export const GIF_WARN_BYTES = 5 * 1024 * 1024;

/**
 * The owner/name of a GitHub remote, for the raw links: https (with or
 * without a token or `.git`), `git@github.com:`, `ssh://`, an SSH host alias
 * such as `github.com-work`, or a local git proxy's URL that ends in them
 * (http://127.0.0.1:41799/git/owner/name, as a sandbox's remote is).
 */
export function repoFromRemote(url: string) {
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
 */
export function rawUrl(repo: string, sha: string, file: string) {
  return `https://raw.githubusercontent.com/${repo}/${sha}/${file}`;
}

/**
 * A scenario's GIFs' names in its PR's folder.
 */
export function gifNames(name: string) {
  return {
    before: `${name}-before.gif`,
    after: `${name}-after.gif`,
    side: `${name}-side-by-side.gif`,
  };
}

/** One scenario's GIFs, as paths on the pictures branch, or null for one not made. */
export type Published = {
  name: string;
  before: string | null;
  after: string | null;
  sideBySide: string | null;
};

/**
 * The PR description's table: a Before | After row per scenario (an
 * after-only one shows "(none)" before), and the side-by-side GIFs in a
 * table of their own, twice as wide, each linked by the commit's SHA.
 *
 * @param repo
 * @param sha
 * @param scenarios
 * @param options width: each GIF's in the table; base: what "before" was built from
 */
export function markdownTable(
  repo: string,
  sha: string,
  scenarios: readonly Published[],
  { width = 400, base = 'main' }: { width?: number; base?: string } = {},
) {
  const img = (file: string | null, w: number) =>
    file ? `<img src="${rawUrl(repo, sha, file)}" width="${w}">` : '(none)';
  const rows: string[] = [];
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
 */
export function sizeNote(file: string, bytes: number) {
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

/** Runs git in the app's checkout. */
export type Git = Command;

/**
 * Git in `root`, returning what it printed; a failure throws unless
 * `allowFail`.
 */
export function gitIn(root: string): Git {
  return commandIn('git', root);
}

/**
 * The commit adding `files` (each [path on the branch, local file]) on top
 * of the branch's tip as origin has it, built in a scratch index so the
 * checkout and its own index are never touched. A branch origin doesn't
 * have yet starts here, with a vercel.json that turns its deploys off.
 *
 * @param git
 * @param files
 * @param message
 * @param branch
 * @param scratch a directory for the scratch index
 */
export function commitOnTip(
  git: Git,
  files: readonly (readonly [string, string])[],
  message: string,
  branch: string,
  scratch: string,
): { commit: string; parent: string | null } {
  const fetched = git(['fetch', '-q', 'origin', `refs/heads/${branch}`], { allowFail: true });
  const parent = fetched.status === 0 ? git(['rev-parse', 'FETCH_HEAD']).stdout.trim() : null;
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
  rmSync(env.GIT_INDEX_FILE, { force: true });
  const add = (file: string) => git(['hash-object', '-w', file], { env }).stdout.trim();
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
 */
export function publishFiles(
  git: Git,
  files: readonly (readonly [string, string])[],
  {
    message,
    branch,
    push,
    log = console.log,
  }: { message: string; branch: string; push: boolean; log?: (line: string) => void },
) {
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
 * @param key the scenario's name: no space, `<`, `>` or `--`, any
 *   of which could end the HTML comment the marker is
 */
export function blockMarkers(key: string) {
  return blocks.markers(key);
}

/**
 * Every complete pair of a scenario's markers, in order: a start and the
 * first end after it, as `findBlock` takes them, so a start left without its
 * end is no pair, and a pair never reaches into a later one.
 */
function pairsOf(body: string, key: string): { from: number; to: number; inner: string }[] {
  const { start, end } = blockMarkers(key);
  const found: { from: number; to: number; inner: string }[] = [];
  let limit = body.length;
  for (let from = body.lastIndexOf(start); from !== -1;) {
    const at = body.indexOf(end, from);
    if (at !== -1 && at + end.length <= limit) {
      found.push({ from, to: at + end.length, inner: body.slice(from + start.length, at) });
      limit = from;
    }
    from = from === 0 ? -1 : body.lastIndexOf(start, from - 1);
  }
  return found.reverse();
}

/** What a pair holds when an author has put it there and nothing has filled it yet. */
const EMPTY = /^[ \t\r\n]*$/;

/**
 * The description with the scenario's block in it: in place of an earlier
 * one, or after the rest.
 *
 * An author's empty pair under a change wins over a block of the tool's own
 * elsewhere (the last one is where `findBlock`, and so every other caller,
 * looks, so a pair added after the block was written would stay empty): the
 * block goes into the last empty pair, and every automatic block of the
 * scenario is removed, whether it stands before or after that pair. Only when
 * every pair after the empty one is automatic; a block attached by hand is
 * never dropped, and then the block replaces the last pair, as always. The
 * pair is last once the others are gone, so `findBlock` returns what was
 * written.
 *
 * @param body
 * @param key
 * @param block the table, without its markers
 */
export function withBlock(body: string, key: string, block: string) {
  const { start, end } = blockMarkers(key);
  const pairs = pairsOf(body, key);
  const target = pairs.findLast((p) => EMPTY.test(p.inner));
  if (target) {
    const autos = pairs.filter((p) => p !== target && automaticInner(p.inner));
    if (
      autos.length > 0 &&
      pairs.every((p) => p.from < target.from || p === target || automaticInner(p.inner))
    ) {
      // From the last range to the first, so each one's place still holds.
      let out = body;
      for (const p of [...autos, target].sort((a, b) => b.from - a.from)) {
        if (p === target) {
          out = `${out.slice(0, p.from)}${start}\n${block}\n${end}${out.slice(p.to)}`;
        } else {
          const head = out.slice(0, p.from).trimEnd();
          const tail = out.slice(p.to).replace(/^(?:\r?\n)+/, '');
          out = head && tail ? `${head}\n\n${tail}` : head || tail;
        }
      }
      return out;
    }
  }
  return blocks.write(body, key, block);
}

/**
 * Where the scenario's block is in the description, markers included, or
 * null: the last start that an end follows, so a marker left without its
 * pair (an edit gone wrong) stays as it is, with what follows it.
 */
export function findBlock(body: string, key: string): { from: number; to: number } | null {
  return blocks.find(body, key);
}

/**
 * The description without the scenario's block, nor the blank line that
 * kept it apart from what came before; unchanged when it has none.
 */
export function withoutBlock(body: string, key: string) {
  return blocks.remove(body, key);
}

/**
 * The names of every scenario block in the description, in order.
 */
export function blockKeys(body: string) {
  return blocks.keys(body);
}

/** A "Not updated" note at the start of a block's first line. */
const STALE = /^\*\*Not updated for [^\n]*?\.\*\* /;

/**
 * Whether the scenario's block was attached automatically
 * (pr-gif-attach.yml), so it may be dropped or marked: one attached by
 * hand never is.
 */
export function isAutomatic(body: string, key: string) {
  const found = findBlock(body, key);
  if (!found) return false;
  const { start } = blockMarkers(key);
  return automaticInner(body.slice(found.from + start.length));
}

/**
 * Whether what follows a block's start marker is an automatic block's first
 * line: "Recorded automatically at …", after any stale note.
 */
function automaticInner(text: string) {
  const line = text
    .replace(/^\r?\n/, '')
    .split(/\r?\n/)[0]
    .replace(STALE, '');
  return /^Recorded automatically at `[0-9a-f]{7,40}`\./.test(line);
}

/**
 * The description with the scenario's block marked "Not updated" by `note`,
 * in place of any earlier note, or with its note taken off when `note` is
 * null; unchanged when it has no such block.
 *
 * @param body
 * @param key
 * @param note one line, as staleText writes it
 */
export function staleNote(body: string, key: string, note: string | null) {
  const found = findBlock(body, key);
  if (!found) return body;
  const { start } = blockMarkers(key);
  const after = found.from + start.length;
  const at = after + (/^\r?\n/.exec(body.slice(after, after + 2))?.[0].length ?? 0);
  const rest = body.slice(at, found.to).replace(STALE, '');
  return body.slice(0, at) + (note ? `${note} ` : '') + rest + body.slice(found.to);
}

/**
 * The note for a block whose scenario's later recording failed.
 *
 * @param sha the commit that recording was for
 * @param runUrl the run that failed
 */
export function staleText(sha: string, runUrl: string) {
  return `**Not updated for \`${sha.slice(0, 7)}\`: recording failed ([run](${runUrl})).**`;
}

/**
 * The line a block starts with: the commit its GIFs were recorded at.
 *
 * @param sha
 * @param options
 *   automatic: pr-gif-attach.yml's; noBefore: an automatic recording whose
 *   "before" couldn't be played (cli.ts's --before-may-fail)
 */
export function recordedLine(
  sha: string,
  { automatic = false, noBefore = false }: { automatic?: boolean; noBefore?: boolean } = {},
) {
  return (
    `Recorded ${automatic ? 'automatically ' : ''}at \`${sha.slice(0, 7)}\`.` +
    (noBefore ? " No before: main couldn't play this scenario." : '')
  );
}

/**
 * The GIFs a scenario's table shows, so the ones attached: the side-by-side
 * GIF alone when there is one.
 */
export function shownFiles(scenarios: readonly Published[]): string[] {
  return scenarios.flatMap(
    (s) => (s.sideBySide ? [s.sideBySide] : [s.before, s.after].filter(Boolean)) as string[],
  );
}

/**
 * One scenario's table for the description, each GIF referenced by its
 * local path (from the directory gh runs in) for gh to upload and replace.
 *
 * @param scenario its GIFs' local paths
 * @param options base: what "before" was built from
 */
export function attachmentTable(scenario: Published, { base = 'main' }: { base?: string } = {}) {
  const { name } = scenario;
  const img = (file: string | null, what: string) =>
    file ? `![GIF: ${name} ${what}](./${file})` : '(none)';
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

/** Runs gh in the directory the GIFs' paths are relative to. */
export type Gh = Git;

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
 * @param options
 *   pr: its number; scenarios: each GIF as a path relative to `cwd`. gh must
 *   be one that can attach (lib/gh.ts's checkGh, which the attach action
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
}: {
  repo: string;
  pr: string;
  cwd: string;
  scenarios: readonly Published[];
  base?: string;
  gh?: Gh;
  log?: (line: string) => void;
  headSha?: string;
  change?: (body: string) => string;
}) {
  const files = shownFiles(scenarios);
  const view = () =>
    JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'body,headRefOid']).stdout) as {
      body: string;
      headRefOid: string;
    };
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
