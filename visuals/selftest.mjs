// Self-test of the PR visuals check against an app's checkout:
// `node visuals/selftest.mjs <app dir>`. An app that no longer uses the check
// (no `visuals` key and no workflow calling jbhirsh/ci/visuals, as once
// ci#112 retires it from the app) has nothing to test and is skipped. Otherwise
// it checks that
//   - the app's `visuals` settings parse (or the defaults, without them);
//   - every `ui` glob the app sets still names a file git tracks, so a renamed folder
//     can't quietly switch the check off;
//   - with `visuals.sharedTemplate`, nothing of the box cases (the template has
//     no box; pr-template/selftest.mjs checks it, and the description check,
//     pr-template/check-body.mjs, holds each PR to the shape);
//   - otherwise the app's PR template (.github/pull_request_template.md), untouched,
//     fails a UI change, since its example pictures sit in a comment, and
//     passes it once "No visible UI change" is ticked.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig } from '../lib/app.mjs';
import { matchesAny, pick } from '../lib/match.mjs';
import { checkPrVisuals, settings } from './check.mjs';

export const TEMPLATE = '.github/pull_request_template.md';

/**
 * Whether one of the app's workflows still calls the PR visuals action.
 *
 * @param {string} root
 */
function callsVisuals(root) {
  const dir = path.join(root, '.github', 'workflows');
  if (!existsSync(dir)) return false;
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .some((name) => /jbhirsh\/ci\/visuals@/.test(readFileSync(path.join(dir, name), 'utf8')));
}

/**
 * @param {string} root
 * @returns {string[]} what to print; throws on the first problem
 */
export function selftest(root) {
  const config = appConfig('visuals', root);
  if (Object.keys(config).length === 0 && !callsVisuals(root)) {
    return ['visuals: not used by this app; skipped.'];
  }
  const s = settings(config);
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  // Only globs the app chose: the defaults are a guess at a web app's layout.
  const chosen = config.ui === undefined ? [] : s.ui;
  const stale = chosen.filter((glob) => !tracked.some((file) => matchesAny(file, [glob])));
  if (stale.length > 0) throw new Error(`visuals.ui names no tracked file: ${stale.join(', ')}`);
  const ui = pick(tracked, { include: s.ui, exclude: s.notUi });
  if (ui.length === 0) throw new Error('visuals.notUi leaves no UI file');
  const lines = [`visuals: ${ui.length} of ${tracked.length} tracked files count as UI.`];

  // The shared template has no box to tick: pr-template/selftest.mjs checks it.
  if (s.sharedTemplate) {
    lines.push(
      'visuals: sharedTemplate: PR visuals passes every PR; pr-template checks the template.',
    );
    return lines;
  }
  const templatePath = path.join(root, TEMPLATE);
  if (!existsSync(templatePath)) return [...lines, `visuals: no ${TEMPLATE}; skipped.`];
  const template = readFileSync(templatePath, 'utf8');
  const files = [ui[0]];
  if (checkPrVisuals({ files, body: template, settings: s }).ok) {
    throw new Error(`the untouched ${TEMPLATE} passes a UI change`);
  }
  const ticked = template.replace(/\[ \](\s*No visible UI change)/, '[x]$1');
  if (ticked === template) throw new Error(`${TEMPLATE} has no "No visible UI change" box`);
  if (!checkPrVisuals({ files, body: ticked, settings: s }).ok) {
    throw new Error(`${TEMPLATE} still fails once "No visible UI change" is ticked`);
  }
  lines.push(`visuals: ${TEMPLATE} fails untouched and passes ticked.`);
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
    log(`visuals self-test failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cli(process.argv.slice(2));
}
