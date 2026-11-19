// Self-test of the shared PR template against an app's checkout:
// `node pr-template/selftest.mjs <app dir>`. Every app uses the shared
// template (the check of a PR's description has no setting to turn it off):
// it must hold, in `.github/pull_request_template.md`, a template of
// the shared shape (structure.mjs), and use visual review, since that is
// what decides whether a screen changed once the box is gone. The master
// is this repo's own template, `.github/pull_request_template.md`. Only the
// shape is checked, by decision (ci#79): a copy whose comments differ passes,
// so a change to the master can't turn an app's required job red.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig } from '../lib/app.mjs';
import { problems } from './structure.mjs';

const TEMPLATE = '.github/pull_request_template.md';

/**
 * @param {string} root
 * @returns {string[]} what to print; throws on the first problem
 */
export function selftest(root) {
  if (Object.keys(appConfig('visual-review', root)).length === 0) {
    throw new Error('the shared template needs visual review (a `visual-review` key)');
  }
  const file = path.join(root, TEMPLATE);
  if (!existsSync(file)) throw new Error(`${TEMPLATE} is missing`);
  const found = problems(readFileSync(file, 'utf8'));
  if (found.length > 0) throw new Error(`${TEMPLATE}: ${found.join('; ')}`);
  return [`pr-template: ${TEMPLATE} has the shared shape.`];
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
    log(`pr-template self-test failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cli(process.argv.slice(2));
}
