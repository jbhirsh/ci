// Renders Claude Review's prompts (prompt.md for the review, followup.md for
// the second pass over files it left unread) and hands action.yml what it
// needs from the app's settings (settings.ts).
//
// CLI: `node render.ts review|followup`, run from the app's checkout, with
//   REPO, PR       the repository (owner/name) and the PR's number
//   BASE_REF       the PR's base branch (`main`)
//   CONFIG_REF     where to read the settings from (`origin/main`); empty
//                  reads the working tree
//   PLAN           review only: carry.ts's plan, naming the files carried
//                  over from an earlier review (none when it's missing)
//   UNREAD         followup only: the files left unread, one per line
// Step outputs: `prompt`, `skip` (the app's skip globs, one per line, for
// coverage.ts), and for the follow-up `max_turns`, its turn cap.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { appRoot } from '../lib/app.mjs';
import { readPlan } from './carry.ts';
import { reviewSettings } from './settings.ts';
import { bullets, fill } from './template.ts';
import type { ReviewSettings } from './settings.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * This repository's root, wherever it runs from: in CI, the copy of
 * jbhirsh/ci GitHub downloaded to run the action, which the review may read
 * (sdk.ts's `additionalDirectories`) to check what a PR says about a shared
 * tool.
 */
export const CI_DIR = path.resolve(HERE, '..');

export type Pass = 'review' | 'followup';

/**
 * The follow-up's turn cap (sdk.ts's MAX_TURNS), from the number of files left to read: a
 * few turns a file (its diff, the saved output of a long one, a comment)
 * plus the summary's, between a floor and a ceiling. A fixed 100 ran out on
 * fog-and-frontier #304. A pass that runs past it and still finishes
 * doesn't fail the check (result.ts); the cap only stops a runaway.
 */
export function followupTurns(unread: number): number {
  return Math.min(300, Math.max(40, 20 + 4 * unread));
}

/**
 * The prompt's section on files carried over from an earlier review, or ''
 * when there are none.
 */
export function carriedSection(
  carried: { file: string; sha: string }[],
  { base }: { base: string },
): string {
  if (carried.length === 0) return '';
  const list = bullets(
    carried.map(({ file, sha }) => `\`${file}\`, reviewed at ${sha.slice(0, 7)}`),
    '   ',
  );
  return [
    `   Already reviewed: an earlier review of this PR read these files in full,`,
    `   and their part of the diff is unchanged since (the same`,
    `   \`git patch-id --verbatim\` of`,
    `   \`git diff -M origin/${base}...HEAD -- <file>\`). You needn't read them`,
    `   again and the check doesn't ask you to; open any of them for context as`,
    `   you would code outside the diff. Their findings stand: the inline`,
    `   comments on them are still on the PR, and the notes on them are in your`,
    `   summary comment. Before you replace that comment, read it`,
    `   (\`mcp__review__pr\`, \`earlierSummary\`) and keep its notes on these`,
    `   files; list them in the summary as carried over, with the commit each`,
    `   was reviewed at.`,
    list,
  ].join('\n');
}

export function template(pass: Pass): string {
  return readFileSync(path.join(HERE, pass === 'review' ? 'prompt.md' : 'followup.md'), 'utf8');
}

/**
 * The app's guide as a prompt section.
 */
export function appGuide(settings: ReviewSettings): string {
  if (!settings.instructions) {
    return '## This app\n\nThe app names no review guide (`review.instructions` in `.github/ci.json`): its CLAUDE.md holds its conventions.';
  }
  return `## This app (from \`${settings.instructions}\`)\n\n${settings.guide}`;
}

export function renderPrompt(
  pass: Pass,
  settings: ReviewSettings,
  run: {
    repo: string;
    pr: string;
    base: string;
    repoDir: string;
    unread?: string[];
    carried?: { file: string; sha: string }[];
  },
): string {
  const skippable =
    settings.skip.length > 0
      ? `Lockfiles, images, fonts and the generated files ${settings.skip.map((g) => `\`${g}\``).join(', ')}`
      : 'Lockfiles, images and fonts';
  return fill(template(pass), {
    repo: run.repo,
    pr: run.pr,
    base: run.base,
    repoDir: run.repoDir,
    ciDir: CI_DIR,
    skippable,
    appGuide: appGuide(settings),
    unreadPaths: JSON.stringify(run.unread ?? []),
    carried: carriedSection(run.carried ?? [], run),
  });
}

function required(name: string, env: Record<string, string | undefined>): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * The CLI, minus process handling.
 */
export function main(
  pass: string | undefined,
  env: Record<string, string | undefined>,
  root: string,
): { prompt: string; skip: string; maxTurns: string } {
  if (pass !== 'review' && pass !== 'followup') {
    throw new Error('usage: render.ts review|followup');
  }
  const settings = reviewSettings({ root, ref: env.CONFIG_REF || undefined });
  const unread = (env.UNREAD ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (pass === 'followup' && unread.length === 0) throw new Error('UNREAD is empty');
  const plan = pass === 'review' ? readPlan(env.PLAN) : null;
  const carried = Object.entries(plan?.carried ?? {}).map(([file, { sha }]) => ({ file, sha }));
  const prompt = renderPrompt(pass, settings, {
    repo: required('REPO', env),
    pr: required('PR', env),
    base: env.BASE_REF || 'main',
    repoDir: root,
    unread,
    carried,
  });
  const maxTurns = pass === 'followup' ? String(followupTurns(unread.length)) : '';
  return { prompt, skip: settings.skip.join('\n'), maxTurns };
}

/* c8 ignore start: the CLI's lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { prompt, skip, maxTurns } = main(process.argv[2], process.env, appRoot());
  setOutput('prompt', prompt);
  setOutput('skip', skip);
  if (maxTurns) setOutput('max_turns', maxTurns);
}
/* c8 ignore stop */
