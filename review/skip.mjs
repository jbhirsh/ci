// Whether a PR's review is skipped for being a bot's own work
// (`review.skipBots` in `.github/ci.json`, settings.mjs): the PR was opened
// by one of those bots and every commit on it is by one of them. A
// Dependabot bump that passes CI isn't reviewed; once autofix pushes a fix
// to it, it is: a github-actions[bot] commit, pushed with the app's
// BOT_PR_TOKEN.
// A commit counts by its GitHub author login, falling back to its
// committer's when GitHub matched no account to the author. Those logins
// come from the commit's email, which anyone who can push can set to a
// bot's; the PR's own author can't be set, so it's checked too.
//
// CLI: `node skip.mjs`, with REPO, PR, GH_TOKEN and BOTS (the bots, one per
// line). Step output `skip`: "true" or "false". With no bots it asks
// GitHub nothing and says "false".

import { pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { github } from './github.mjs';

/**
 * Whether every commit is by one of the bots (no commits: false).
 *
 * @param {unknown[]} commits GitHub's list of a PR's commits
 * @param {string[]} bots
 * @returns {boolean}
 */
export function allByBots(commits, bots) {
  if (bots.length === 0 || commits.length === 0) return false;
  const wanted = new Set(bots.map((b) => b.toLowerCase()));
  return commits.every((c) => {
    const commit =
      /** @type {{ author?: { login?: unknown } | null, committer?: { login?: unknown } | null }} */ (
        c && typeof c === 'object' ? c : {}
      );
    const login = commit.author?.login ?? commit.committer?.login;
    return typeof login === 'string' && wanted.has(login.toLowerCase());
  });
}

/**
 * The CLI, minus process handling.
 *
 * @param {Record<string, string | undefined>} env
 * @param {import('./github.mjs').Fetch} [fetchImpl]
 * @returns {Promise<boolean>}
 */
export async function main(env, fetchImpl) {
  const bots = (env.BOTS ?? '')
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean);
  if (bots.length === 0) return false;
  const { REPO, PR, GH_TOKEN } = env;
  if (!REPO || !PR) throw new Error('REPO and PR must be set');
  const api = github(GH_TOKEN ?? '', fetchImpl);
  const pull = /** @type {{ user?: { login?: unknown } }} */ (
    await api.get(`/repos/${REPO}/pulls/${PR}`)
  );
  const author = pull.user?.login;
  const wanted = bots.map((b) => b.toLowerCase());
  if (typeof author !== 'string' || !wanted.includes(author.toLowerCase())) return false;
  return allByBots(await api.list(`/repos/${REPO}/pulls/${PR}/commits`), bots);
}

/* c8 ignore start: the CLI's lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setOutput('skip', String(await main(process.env)));
}
/* c8 ignore stop */
