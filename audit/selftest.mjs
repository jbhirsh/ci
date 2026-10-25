// Self-test of the weekly audit against an app's checkout, its dependencies
// installed: `node audit/selftest.mjs <app dir>`. Checks the app's `audit`
// settings parse and its graph folders exist, then runs knip and jscpd as
// the audit does, with the app's configs, and reads their reports (a dry
// run: no issue is touched, and what they find is printed, not judged).
// Lychee and Graphviz aren't run: the action installs them, not the app.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig } from '../lib/app.mjs';
import { main, settings, spawn as realSpawn } from './run.mjs';

/**
 * @param {string} root
 * @param {import('./run.mjs').Spawn} [spawn] how to run the tools
 * @returns {string[]} what to print; throws on the first problem
 */
export function selftest(root, spawn = realSpawn) {
  const { graph } = settings(appConfig('audit', root));
  const missing = graph.filter((folder) => !existsSync(path.join(root, folder)));
  if (missing.length > 0) {
    throw new Error(`audit.graph names what isn't there: ${missing.join(', ')}`);
  }
  const lines = [`audit: the graph would draw ${graph.join(', ')}.`];
  for (const check of ['knip', 'jscpd']) {
    const done = main([check, '--dry-run'], {
      root,
      env: {},
      spawn,
      gh: () => {
        throw new Error('a dry run calls no gh');
      },
      summary: () => {},
      setOutput: () => {},
      now: new Date(),
    });
    lines.push(`audit: ${done}`);
  }
  return lines;
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
    log(`audit self-test failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cli(process.argv.slice(2));
}
