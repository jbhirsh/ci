// Renders Claude Review's prompts (prompt.md for the review, followup.md for
// the second pass over files it left unread) and hands action.yml what it
// needs from the app's settings (settings.mjs).
//
// CLI: `node render.mjs review|followup`, run from the app's checkout, with
//   REPO, PR       the repository (owner/name) and the PR's number
//   BASE_REF       the PR's base branch (`main`)
//   CONFIG_REF     where to read the settings from (`origin/main`); empty
//                  reads the working tree
//   PLAN           review only: carry.mjs's plan, naming the files carried
//                  over from an earlier review (none when it's missing)
//   UNREAD         followup only: the files left unread, one per line
// Step outputs: `prompt`, `skip` (the app's skip globs, one per line, for
// coverage.mjs), and for the follow-up `max_turns`, its turn cap.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { appRoot } from '../lib/app.mjs';
import { readPlan } from './carry.mjs';
import { reviewSettings } from './settings.mjs';
import { bullets, fill } from './template.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * This repository's root, wherever it runs from: in CI, the copy of
 * jbhirsh/ci GitHub downloaded to run the action, which the review may read
 * (action.yml's `--add-dir`) to check what a PR says about a shared tool.
 */
export const CI_DIR = path.resolve(HERE, '..');

/** @typedef {'review' | 'followup'} Pass */

/**
 * The prompts' lines that differ by engine (settings.mjs): how the review
 * reads the PR and posts its summary. The action engine has a shell (`git`,
 * `gh`); the SDK engine has its own tools (tools.mjs) and no shell, and
 * loads CLAUDE.md itself (sdk.mjs). Everything else in the prompts is the
 * same review.
 *
 * @param {'action' | 'sdk'} engine
 * @param {{ repo: string, pr: string, base: string }} run
 * @returns {Record<string, string>}
 */
export function engineText(engine, { repo, pr, base }) {
  const range = `origin/${base}...HEAD`;
  if (engine === 'sdk') {
    return {
      claudeMd:
        "CLAUDE.md is already loaded, for the architecture (the base branch's copy; what the PR changes in it is in the diff).",
      listCommands: '`mcp__review__diff_stat` and `mcp__review__diff_list`',
      diffCommand: '`mcp__review__diff` with `paths: ["<file>"]`',
      countRule:
        ', so read each diff with `mcp__review__diff` or Read; a long diff comes in numbered parts, and counts once you have read every part',
      logCommand: '`mcp__review__log`, and `mcp__review__commit` for any that look related',
      prBody: '`mcp__review__pr`, which also holds its review comments and your earlier summary',
      summaryPost: [
        'Keep a single summary per PR, updated on each push: post it with',
        '`mcp__review__post_summary`, which replaces your earlier summary if',
        'there is one (`mcp__review__pr` shows it), or posts it otherwise.',
      ].join('\n'),
      followupRead: [
        'CLAUDE.md is already loaded. Read the shared rules',
        `(${CI_DIR}/claude-rules/CLAUDE.md), then read each of those diffs in`,
        'full, one file per call: `mcp__review__diff` with `paths: ["<file>"]`.',
      ].join('\n'),
      followupSummary: [
        "Then update the review's summary comment: read it with",
        '`mcp__review__pr` (`earlierSummary`), and post it again with',
        '`mcp__review__post_summary`. Keep its first line and everything still',
        'true; move these files from skimmed to read, and add what you found (or',
        'that you found nothing).',
      ].join('\n'),
      carriedRead: 'read it (`mcp__review__pr`, `earlierSummary`)',
    };
  }
  const find = `\`gh api repos/${repo}/issues/${pr}/comments --paginate --jq '.[] | select(.user.login == "claude[bot]" and (.body | startswith("<!-- claude-review-summary -->"))) | .id'\``;
  return {
    claudeMd:
      "Read\nCLAUDE.md first for the architecture. (The checkout holds the base\nbranch's CLAUDE.md; what the PR changes in it is in the diff.)",
    listCommands: `\`git diff --stat -M ${range}\`\n   and \`git diff --name-status -M ${range}\``,
    diffCommand: `\`git diff -M ${range} -- <file>\``,
    countRule:
      ', and only a plain command counts: no loop,\n   variable, pipe or `&&` chain (a leading `cd <dir> &&` is fine)',
    logCommand: `\`git log --reverse --no-merges --format='%h %an <%ae> %s' origin/${base}..HEAD\`,\n  and \`git show --stat <sha>\` for any that look related`,
    prBody: `\`gh pr view ${pr} --json body\``,
    summaryPost: [
      'Keep a single summary per PR, updated on each push. Find yours (posted as',
      '`claude[bot]`) with',
      `${find}.`,
      'Pass the body on stdin through a quoted heredoc, never inside a quoted',
      'argument (backticks and `$` in it would be run by the shell). If an id came',
      'back, replace that comment:',
      `\`gh api -X PATCH repos/${repo}/issues/comments/<id> -F body=@- <<'EOF'\`,`,
      'then the body, then a line holding only `EOF`. Otherwise create it the same',
      `way with \`gh api repos/${repo}/issues/${pr}/comments -F body=@- <<'EOF'\`.`,
    ].join('\n'),
    followupRead: [
      `Read CLAUDE.md and the shared rules (${CI_DIR}/claude-rules/CLAUDE.md),`,
      'then read each of those diffs in full, one file per command, exactly',
      `\`git diff -M ${range} -- <file>\`: no loop, variable, pipe or`,
      "`&&` chain, or the check that sent you here can't see that you read it,",
      'and the job fails.',
    ].join('\n'),
    followupSummary: [
      "Then update the review's summary comment: find it with",
      find,
      'and replace it with',
      `\`gh api -X PATCH repos/${repo}/issues/comments/<id> -F body=@- <<'EOF'\`, the`,
      'body, then a line holding only `EOF`. Keep its first line and everything',
      'still true; move these files from skimmed to read, and add what you found',
      '(or that you found nothing).',
    ].join('\n'),
    carriedRead: `read it\n   (\`gh api repos/${repo}/issues/comments/<id> --jq .body\`)`,
  };
}

/**
 * The follow-up's `--max-turns`, from the number of files left to read: a
 * few turns a file (its diff, the saved output of a long one, a comment)
 * plus the summary's, between a floor and a ceiling. A fixed 100 ran out on
 * fog-and-frontier #304. A pass that runs past it and still finishes
 * doesn't fail the check (result.mjs); the cap only stops a runaway.
 *
 * @param {number} unread
 * @returns {number}
 */
export function followupTurns(unread) {
  return Math.min(300, Math.max(40, 20 + 4 * unread));
}

/**
 * The prompt's section on files carried over from an earlier review, or ''
 * when there are none.
 *
 * @param {{ file: string, sha: string }[]} carried
 * @param {{ base: string }} run
 * @param {string} readSummary how to read the earlier summary (engineText)
 * @returns {string}
 */
export function carriedSection(carried, { base }, readSummary) {
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
    `   summary comment. Before you replace that comment, ${readSummary} and keep its notes`,
    `   on these files; list them in the summary as carried over, with the`,
    `   commit each was reviewed at.`,
    list,
  ].join('\n');
}

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
 * @param {{ repo: string, pr: string, base: string, repoDir: string, unread?: string[], carried?: { file: string, sha: string }[] }} run
 * @returns {string}
 */
export function renderPrompt(pass, settings, run) {
  const skippable =
    settings.skip.length > 0
      ? `Lockfiles, images, fonts and the generated files ${settings.skip.map((g) => `\`${g}\``).join(', ')}`
      : 'Lockfiles, images and fonts';
  const text = engineText(settings.engine, run);
  const { carriedRead, ...lines } = text;
  return fill(template(pass), {
    ...lines,
    repo: run.repo,
    pr: run.pr,
    base: run.base,
    repoDir: run.repoDir,
    ciDir: CI_DIR,
    skippable,
    appGuide: appGuide(settings),
    unread: bullets(run.unread ?? [], '  '),
    carried: carriedSection(run.carried ?? [], run, carriedRead),
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
 * @returns {{ prompt: string, skip: string, maxTurns: string }}
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
