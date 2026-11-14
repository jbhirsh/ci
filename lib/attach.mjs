// Uploading files to a PR as GitHub attachments, with gh: the steps gif's
// attach job (gif/publish.mjs, gif/workflow.mjs) and pictures/attach share.
//
// The caller writes a block into the PR's description that references each
// file by its local path (`![…](./<file>)`), and attachToDescription runs
// `gh pr edit --body-file … --attach ./<file>`: gh uploads each file and
// rewrites the reference to it in place with the uploaded URL
// (`https://github.com/user-attachments/assets/<id>`; ci#33's trial T1), at
// most ATTACH_LIMIT files an edit. The description is read again before each
// later edit, so the earlier edits' links are kept, and once they're all in
// it's read back to check that no reference was left local. Then
// attachmentLinksIn takes the links from the caller's block, and
// waitForLinks fetches each, signed out, until it answers 200, since an
// edited-in attachment goes live a moment after the edit.
//
// Needs gh ≥ 2.99 (lib/gh.mjs), and a token that may attach: a person's,
// such as the apps' BOT_PR_TOKEN; GitHub refuses the Actions token
// ("attaching files requires write access to the repository"). Only a PR's
// commands take `--attach` in gh 2.99, so an issue gets its pictures from a
// PR's attachments (pictures/cli.mjs).

import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** @typedef {import('./gh.mjs').Command} Command */

/** The most files one `gh pr edit --attach` takes, per gh's manual. */
export const ATTACH_LIMIT = 50;

/** The largest image GitHub takes as an attachment (its docs: 10 MB). */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The attachment links in a span of a description, in order.
 *
 * @param {string} text
 */
export function attachmentLinksIn(text) {
  return [...text.matchAll(/https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/g)].map(
    (m) => m[0],
  );
}

/**
 * Waits until every link answers 200, signed out, for up to `limitMs` in
 * all, each try given at most `everyMs` (or what's left of the limit);
 * throws naming the ones that never did.
 *
 * @param {readonly string[]} links
 * @param {{ prefix: string; label: string; fetch?: typeof globalThis.fetch; wait?: (ms: number) => Promise<unknown>; now?: () => number; limitMs?: number; everyMs?: number }} options
 *   prefix: the tool's, starting the error; label: what the links are, for
 *   it ("attached GIF(s)")
 */
export async function waitForLinks(
  links,
  {
    prefix,
    label,
    fetch = globalThis.fetch,
    wait = sleep,
    now = Date.now,
    limitMs = 60_000,
    everyMs = 5_000,
  },
) {
  /** @type {string[]} */
  const failed = [];
  // One deadline for all: they were edited in together.
  const until = now() + limitMs;
  for (const link of links) {
    /** @type {string} */
    let last;
    for (;;) {
      try {
        // A stalled connection is a failed try, not a wait past the deadline.
        const signal = AbortSignal.timeout(Math.max(1, Math.min(everyMs, until - now())));
        const response = await fetch(link, { redirect: 'follow', signal });
        await response.body?.cancel();
        if (response.status === 200) break;
        last = String(response.status);
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      if (now() >= until) {
        failed.push(`${link} (${last})`);
        break;
      }
      await wait(everyMs);
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `${prefix}: ${failed.length} ${label} didn't answer within ${limitMs / 1000} s: ${failed.join(', ')}`,
    );
  }
}

/**
 * Writes `body` into PR `pr`'s description and uploads `files` with it, at
 * most ATTACH_LIMIT a `gh pr edit`, reading the description again (`view`)
 * before each later edit; returns the description as gh left it. With
 * nothing to attach, it edits once if `body` differs from `was`, and not at
 * all if not.
 *
 * @param {{ repo: string; pr: string; cwd: string; files: readonly string[]; was: string; body: string; view: () => string; gh: Command; prefix: string; noun: string; log: (line: string) => void; span?: (body: string) => string }} options
 *   files: paths relative to `cwd`, where gh runs, each referenced in
 *   `body` as `](./<file>)`; was: the description `body` was made from;
 *   prefix: the tool's, starting each line it logs or throws; noun: what a
 *   file is ("GIF"), plural with an "s"; span: the part of the description
 *   gh left that this run wrote, where no reference may be left local (the
 *   whole of it by default): another run's leftover elsewhere isn't this one's
 */
export function attachToDescription({
  repo,
  pr,
  cwd,
  files,
  was,
  body,
  view,
  gh,
  prefix,
  noun,
  log,
  span = (text) => text,
}) {
  if (files.length === 0 && body === was) {
    log(`${prefix}: #${pr}'s description needs no change`);
    return was;
  }
  const bodyFile = path.join(cwd, `.${prefix}-body-${pr}.md`);
  try {
    // One edit at least: a change with nothing to attach (a block dropped).
    for (let i = 0; i < Math.max(files.length, 1); i += ATTACH_LIMIT) {
      if (i > 0) body = view();
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
          `${prefix}: attaching to #${pr} stopped after ${i} of ${files.length} ${noun}s; its description may still reference the rest locally (./…): run it again to attach them`,
          { cause: error },
        );
      }
    }
  } finally {
    rmSync(bodyFile, { force: true });
  }
  const after = view();
  const mine = span(after);
  const local = files.filter((file) => mine.includes(`](./${file})`));
  if (local.length > 0) {
    throw new Error(
      `${prefix}: gh uploaded the ${noun}s but left ${local.join(', ')} referenced locally in #${pr}'s description: gh's --attach no longer rewrites references as lib/attach.mjs expects`,
    );
  }
  log(
    files.length > 0
      ? `${prefix}: attached ${files.length} ${noun}${files.length === 1 ? '' : 's'} to #${pr}'s description`
      : `${prefix}: updated #${pr}'s description`,
  );
  return after;
}
