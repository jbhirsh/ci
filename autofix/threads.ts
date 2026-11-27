// Which unresolved review threads autofix's review fixer may act on: those
// Claude Review or the owner opened. Anyone can comment on a public PR, and
// this job turns a thread into a pushed commit that can then auto-merge, so
// a thread counts only when its first comment is
//   - the Claude GitHub App's (claude[bot]: Claude Review's threads from
//     before it left claude-code-action), or
//   - github-actions[bot]'s carrying REVIEW_MARKER (Claude Review on the
//     Agent SDK, which posts with the job's token, review/tools.ts). Only a
//     workflow run with write access posts as github-actions[bot], and the
//     app's other workflows (job reports, visual review) never write the marker;
//     or
//   - the owner's.
//
// CLI: `node threads.ts <owner>`, one page of the reviewThreads GraphQL
// answer on stdin (nodes with isResolved and the first comment's author
// and body); prints how many unresolved threads count.

import { pathToFileURL } from 'node:url';
import { readAll } from '../lib/actions.ts';

/** The hidden line on each of Claude Review's inline comments (review/tools.ts). */
export const REVIEW_MARKER = '<!-- claude-review -->';

/**
 * @param node one review thread
 * @param owner
 */
export function counts(node: unknown, owner: string): boolean {
  const thread = (node && typeof node === 'object' ? node : {}) as {
    isResolved?: unknown;
    comments?: { nodes?: unknown[] };
  };
  if (thread.isResolved !== false) return false;
  const first = (thread.comments?.nodes?.[0] ?? {}) as {
    body?: unknown;
    author?: { __typename?: unknown; login?: unknown } | null;
  };
  const author = first.author ?? {};
  const bot = author.__typename === 'Bot';
  if (bot && author.login === 'claude') return true;
  if (bot && author.login === 'github-actions') {
    return typeof first.body === 'string' && first.body.includes(REVIEW_MARKER);
  }
  return !bot && author.login === owner;
}

/**
 * How many threads of one GraphQL page count.
 */
export function countThreads(page: unknown, owner: string): number {
  const nodes = (
    (page && typeof page === 'object' ? page : {}) as {
      data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown } } } };
    }
  ).data?.repository?.pullRequest?.reviewThreads?.nodes;
  return Array.isArray(nodes) ? nodes.filter((n) => counts(n, owner)).length : 0;
}

/* c8 ignore start: the CLI's lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(countThreads(JSON.parse(await readAll()), process.argv[2] ?? ''));
}
/* c8 ignore stop */
