// The README screenshot bot's one PR, from bot/readme-screenshots, kept in
// step with what the capture job found (readme-screenshots/action.yml runs
// this in the job holding the token, which runs no npm):
//
//   - screenshots changed: a fresh branch from the checked-out main commit
//     (so the PR is never behind main when it's (re)opened), the changed
//     files committed and force-pushed, the PR opened or its description
//     rewritten, and auto-merge (squash) turned on;
//   - a capture ran but nothing changed: an open bot PR's pictures are of an
//     older UI (an earlier change since reverted, say), so it's closed and
//     its branch deleted;
//   - no capture (nothing they show changed, or no shots to compare): an
//     open bot PR is brought up to date with main, so a branch rule that
//     requires that never leaves it waiting.
//
// Its description shows each replaced screenshot before (at main) and after
// (at the bot's commit), linked by SHA so a later push can't change what it
// shows, in the sections of the apps' PR template.
//
// Reads, from the environment: CAPTURE ('true' when a capture ran),
// CHANGED (the replaced files, space-separated), SHOTS (the folder holding
// them), SOURCE_PR and RUN_URL (optional, for the description),
// GITHUB_REPOSITORY; and the app's `readme-screenshots` settings.

import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig, appRoot } from '../lib/app.mjs';
import { BRANCH, CHANGED_RATIO, isShotName, settings } from './settings.mjs';

const BOT = [
  '-c',
  'user.name=github-actions[bot]',
  '-c',
  'user.email=41898282+github-actions[bot]@users.noreply.github.com',
];

/**
 * The replaced files, checked: names only, PNGs only.
 *
 * @param {string | undefined} changed
 * @returns {string[]}
 */
export function changedFiles(changed) {
  const files = (changed ?? '').split(/\s+/).filter(Boolean);
  const bad = files.filter((f) => !isShotName(f));
  if (bad.length > 0) throw new Error(`not a screenshot name: ${bad.join(', ')}`);
  return files;
}

/**
 * What to do with the bot PR.
 *
 * @param {{ capture: boolean, files: string[], open: string }} state
 *   `open` is the open bot PR's number, '' when there's none
 * @returns {'publish' | 'close' | 'update' | 'none'}
 */
export function plan({ capture, files, open }) {
  if (files.length > 0) return 'publish';
  if (!open) return 'none';
  return capture ? 'close' : 'update';
}

/**
 * Where the shots came from, for the description and the commit.
 *
 * @param {string} source
 * @param {string | undefined} sourcePr
 */
function origin(source, sourcePr) {
  return sourcePr ? `${source}, for #${sourcePr}` : source;
}

/**
 * The bot PR's description.
 *
 * @param {{ repo: string, dir: string, base: string, head: string, files: string[],
 *   source: string, sourcePr?: string, runUrl?: string }} input
 */
export function prBody({ repo, dir, base, head, files, source, sourcePr, runUrl }) {
  const raw = (/** @type {string} */ sha, /** @type {string} */ file) =>
    `https://raw.githubusercontent.com/${repo}/${sha}/${dir}/${file}`;
  return [
    `The README's screenshots no longer matched the app at ${base.slice(0, 7)}, so they were ` +
      `taken again from ${origin(source, sourcePr)}${runUrl ? ` ([run](${runUrl}))` : ''}. Only ` +
      `screenshots where over ${CHANGED_RATIO * 100}% of the pixels changed are replaced.`,
    '',
    '## Visual changes',
    '',
    '| Screenshot | Before (`main`) | After |',
    '|---|---|---|',
    ...files.map(
      (file) =>
        `| \`${file}\` | <img src="${raw(base, file)}" width="300"> | <img src="${raw(head, file)}" width="300"> |`,
    ),
    '',
    '- [ ] No visible UI change',
    '',
    '## Validation',
    '',
    'Pictures only: no code changed. Merges itself once the required checks pass.',
  ].join('\n');
}

/**
 * @typedef {(command: string, args: string[], input?: string) => string} Run
 *   runs git or gh in the app's checkout, returning stdout; throws on failure
 */

/**
 * Brings the bot PR in line with the capture, and says what it did.
 *
 * @param {Record<string, string | undefined>} env
 * @param {Run} run
 * @param {string} root
 */
export function main(env, run, root) {
  const s = settings(appConfig('readme-screenshots', root));
  const files = changedFiles(env.CHANGED);
  const repo = env.GITHUB_REPOSITORY ?? '';
  const open = run('gh', [
    'pr',
    'list',
    '--repo',
    repo,
    '--head',
    BRANCH,
    '--state',
    'open',
    '--json',
    'number',
    '--jq',
    '.[0].number // empty',
  ]).trim();
  const action = plan({ capture: env.CAPTURE === 'true', files, open });
  if (action === 'none') return 'No open bot PR and nothing to replace.';
  if (action === 'update') {
    try {
      run('gh', ['pr', 'update-branch', open, '--repo', repo, '--rebase']);
    } catch (error) {
      // Already up to date is what this wanted.
      if (!/already up.to.date/i.test(String(error))) throw error;
    }
    return `Brought #${open} up to date with main.`;
  }
  if (action === 'close') {
    run('gh', [
      'pr',
      'close',
      open,
      '--repo',
      repo,
      '--delete-branch',
      '--comment',
      'The screenshots match the app again, so these are out of date.',
    ]);
    return `Closed #${open}: its screenshots are out of date.`;
  }
  if (!env.SHOTS) throw new Error('SHOTS names no folder of screenshots');
  const base = run('git', ['rev-parse', 'HEAD']).trim();
  run('git', ['switch', '-C', BRANCH]);
  for (const file of files) copyFileSync(path.join(env.SHOTS, file), path.join(root, s.dir, file));
  run('git', ['add', '--', ...files.map((file) => `${s.dir}/${file}`)]);
  run('git', [
    ...BOT,
    'commit',
    '-q',
    '-m',
    'Refresh the README screenshots',
    '-m',
    `The app's look changed at ${base.slice(0, 7)}, so the README's screenshots were taken ` +
      `again from ${origin(s.source, env.SOURCE_PR)}; these changed visibly: ${files.join(', ')}.`,
  ]);
  run('git', ['push', '--force', 'origin', BRANCH]);
  const head = run('git', ['rev-parse', 'HEAD']).trim();
  const body = prBody({
    repo,
    dir: s.dir,
    base,
    head,
    files,
    source: s.source,
    sourcePr: env.SOURCE_PR || undefined,
    runUrl: env.RUN_URL || undefined,
  });
  let pr = open;
  if (pr) {
    run('gh', ['pr', 'edit', pr, '--repo', repo, '--body-file', '-'], body);
  } else {
    run(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        repo,
        '--base',
        'main',
        '--head',
        BRANCH,
        '--title',
        'Refresh the README screenshots',
        '--body-file',
        '-',
      ],
      body,
    );
    pr = run('gh', [
      'pr',
      'list',
      '--repo',
      repo,
      '--head',
      BRANCH,
      '--state',
      'open',
      '--json',
      'number',
      '--jq',
      '.[0].number',
    ]).trim();
  }
  // Squash, as Dependabot's PRs merge (dependabot-merge).
  run('gh', ['pr', 'merge', pr, '--repo', repo, '--auto', '--squash']);
  return `${open ? 'Updated' : 'Opened'} #${pr} with ${files.join(', ')}.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = appRoot();
  /** @type {Run} */
  const run = (command, args, input) =>
    execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  console.log(main(process.env, run, root));
}
