// Builds job-summary's report page for the GIF tool to record (ci#176): this
// repo's `gif.page` setting (.github/ci.json) names it, and the tool runs it
// once on each side, main's worktree and the PR's checkout (gif/build.ts):
//
//   node job-summary/gif/page.ts <out folder>
//
// It writes <out folder>/index.html, the report for fixture.ts's made-up
// run, built as a real run's is: buildModel, then report into report.html.
// So the page recorded is the side's own report.html and model.ts, and a PR
// that changes either is recorded with its change. The tool serves the
// folder at http://gif.test (gif/route.ts), where a scenario opens it at `/`.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildModel } from '../model.ts';
import { report } from '../report.ts';
import { fixture } from './fixture.ts';

/**
 * Writes the report page into `out`, made if need be.
 *
 * @returns the page's path
 */
export function buildPage(out: string) {
  mkdirSync(out, { recursive: true });
  const file = path.join(out, 'index.html');
  writeFileSync(file, report(buildModel(fixture())));
  return file;
}

/**
 * The command: builds into the folder `argv` names.
 *
 * @param argv the arguments after the script's path
 * @param log
 * @returns the exit code
 */
export function main(argv: readonly string[], log: (line: string) => void = console.log) {
  const [out] = argv;
  if (!out) {
    console.error('usage: node job-summary/gif/page.ts <out folder>');
    return 1;
  }
  log(`job-summary: wrote ${buildPage(path.resolve(out))}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
