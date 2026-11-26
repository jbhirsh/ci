// Self-test of the changes tool against an app's checkout:
// `node pr-changes/selftest.mjs <app dir>`. An app whose PR template places
// no change slot doesn't use the tool, and that's said, not failed. One that
// does must see a slot filled in its own template without the rest of the
// description moving (changes.mjs's header says the rules), so a template
// edit that tore a slot, or put another tool's marker inside it, fails here
// and not on a PR. A template with a `pr-changes:revisions` pair must also
// get its Revisions table written (revisions.mjs), read back by the description
// check as naming the PR's head and no other, asking only for the new
// revision's row until it is filled (ci#140), and left alone by a second run.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bodyProblems } from '../pr-template/body.mjs';
import { fill, ownBlock, placed } from './changes.mjs';
import { revisions } from './revisions-run.mjs';

const TEMPLATE = '.github/pull_request_template.md';
const SHA = 'a'.repeat(40);

/**
 * Writes the Revisions table into the template as a push would, and checks it.
 *
 * @param {string} template
 * @returns {string} what to print; throws on the first problem
 */
function revisionsSelftest(template) {
  if (!ownBlock(template, 'revisions')) {
    return `pr-changes: ${TEMPLATE} has no revisions pair; Revisions not used.`;
  }
  const [opened, head] = ['b'.repeat(40), 'c'.repeat(40)];
  let body = template;
  /** @type {import('./revisions-run.mjs').Io} */
  const io = {
    pull: () => ({
      state: 'open',
      author: 'a',
      headRef: 'f',
      headSha: head,
      headRepo: 'owner/app',
    }),
    body: () => body,
    commits: () => [{ sha: head, subject: 'Second push', skipped: false }],
    compare: () => ({ status: 'ahead', behindBy: 0, base: opened, shas: [head] }),
    timeline: () => [],
    write: (text) => {
      body = text;
    },
    canWrite: true,
    log: () => {},
  };
  if (!revisions(io, { repo: 'owner/app', before: opened })) {
    throw new Error(`${TEMPLATE}: the Revisions table was not written for a pushed head`);
  }
  /** @param {string} sha */
  const problems = (sha, text = body) => bodyProblems(text, sha).filter((p) => /Revisions/.test(p));
  // The new revision's row is the author's (ci#140): the check asks for it, and only for it, until
  // it is filled.
  const fresh = problems(head);
  const filled = problems(head, body.replace('|  |  |', '| A change | Its reason |'));
  const asks =
    fresh.length === 1 &&
    fresh[0].startsWith(`fill Revisions' current revision, \`${head.slice(0, 7)}\``);
  if (!asks || filled.length > 0) {
    throw new Error(
      `${TEMPLATE}: the check should ask only for the new revision's row, then accept the table for its own head once filled; it says ${JSON.stringify(fresh)}, and filled ${JSON.stringify(filled)}`,
    );
  }
  if (problems(opened).length === 0) {
    throw new Error(`${TEMPLATE}: the check accepts the Revisions table for another head`);
  }
  const written = body;
  if (revisions(io, { repo: 'owner/app', before: opened }) || body !== written) {
    throw new Error(`${TEMPLATE}: running the Revisions step twice changed the description`);
  }
  return `pr-changes: ${TEMPLATE} gets its Revisions table, read back as current, its row asked for until filled.`;
}

/**
 * @param {string} root
 * @returns {string[]} what to print; throws on the first problem
 */
export function selftest(root) {
  const file = path.join(root, TEMPLATE);
  const template = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const slots = placed(template);
  if (slots.length === 0) return ['pr-changes: the PR template places no change slot; not used.'];
  const commits = slots.map((n) => ({
    sha: SHA,
    subject: `Change ${n}`,
    files: [{ path: 'src/a.ts', added: 1, removed: 0 }],
  }));
  const { body, problem } = fill(template, commits, { repo: 'owner/app', number: 1 });
  if (problem) throw new Error(`${TEMPLATE}: ${problem}`);
  // No token in a self-test, so the output is today's plain counts: no picture.
  if (body.includes('<picture>') || !body.includes('+1 −0')) {
    throw new Error(`${TEMPLATE}: without a token the counts must be plain text`);
  }
  const again = fill(body, commits, { repo: 'owner/app', number: 1 });
  if (again.body !== body)
    throw new Error(`${TEMPLATE}: filling the slots twice changed the description`);
  if (placed(body).length !== slots.length)
    throw new Error(`${TEMPLATE}: a filled slot is no longer a clean pair`);
  return [
    `pr-changes: ${TEMPLATE} places ${slots.length} change slot(s) and they fill.`,
    revisionsSelftest(template),
  ];
}

/**
 * Runs the self-test on the app at `argv[0]` and returns the exit code.
 *
 * @param {string[]} argv
 * @param {(line: string) => void} [log]
 * @returns {number}
 */
export function cli(argv, log = console.log) {
  try {
    for (const line of selftest(path.resolve(argv[0] ?? '.'))) log(line);
    return 0;
  } catch (error) {
    log(`pr-changes self-test failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cli(process.argv.slice(2));
}
