// Self-test of the changes tool against an app's checkout:
// `node pr-changes/selftest.mjs <app dir>`. An app whose PR template places
// no change slot doesn't use the tool, and that's said, not failed. One that
// does must see a slot filled in its own template without the rest of the
// description moving (changes.mjs's header says the rules), so a template
// edit that tore a slot, or put another tool's marker inside it, fails here
// and not on a PR.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fill, placed } from './changes.mjs';

const TEMPLATE = '.github/pull_request_template.md';
const SHA = 'a'.repeat(40);

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
  return [`pr-changes: ${TEMPLATE} places ${slots.length} change slot(s) and they fill.`];
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
