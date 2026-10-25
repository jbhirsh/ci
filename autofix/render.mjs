// Renders Claude autofix's prompts: ci-fix.md for the CI fixer (a red
// Dependabot bump) and review-fix.md for the review fixer (unresolved
// review threads), each with the app's own validation commands
// (settings.mjs).
//
// CLI: `node render.mjs ci-fix|review-fix`, run from the app's checkout, with
//   REPO           owner/name
//   PR             the PR's number
//   BASE_REF       the default branch (`main`); the settings are read from
//                  origin/<it> unless CONFIG_REF says otherwise (empty: the
//                  working tree)
//   BRANCH, HEAD_SHA, FAILED_CHECKS   ci-fix only
// Step output: `prompt`.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { appRoot } from '../lib/app.mjs';
import { bullets, fill } from '../review/template.mjs';
import { autofixSettings } from './settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** @typedef {'ci-fix' | 'review-fix'} Fixer */

/**
 * @param {Fixer} fixer
 * @returns {string}
 */
export function template(fixer) {
  return readFileSync(path.join(HERE, `${fixer}.md`), 'utf8');
}

/**
 * @param {Fixer} fixer
 * @param {import('./settings.mjs').AutofixSettings} settings
 * @param {{ repo: string, pr: string, base: string, repoDir: string, branch?: string, head?: string, failedChecks?: string }} run
 * @returns {string}
 */
export function renderPrompt(fixer, settings, run) {
  const [owner, name] = run.repo.split('/');
  return fill(template(fixer), {
    repo: run.repo,
    owner,
    name,
    pr: run.pr,
    base: run.base,
    repoDir: run.repoDir,
    branch: run.branch ?? '',
    head: run.head ?? '',
    failedChecks: run.failedChecks ?? '',
    checks: bullets(fixer === 'ci-fix' ? settings.ciFixChecks : settings.reviewFixChecks),
    cannotRun: settings.cannotRun.join(', '),
  });
}

/**
 * @param {string} name
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function required(name, env) {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * The CLI, minus process handling.
 *
 * @param {string | undefined} fixer
 * @param {Record<string, string | undefined>} env
 * @param {string} root
 * @returns {string}
 */
export function main(fixer, env, root) {
  if (fixer !== 'ci-fix' && fixer !== 'review-fix') {
    throw new Error('usage: render.mjs ci-fix|review-fix');
  }
  const repo = required('REPO', env);
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error(`REPO must be owner/name, not ${repo}`);
  const base = env.BASE_REF || 'main';
  const ref = env.CONFIG_REF === undefined ? `origin/${base}` : env.CONFIG_REF || undefined;
  const settings = autofixSettings({ root, ref });
  const ci = fixer === 'ci-fix';
  return renderPrompt(fixer, settings, {
    repo,
    pr: required('PR', env),
    base,
    repoDir: root,
    branch: ci ? required('BRANCH', env) : undefined,
    head: ci ? required('HEAD_SHA', env) : undefined,
    failedChecks: ci ? required('FAILED_CHECKS', env) : undefined,
  });
}

/* c8 ignore start: the CLI's lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setOutput('prompt', main(process.argv[2], process.env, appRoot()));
}
/* c8 ignore stop */
