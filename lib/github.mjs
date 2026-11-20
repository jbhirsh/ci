// Small reads of GitHub's REST API that several tools share (visual-review,
// describe): every page of a list, the newest of a workflow's runs, and a
// commit status's description from the account that should have posted it.

/** How many pages of a list are read, 100 a page. */
export const PAGES = 30;

/**
 * The repository and PR number a pr-changes step was given, or an error naming
 * what is missing.
 *
 * @param {Record<string, string | undefined>} env GITHUB_REPOSITORY and NUMBER
 * @returns {{ repo: string, number: number }}
 */
export function prTarget(env) {
  const repo = env.GITHUB_REPOSITORY ?? '';
  const number = Number(env.NUMBER);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number) || number < 1) {
    throw new Error('pr-changes needs GITHUB_REPOSITORY and NUMBER');
  }
  return { repo, number };
}
/** The account the Actions token posts as. */
export const ACTIONS_BOT = 'github-actions[bot]';

/**
 * Every page of a list.
 *
 * @param {import('./comment.mjs').Api} api
 * @param {string} route with or without a query; the page is added to it
 * @param {string} [key] the list's key when each page is an object
 *   (`workflow_runs`), else the page is the list
 * @param {() => void} [onLimit] called when the last of PAGES pages is still
 *   full, so that the list is cut short (a caller that needs all of it says so)
 * @returns {unknown[]}
 */
export function pages(api, route, key, onLimit) {
  /** @type {unknown[]} */
  const out = [];
  for (let page = 1; page <= PAGES; page++) {
    const got = api('GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const list = key ? /** @type {Record<string, unknown> | null} */ (got)?.[key] : got;
    if (!Array.isArray(list)) throw new Error(`expected a list from ${route}`);
    out.push(...list);
    if (list.length < 100) return out;
  }
  onLimit?.();
  return out;
}

/**
 * The newest of some runs (the highest id), or undefined.
 *
 * @template {{ id: number }} T
 * @param {readonly T[]} runs
 * @returns {T | undefined}
 */
export function newest(runs) {
  return runs.reduce(
    (/** @type {T | undefined} */ best, r) => (best && best.id > r.id ? best : r),
    undefined,
  );
}

/**
 * A commit status, as far as statusFrom reads it.
 *
 * @typedef {object} Status
 * @property {number} id
 * @property {string} context
 * @property {string} state
 * @property {string | null} description
 * @property {{ login?: string } | null} [creator]
 */

/**
 * A commit status on a commit, from `creator` only: anyone with statuses
 * write can post one under any name, and a PR's own workflow can, so a
 * status counts only from the account that should have posted it.
 *
 * @param {import('./comment.mjs').Api} api
 * @param {string} repo
 * @param {string} sha
 * @param {string} context
 * @param {string} [creator]
 * @returns {{ state: string, description: string } | null} the newest
 */
export function statusFrom(api, repo, sha, context, creator = ACTIONS_BOT) {
  const list = /** @type {Status[]} */ (pages(api, `repos/${repo}/commits/${sha}/statuses`));
  const found = newest(list.filter((s) => s.context === context && s.creator?.login === creator));
  return found ? { state: found.state, description: found.description ?? '' } : null;
}
