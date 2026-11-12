// Self-test of the unmeasured check against an app's checkout:
// `node unmeasured/selftest.mjs <app dir>`. jbhirsh/ci's own CI doesn't run
// the app's tests, so there's no coverage report to compare; this checks
// what holds without one: the app's `unmeasured` setting parses, and says
// how many source files there are and which tracked files each entry's glob
// matches. It prints, never judges: the app's own CI step is what fails.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig } from '../lib/app.mjs';
import { matches } from '../lib/match.mjs';
import { isSource, readEntries, trackedFiles } from './check.mjs';

/**
 * Reads the app's setting and files and returns what to print; throws when
 * the setting can't be read.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function selftest(root) {
  const { entries, malformed } = readEntries(appConfig('unmeasured', root));
  const tracked = trackedFiles(root);
  return [
    `unmeasured: ${tracked.filter(isSource).length} source files, ${entries.length} listed globs.`,
    ...entries.flatMap(({ text, glob }) => {
      const count = tracked.filter((file) => isSource(file) && matches(file, glob)).length;
      const line = `  ${text} (${count} source files)`;
      return tracked.some((file) => matches(file, glob))
        ? [line]
        : [line, `warn  ${glob} matches no tracked file`];
    }),
    ...malformed.map((message) => `  malformed: ${message}`),
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
    log(`unmeasured self-test failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cli(process.argv.slice(2));
}
