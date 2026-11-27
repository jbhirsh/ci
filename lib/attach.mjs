// Uploading files to a PR or an issue as GitHub attachments, with gh: the
// steps gif's attach job (gif/publish.ts, gif/workflow.ts), pictures/attach
// and visual review's attach job (visual-review/attach.ts) share.
//
// The caller writes a block into the description that references each
// file by its local path (`![…](./<file>)`), and attachToDescription runs
// `gh pr edit --body-file … --attach ./<file>` (`gh issue edit` for an
// issue): gh uploads each file and rewrites the reference to it in place
// with the uploaded URL
// (`https://github.com/user-attachments/assets/<id>`; ci#33's trial T1), at
// most ATTACH_LIMIT files an edit. The description is read again before each
// later edit, so the earlier edits' links are kept, and once they're all in
// it's read back to check that no reference was left local. Then
// attachmentLinksIn takes the links from the caller's block, which the caller
// checks are one for each file. Nothing fetches them: an edited-in attachment
// can answer 404 signed out for a moment after the edit, then goes live by
// itself (ci#144's trials), so the caller writes its table at once, as visual
// review does, rather than asking again on a timer (ci#58, ci#164).
//
// gh rewrites only a Markdown image's path, never an `<img src="./…">`, and
// adds a file it attached but found no reference to as an image at the end
// of the description (ci#144's V1), so a caller references each file once,
// as a Markdown image. Needs gh ≥ 2.99 for a PR and 2.104 for an issue
// (lib/gh.mjs), and a token that may attach: a person's, such as the apps'
// BOT_PR_TOKEN; GitHub refuses the Actions token ("attaching files requires
// write access to the repository").

import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** @typedef {import('./gh.mjs').Command} Command */

/** The most files one `gh pr edit --attach` (or `gh issue edit`) takes, per gh's manual. */
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
 * Writes `body` into PR `pr`'s description (issue `pr`'s, with `kind`
 * 'issue') and uploads `files` with it, at
 * most ATTACH_LIMIT a `gh pr edit`, reading the description again (`view`)
 * before each later edit; returns the description as gh left it. With
 * nothing to attach, it edits once if `body` differs from `was`, and not at
 * all if not.
 *
 * @param {{ repo: string; pr: string; kind?: 'pr' | 'issue'; cwd: string; files: readonly string[]; was: string; body: string; view: () => string; gh: Command; prefix: string; noun: string; log: (line: string) => void; span?: (body: string) => string }} options
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
  kind = 'pr',
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
          kind,
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
