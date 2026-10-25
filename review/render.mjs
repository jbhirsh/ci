// Renders Claude Review's prompts (prompt.md for the review, followup.md for
// the second pass over files it left unread) and hands action.yml what it
// needs from the app's settings (settings.mjs).
//
// CLI: `node render.mjs review|followup`, run from the app's checkout, with
//   REPO, PR       the repository (owner/name) and the PR's number
//   BASE_REF       the PR's base branch (`main`)
//   CONFIG_REF     where to read the settings from (`origin/main`); empty
//                  reads the working tree
//   UNREAD         followup only: the files left unread, one per line
// Step outputs: `prompt`, and `skip` (the app's skip globs, one per line,
// for coverage.mjs).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { appRoot } from '../lib/app.mjs';
import { reviewSettings } from './settings.mjs';
import { bullets, fill } from './template.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** @typedef {'review' | 'followup'} Pass */

/**
 * @param {Pass} pass
 * @returns {string}
 */
export function template(pass) {
  return readFileSync(path.join(HERE, pass === 'review' ? 'prompt.md' : 'followup.md'), 'utf8');
}

/**
 * The app's guide as a prompt section.
 *
 * @param {import('./settings.mjs').ReviewSettings} settings
 * @returns {string}
 */
export function appGuide(settings) {
  if (!settings.instructions) {
    return '## This app\n\nThe app names no review guide (`review.instructions` in `.github/ci.json`): its CLAUDE.md holds its conventions.';
  }
  return `## This app (from \`${settings.instructions}\`)\n\n${settings.guide}`;
}

/**
 * @param {Pass} pass
 * @param {import('./settings.mjs').ReviewSettings} settings
 * @param {{ repo: string, pr: string, base: string, repoDir: string, unread?: string[] }} run
 * @returns {string}
 */
export function renderPrompt(pass, settings, run) {
  const skippable =
    settings.skip.length > 0
      ? `Lockfiles, images, fonts and the generated files ${settings.skip.map((g) => `\`${g}\``).join(', ')}`
      : 'Lockfiles, images and fonts';
  return fill(template(pass), {
    repo: run.repo,
    pr: run.pr,
    base: run.base,
    repoDir: run.repoDir,
    skippable,
    appGuide: appGuide(settings),
    unread: bullets(run.unread ?? [], '  '),
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
 * @param {string | undefined} pass
 * @param {Record<string, string | undefined>} env
 * @param {string} root
 * @returns {{ prompt: string, skip: string }}
 */
export function main(pass, env, root) {
  if (pass !== 'review' && pass !== 'followup') {
    throw new Error('usage: render.mjs review|followup');
  }
  const settings = reviewSettings({ root, ref: env.CONFIG_REF || undefined });
  const unread = (env.UNREAD ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (pass === 'followup' && unread.length === 0) throw new Error('UNREAD is empty');
  const prompt = renderPrompt(pass, settings, {
    repo: required('REPO', env),
    pr: required('PR', env),
    base: env.BASE_REF || 'main',
    repoDir: root,
    unread,
  });
  return { prompt, skip: settings.skip.join('\n') };
}

/* c8 ignore start: the CLI's lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { prompt, skip } = main(process.argv[2], process.env, appRoot());
  setOutput('prompt', prompt);
  setOutput('skip', skip);
}
/* c8 ignore stop */
