// Small reads of GitHub's REST API that several tools share (visual-review,
// describe): every page of a list, the newest of a workflow's runs, and a
// commit status's description from the account that should have posted it.

import type { Api } from './comment.ts';

/** How many pages of a list are read, 100 a page. */
export const PAGES = 30;

/**
 * The repository and PR number a pr-changes step was given, or an error naming
 * what is missing.
 *
 * @param env GITHUB_REPOSITORY and NUMBER
 */
export function prTarget(env: Record<string, string | undefined>): {
  repo: string;
  number: number;
} {
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
 * @param api
 * @param route with or without a query; the page is added to it
 * @param key the list's key when each page is an object
 *   (`workflow_runs`), else the page is the list
 * @param onLimit called when the last of PAGES pages is still
 *   full, so that the list is cut short (a caller that needs all of it says so)
 */
export function pages(api: Api, route: string, key?: string, onLimit?: () => void): unknown[] {
  const out: unknown[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const got = api('GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const list = key ? (got as Record<string, unknown> | null)?.[key] : got;
    if (!Array.isArray(list)) throw new Error(`expected a list from ${route}`);
    out.push(...list);
    if (list.length < 100) return out;
  }
  onLimit?.();
  return out;
}

/**
 * The newest of some runs (the highest id), or undefined.
 */
export function newest<T extends { id: number }>(runs: readonly T[]): T | undefined {
  return runs.reduce((best: T | undefined, r) => (best && best.id > r.id ? best : r), undefined);
}

/** A commit status, as far as statusFrom reads it. */
export type Status = {
  id: number;
  context: string;
  state: string;
  description: string | null;
  creator?: { login?: string } | null;
};

/**
 * A commit status on a commit, from `creator` only: anyone with statuses
 * write can post one under any name, and a PR's own workflow can, so a
 * status counts only from the account that should have posted it.
 *
 * @returns the newest
 */
export function statusFrom(
  api: Api,
  repo: string,
  sha: string,
  context: string,
  creator: string = ACTIONS_BOT,
): { state: string; description: string } | null {
  const list = pages(api, `repos/${repo}/commits/${sha}/statuses`) as Status[];
  const found = newest(list.filter((s) => s.context === context && s.creator?.login === creator));
  return found ? { state: found.state, description: found.description ?? '' } : null;
}
