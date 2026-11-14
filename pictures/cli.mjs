// Attaches pictures a CI run made (an artifact, such as sift's
// ios-screenshots) to an issue or a PR, as a table between
// `<!-- pictures:<block> -->` markers in its description (ci#60), so a
// Claude session, which can dispatch a workflow but can't upload, gets its
// mockups into a plan's issue. pictures/attach/action.yml runs it, in the
// artifact's folder, with its inputs in the environment (inputs.mjs):
//
//   node pictures/cli.mjs
//
// gh 2.99 takes `--attach` on a PR's commands only, so the files always
// upload through a host PR, one whose description may be overwritten (sift's
// is a throwaway draft):
//
// 1. The inputs and files are checked (inputs.mjs, files.mjs).
// 2. The host's `pictures:<block>` block, in place of an earlier one, gets
//    one `![caption](./file)` line a picture, and `gh pr edit --attach`
//    uploads them (lib/attach.mjs, at most 50 an edit), each line's path
//    rewritten to its upload's URL.
// 3. The host's description is read back, and its block must link exactly
//    one attachment a file, in order: anything else stops the run.
// 4. Each link is fetched, signed out, until it answers.
// 5. The target's `pictures:<block>` block gets the `<img>` table
//    (table.mjs), with a plain `gh issue edit` or `gh pr edit --body-file`
//    and no `--attach`, whichever the target is (the issues API sets
//    `pull_request` on a PR). A target that is the host itself has its
//    block become the table in a second edit.
// 6. The target's URL is logged.
//
// It runs none of the app's code and checks nothing out: it reads only the
// artifact's files, as bytes, and holds the token (GH_TOKEN, a person's:
// GitHub refuses the Actions token for attachments) for gh alone. gh has
// no conditional write, so two runs editing one description must take
// turns: the caller's job shares pr-gif's attach concurrency group for the
// host's number (action.yml says how).

import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachToDescription, attachmentLinksIn, waitForLinks } from '../lib/attach.mjs';
import { blocksFor } from '../lib/blocks.mjs';
import { ghIn } from '../lib/gh.mjs';
import { checkFiles } from './files.mjs';
import { parseInputs } from './inputs.mjs';
import { hostBlock, pictureTable } from './table.mjs';

/** The blocks this tool keeps: `<!-- pictures:<block> -->`. */
const blocks = blocksFor('pictures');

/**
 * @typedef {object} Context What main is handed, for tests.
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [cwd] the artifact's folder
 * @property {import('../lib/gh.mjs').Command} [gh] runs gh in `cwd`
 * @property {typeof globalThis.fetch} [fetch]
 * @property {(ms: number) => Promise<unknown>} [wait]
 * @property {(line: string) => void} [log]
 */

/**
 * Attaches the pictures; returns the target's URL.
 *
 * @param {Context} [context]
 */
export async function main(context = {}) {
  const {
    env = process.env,
    cwd = process.cwd(),
    gh = ghIn(cwd),
    fetch,
    wait,
    log = console.log,
  } = context;
  const inputs = parseInputs(env);
  const { repo, target, hostPr, block, files } = inputs;
  if (!env.GH_TOKEN) {
    throw new Error(
      "pictures: no token to attach with: pass a person's token, such as the app's BOT_PR_TOKEN (the Actions token can't attach)",
    );
  }
  checkFiles(cwd, files);

  /** @param {string} n */
  const issue = (n) =>
    /** @type {{ html_url: string; pull_request?: unknown }} */ (
      JSON.parse(gh(['api', `repos/${repo}/issues/${n}`]).stdout)
    );
  const host = issue(hostPr);
  if (!host.pull_request) throw new Error(`pictures: HOST_PR #${hostPr} is an issue, not a PR`);
  const goal = target === hostPr ? host : issue(target);
  const kind = goal.pull_request ? 'pr' : 'issue';

  /**
   * @param {'pr' | 'issue'} what
   * @param {string} n
   */
  const view = (what, n) =>
    /** @type {{ body: string | null }} */ (
      JSON.parse(gh([what, 'view', n, '--repo', repo, '--json', 'body']).stdout)
    ).body ?? '';

  const was = view('pr', hostPr);
  const after = attachToDescription({
    repo,
    pr: hostPr,
    cwd,
    files: files.map((f) => f.path),
    was,
    body: blocks.write(was, block, hostBlock(files, inputs)),
    view: () => view('pr', hostPr),
    gh,
    prefix: 'pictures',
    noun: 'picture',
    log,
    // Only this run's block: another's leftover elsewhere on a shared host isn't its own.
    span: (text) => {
      const at = blocks.find(text, block);
      return at ? text.slice(at.from, at.to) : '';
    },
  });

  const found = blocks.find(after, block);
  const links = found ? attachmentLinksIn(after.slice(found.from, found.to)) : [];
  if (links.length !== files.length) {
    throw new Error(
      `pictures: #${hostPr}'s pictures:${block} block links ${links.length} attachment(s), not the ${files.length} attached`,
    );
  }
  await waitForLinks(links, { prefix: 'pictures', label: 'attached picture(s)', fetch, wait });

  const table = pictureTable(
    links.map((url, i) => ({ url, caption: files[i].caption })),
    inputs,
  );
  const body = blocks.write(view(kind, target), block, table);
  const bodyFile = path.join(cwd, `.pictures-target-${target}.md`);
  try {
    writeFileSync(bodyFile, body);
    gh([kind, 'edit', target, '--repo', repo, '--body-file', bodyFile]);
  } finally {
    rmSync(bodyFile, { force: true });
  }
  log(`pictures: ${files.length} picture(s) in ${goal.html_url}`);
  return goal.html_url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.cause instanceof Error) console.error(error.cause.message);
    process.exitCode = 1;
  });
}
