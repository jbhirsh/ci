// The PR a finished workflow run was for, as a bot that wakes on
// `workflow_run` needs it (ci#64's visual-review; the GIF hand-off, ci#58,
// can share it): the open PR in this repository whose head is the run's
// commit. A fork's PR is never returned: a bot holding a token checks out
// and runs nothing of a fork's. A run whose PR has moved on to a newer head
// returns nothing either: that head's own run follows.
//
// GitHub lists a pull_request run's PRs in `workflow_run.pull_requests`,
// but leaves it empty for some runs (a deployment_status run's, a fork's),
// so this asks `commits/{sha}/pulls`, which works for every same-repository
// commit.

import type { Api } from './comment.ts';

/** The run, as far as this reads it. */
export type Run = { head_sha: string; event: string };

/** A pull request, as far as this reads it. */
export type Pull = {
  number: number;
  state: string;
  head: { sha: string; repo: { full_name: string } | null };
  base?: { ref: string };
};

/**
 * The open same-repository PR whose head is the run's commit, or why there
 * is none.
 *
 * @param run
 * @param repo owner/name
 * @param api
 */
export function pullOfRun(run: Run, repo: string, api: Api): { pull: Pull } | { why: string } {
  const got = api('GET', `repos/${repo}/commits/${run.head_sha}/pulls?per_page=100`);
  if (!Array.isArray(got)) throw new Error(`expected a list of PRs for ${run.head_sha}`);
  const open = (got as Pull[]).filter((p) => p.state === 'open');
  const own = open.filter((p) => p.head.repo?.full_name === repo);
  const pull = own.find((p) => p.head.sha === run.head_sha);
  if (pull) return { pull };
  if (own.length > 0) {
    return { why: `#${own[0].number}'s head has moved on from ${run.head_sha.slice(0, 7)}` };
  }
  if (open.length > 0) return { why: `#${open[0].number} is a fork's PR` };
  return { why: `no open PR has ${run.head_sha.slice(0, 7)}` };
}
