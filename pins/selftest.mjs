// Self-test of the pins check against an app's checkout:
// `node pins/selftest.mjs <app dir>`. It reads everything the check reads
// (package.json, Expo's list when the app uses Expo, Dependabot, every
// workflow and action.yml), so a file it can't take fails here before it
// fails the app's CI. The pins main holds are printed, not judged: the app's
// own CI step is what fails on them.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findings } from './check.mjs';

/**
 * Runs the check over the app and returns what to print; throws when a file
 * can't be read.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function selftest(root) {
  const found = findings(root);
  return [
    `pins: ${found.length} pinned without a reason.`,
    ...found.map(({ file, line, message }) => `  ${file}:${line}: ${message}`),
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
    log(`pins self-test failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cli(process.argv.slice(2));
}
