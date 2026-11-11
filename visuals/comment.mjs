// Keeps the PR's before/after table (table.mjs) in one comment, for an app
// whose `visuals.fromBaselines` is on (check.mjs's header): action.yml runs
// it on every run of PR visuals, before the check. Without the setting it
// does nothing and prints nothing.
//
// The first run with changed baselines makes the comment, later ones edit
// it in place (an edit notifies nobody), and a run whose PR no longer
// changes any deletes it. It's found again by its marker and author
// (lib/comment.mjs). A run for a commit that's no longer the PR's head, or
// for a closed PR, writes nothing, so an older run never overwrites a newer
// one and edits to old PRs' descriptions post nothing.
//
// Two runs for one head at once could each post one, so the caller's
// workflow runs one at a time per PR (the apps' pr-visuals.yml have a
// concurrency group, cancelling the older run).
//
// It never fails the job: a token that can't comment (the caller's workflow
// without pull-requests: write, a fork's or Dependabot's) is a notice, and
// any other API error a warning.
//
//   node comment.mjs   (env: GITHUB_REPOSITORY, GH_TOKEN, PR, HEAD_SHA,
//                       BASE_SHA, PR_FILES: the files API's entries, one
//                       JSON object a line; the app's checkout, or APP_ROOT)

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { appConfig, appRoot } from '../lib/app.mjs';
import { changedBaselines, pairBaselines } from '../lib/baselines.mjs';
import { findComment, ghApi, statusOf } from '../lib/comment.mjs';
import { loadBaselineSettings, readEntries, settings } from './check.mjs';
import { MARKER, renderTable } from './table.mjs';

/** @typedef {import('../lib/comment.mjs').Api} Api */

const SHA = /^[0-9a-f]{40}$/;

/**
 * Makes, edits or deletes the PR's table comment.
 *
 * @param {{ repo: string, pr: number, head: string, base: string, files: import('../lib/baselines.mjs').FileEntry[], root: string }} run
 *   base: the base branch's SHA the event names, from which the merge base is found
 * @param {Api} api
 * @returns {string} what happened
 */
export function keepTable({ repo, pr, head, base, files, root }, api) {
  // First, as it's the cheapest: a newer push's run, or a closed PR, writes nothing.
  const pull = /** @type {{ state?: string, head?: { sha?: string } }} */ (
    api('GET', `repos/${repo}/pulls/${pr}`)
  );
  if (pull?.state === 'closed') return `PR visuals: #${pr} is closed; its table is left as it is.`;
  if (pull?.head?.sha !== head) {
    return `PR visuals: #${pr} has moved on from ${head.slice(0, 7)}; its table is left to the newer run.`;
  }
  const baselines = loadBaselineSettings(root);
  const { columns } = baselines;
  const { rows, unpaired } = pairBaselines(changedBaselines(files, baselines), columns);
  /** @type {string | null} */
  let body = null;
  if (rows.length > 0 || unpaired.length > 0) {
    // What the files API diffs the PR against: base.sha can be newer.
    const compare = /** @type {{ merge_base_commit?: { sha?: string } }} */ (
      api('GET', `repos/${repo}/compare/${base}...${head}?per_page=1`)
    );
    const mergeBase = compare?.merge_base_commit?.sha ?? '';
    if (!SHA.test(mergeBase)) return `::warning::PR visuals: no merge base for #${pr}; no table.`;
    body = renderTable({ rows, unpaired, columns, repo, base: mergeBase, head });
  }
  const existing = findComment(api, repo, pr, MARKER);
  if (body === null) {
    if (!existing) return `PR visuals: #${pr} changes no baselines; no table.`;
    api('DELETE', `repos/${repo}/issues/comments/${existing.id}`);
    return `PR visuals: #${pr} no longer changes any baselines; deleted its table.`;
  }
  if (existing?.body === body) return `PR visuals: the table on #${pr} is already up to date.`;
  if (existing) {
    api('PATCH', `repos/${repo}/issues/comments/${existing.id}`, { body });
    return `PR visuals: updated the table on #${pr}.`;
  }
  api('POST', `repos/${repo}/issues/${pr}/comments`, { body });
  return `PR visuals: posted the table on #${pr}.`;
}

/**
 * What a failure means for the log: a notice when the token may not write
 * the comment, a warning otherwise.
 *
 * @param {unknown} error
 */
export function explain(error) {
  if (statusOf(error) === 403) {
    return "::notice::PR visuals: no table: the token can't comment (HTTP 403; the PR visuals job needs pull-requests: write, which a fork's or Dependabot's run never has).";
  }
  const text = error instanceof Error ? error.message : String(error);
  return `::warning::PR visuals: no table: ${text.split('\n')[0]}`;
}

/**
 * Keeps the table when the app asks for it; logs what happened. Never
 * throws.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {Api} [api]
 * @param {(line: string) => void} [log]
 */
export function main(env = process.env, api = ghApi, log = console.log) {
  try {
    const root = env.APP_ROOT || appRoot();
    if (!settings(appConfig('visuals', root)).fromBaselines) return;
    const repo = env.GITHUB_REPOSITORY ?? '';
    const pr = Number(env.PR);
    const head = env.HEAD_SHA ?? '';
    const base = env.BASE_SHA ?? '';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(pr) || pr <= 0) {
      log('::warning::PR visuals: GITHUB_REPOSITORY and PR are needed for the table.');
      return;
    }
    if (!SHA.test(head) || !SHA.test(base)) {
      log('::warning::PR visuals: HEAD_SHA and BASE_SHA are needed for the table.');
      return;
    }
    const files = readEntries(readFileSync(env.PR_FILES ?? '', 'utf8'));
    log(keepTable({ repo, pr, head, base, files, root }, api));
  } catch (error) {
    log(explain(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
