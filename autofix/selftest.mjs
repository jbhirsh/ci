// Claude autofix's self-test against an app checkout, run by this repo's CI
// for each app (`node autofix/selftest.mjs <app checkout>`). Offline, it
// checks that the app's `autofix` settings parse (settings.mjs; an app with
// no key is checked against the defaults), that every validation command
// they list is one the app can run (commands.mjs), that both prompts render
// with nothing left unfilled and the app's checks in them, and that the
// stub's trigger list holds every pull-request workflow the app doesn't
// exempt (check-triggers.mjs, reading YAML with the app's `yaml` package, so
// the app's dependencies must be installed). Prints what it checked; exits
// 1 on the first problem.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkTriggers, STUB } from './check-triggers.mjs';
import { appFacts, entryProblem } from './commands.mjs';
import { renderPrompt } from './render.mjs';
import { DEFAULT_CHECKS, autofixSettings } from './settings.mjs';

const USES = 'jbhirsh/ci/autofix@';

/**
 * @param {string} file
 * @returns {string | null}
 */
function readOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Runs every check; returns the lines to print, throwing on a failure.
 *
 * @param {string} root
 * @param {{ parse?: (text: string) => unknown }} [options] a YAML parser
 *   instead of the app's
 * @returns {Promise<string[]>}
 */
export async function selftest(root, options = {}) {
  const settings = autofixSettings({ root });
  const log = [
    `settings: ${settings.ciFixChecks.length} CI-fix check(s), ${settings.reviewFixChecks.length} review-fix check(s), can't run: ${settings.cannotRun.join(', ')}`,
  ];
  const facts = appFacts(root);
  for (const entry of new Set([...settings.ciFixChecks, ...settings.reviewFixChecks])) {
    if (DEFAULT_CHECKS.includes(entry)) continue;
    const problem = entryProblem(entry, facts);
    if (problem) throw new Error(`autofix check ${entry}: ${problem}`);
  }
  log.push('commands: every listed check runs in the app');
  const run = {
    repo: 'jbhirsh/app',
    pr: '1',
    base: 'main',
    repoDir: root,
    branch: 'dependabot/npm_and_yarn/x-1.0.0',
    head: '0123456789abcdef0123456789abcdef01234567',
    failedChecks: 'ci',
  };
  for (const fixer of /** @type {const} */ (['ci-fix', 'review-fix'])) {
    const prompt = renderPrompt(fixer, settings, run);
    const checks = fixer === 'ci-fix' ? settings.ciFixChecks : settings.reviewFixChecks;
    const missing = checks.find((check) => !prompt.includes(`- ${check}`));
    if (missing) throw new Error(`the ${fixer} prompt is missing the check ${missing}`);
    log.push(`${fixer} prompt: renders, ${prompt.length} characters`);
  }
  // Only an app whose autofix is this action's has the list it checks: one
  // still on its own workflow (an app's main before it moves) is skipped.
  if (!(readOrNull(path.join(root, '.github', 'workflows', STUB)) ?? '').includes(USES)) {
    log.push(`triggers: not checked (${STUB} doesn't use ${USES} yet)`);
    return log;
  }
  const { workflows, problems } = await checkTriggers(root, options);
  if (problems.length > 0) throw new Error(problems.join('; '));
  const stub = workflows.find((w) => w.file === STUB);
  log.push(
    `triggers: ${stub?.workflowRun?.join(', ')}; exempt: ${Object.keys(settings.exempt).join(', ') || 'none'}`,
  );
  return log;
}

/* c8 ignore start: the CLI's lines, run by CI */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2] ?? '.');
  try {
    for (const line of await selftest(root)) console.log(`autofix: ${line}`);
  } catch (error) {
    console.error(`autofix: FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
/* c8 ignore stop */
