// The cases an app's Vercel ignoreCommand (`node scripts/vercel-ignore.mjs`,
// in BoardGames and fog-and-frontier) must answer as the rest of #51
// expects, checked by the self-test against the app's own script. Vercel
// runs it in the checkout before building: exit 0 skips the build, which
// Vercel reports as success; exit 1 builds.
//
// It skips only the baselines bot's amend (carry.mjs) on a preview: a
// commit whose committer is github-actions[bot] and whose author is
// someone else. Everything else builds: production always (a merge
// ships, and BoardGames' migrations run), a commit the bot made from
// scratch (the README-screenshots PR's), a person's, and GitHub's own (a
// rebase merge, "Update branch").

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BOT } from './baselines.mjs';

/** Where an app keeps the script, from its checkout. */
export const SCRIPT = 'scripts/vercel-ignore.mjs';

/**
 * One commit Vercel might be asked to build, and whether it's skipped.
 *
 * @typedef {{ name: string, author: string, committer: string, env: string, skip: boolean }} Case
 */

/** @type {Case[]} */
export const CASES = [
  {
    name: "the baselines bot's amend, on a preview",
    author: 'A Person',
    committer: BOT.name,
    env: 'preview',
    skip: true,
  },
  {
    name: 'a commit the bot made from scratch',
    author: BOT.name,
    committer: BOT.name,
    env: 'preview',
    skip: false,
  },
  {
    name: "a person's commit",
    author: 'A Person',
    committer: 'A Person',
    env: 'preview',
    skip: false,
  },
  {
    name: "GitHub's merge or Update branch",
    author: 'A Person',
    committer: 'GitHub',
    env: 'preview',
    skip: false,
  },
  {
    name: "the bot's amend, in production",
    author: 'A Person',
    committer: BOT.name,
    env: 'production',
    skip: false,
  },
];

/**
 * The environment without git's own variables: a hook's GIT_DIR would point
 * these commits at the repository running the self-test.
 *
 * @param {Record<string, string | undefined>} env
 */
function withoutGit(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
}

/**
 * Runs the app's script on each case, in a throwaway repository holding
 * that case's commit. Returns null when the app has no script; throws,
 * naming each case it answers wrongly.
 *
 * @param {string} root the app's checkout
 * @param {Case[]} [cases]
 * @returns {string | null} a log line
 */
export function checkIgnore(root, cases = CASES) {
  const script = path.join(root, SCRIPT);
  if (!existsSync(script)) return null;
  const clean = withoutGit(process.env);
  const dir = mkdtempSync(path.join(tmpdir(), 'vercel-ignore-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: clean });
  /** @type {string[]} */
  const wrong = [];
  for (const c of cases) {
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', c.name], {
      cwd: dir,
      env: {
        ...clean,
        GIT_AUTHOR_NAME: c.author,
        GIT_AUTHOR_EMAIL: 'author@example.com',
        GIT_COMMITTER_NAME: c.committer,
        GIT_COMMITTER_EMAIL: 'committer@example.com',
      },
    });
    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      env: { ...clean, VERCEL_ENV: c.env },
      encoding: 'utf8',
    });
    const answer = result.status === 0 ? 'skips' : result.status === 1 ? 'builds' : null;
    const want = c.skip ? 'skips' : 'builds';
    if (answer !== want) {
      wrong.push(
        `${c.name}: ${answer ?? `exits ${result.status ?? result.signal}`}, should ${want === 'skips' ? 'skip' : 'build'}`,
      );
    }
  }
  if (wrong.length > 0) throw new Error(`${SCRIPT} answers wrongly: ${wrong.join('; ')}`);
  return `visual-baselines: ${SCRIPT} answers all ${cases.length} cases.`;
}
