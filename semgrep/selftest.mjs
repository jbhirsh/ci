// Self-test of the Semgrep gate against an app's checkout:
// `node semgrep/selftest.mjs <app dir>`. Checks the app's `semgrep`
// settings parse and name paths that exist, and prints the command the gate
// would run. Semgrep itself isn't run: it's a Python tool the action
// installs, and its registry rules change from week to week.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig } from '../lib/app.mjs';
import { missingPaths, semgrepArgs, settings } from './scan.mjs';

/**
 * @param {string} root
 * @returns {string[]} what to print
 */
export function selftest(root) {
  const options = settings(appConfig('semgrep', root));
  const missing = missingPaths(options, root);
  if (missing.length > 0)
    throw new Error(`semgrep.paths names what isn't there: ${missing.join(', ')}`);
  return [`semgrep: would run semgrep ${semgrepArgs(options).join(' ')}`];
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
    log(`semgrep self-test failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cli(process.argv.slice(2));
}
