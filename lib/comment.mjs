// The parts of keeping one bot comment on a pull request that every tool
// doing it shares (job-summary's job reports, visuals' before/after table):
// the REST call through `gh api`, the status of a failed one, the most a
// comment may hold, and finding the comment again by the hidden marker it
// starts with. Each tool decides
// what goes in its comment and when.

import { execFileSync } from 'node:child_process';

/**
 * A call to GitHub's REST API: the parsed answer, or a throw whose
 * message or `status` carries the HTTP status.
 *
 * @typedef {(method: string, route: string, body?: Record<string, unknown>) => unknown} Api
 */

/**
 * Who posts the comments: the workflow's token. Anyone can write a marker,
 * so a comment is a tool's only if this account wrote it too.
 */
export const AUTHOR = 'github-actions[bot]';
/**
 * The most a comment may hold. GitHub refuses a body over 65,536
 * characters; this leaves room for counting them differently.
 */
export const MAX_CHARS = 65_000;
/** How many pages of a pull request's comments are read looking for one. */
export const PAGES = 30;

/**
 * The status of a failed API call: its own, or the one gh's message names.
 *
 * @param {unknown} error
 * @returns {number | null}
 */
export function statusOf(error) {
  if (typeof error !== 'object' || error === null) return null;
  const e = /** @type {{ status?: unknown, message?: unknown, stderr?: unknown }} */ (error);
  if (typeof e.status === 'number' && e.status >= 100) return e.status;
  const text = `${String(e.message ?? '')}\n${String(e.stderr ?? '')}`;
  const m = /HTTP (\d{3})/.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * The comment on a pull request that AUTHOR wrote starting with `marker`,
 * or null before the first.
 *
 * @param {Api} api
 * @param {string} repo
 * @param {number} pr
 * @param {string} marker
 * @returns {{ id: number, body: string } | null}
 */
export function findComment(api, repo, pr, marker) {
  for (let page = 1; page <= PAGES; page++) {
    const comments = /** @type {unknown} */ (
      api('GET', `repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`)
    );
    if (!Array.isArray(comments)) return null;
    for (const c of comments) {
      const comment =
        /** @type {{ id: number, body?: string | null, user?: { login?: string } | null }} */ (c);
      if (comment.user?.login === AUTHOR && comment.body?.startsWith(marker)) {
        return { id: comment.id, body: comment.body };
      }
    }
    if (comments.length < 100) return null;
  }
  return null;
}

/**
 * The real API, through `gh api` (GH_TOKEN from the environment).
 *
 * @type {Api}
 */
export function ghApi(method, route, body) {
  const out = execFileSync('gh', ['api', '-X', method, route, ...(body ? ['--input', '-'] : [])], {
    input: body ? JSON.stringify(body) : undefined,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  return out.trim() ? JSON.parse(out) : null;
}
