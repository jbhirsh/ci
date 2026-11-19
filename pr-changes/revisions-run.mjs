// revisions.mjs against GitHub: when a PR's head has moved since its
// Revisions table last named it, add a row (and, the first time, the table
// with row 1 for the head the PR opened at). Reads with the Actions token
// (GH_TOKEN); the one write, the description with the row in it, is made with
// a person's token (UPLOAD_TOKEN), because an edit by the Actions token starts
// no workflow, and the description check must run again on the description it
// now reads (its current row names the new head). The check's run for the
// push read the old description, was red, and is superseded by the run this
// edit starts (the apps' PR visuals workflows cancel an older run per PR).
//
//   node revisions-run.mjs   (env: GH_TOKEN, GITHUB_REPOSITORY, NUMBER;
//                             optional: UPLOAD_TOKEN, BEFORE)
//
// BEFORE is the head before a push (`github.event.before`), the only record
// of the head a PR opened at: a PR with no table has had one head until a push
// says otherwise. Without it (an `edited` run) a PR with no table is left
// alone.
//
// What it writes, and when:
//   - nothing for a PR with one head, with no pair of revisions markers in
//     its description, a closed PR, Dependabot's, or one from a `bot/` branch;
//   - nothing when the table's current row already names the PR's head, so a
//     rerun, the run the tool's own edit wakes and an author's edit of a Why
//     all leave the description alone;
//   - otherwise the row, worked out again if the description changed under it
//     (3 attempts), and skipped if the PR's head moved on meanwhile: the run
//     for the newer head writes the row for it.
//
// HARD RULES (the job runs on `pull_request_target` with a person's token):
//   - it checks out nothing and runs none of the PR's code: the PR is data;
//   - UPLOAD_TOKEN is taken out of the environment on start and reaches only
//     the one PATCH whose body this tool built; every other call uses GH_TOKEN;
//   - the repo and a sha come only from validated values, a commit subject
//     only through `escape`, the author's cells only as revisions.mjs says.
//
// Without a token that may write, a PR that needs a row fails this job with
// the reason (a fork's PR, which the caller deliberately gives none, only
// says so); the job is never a required check.

import { pathToFileURL } from 'node:url';
import { MAX_CHARS, ghApi } from '../lib/comment.mjs';
import { pages, prTarget } from '../lib/github.mjs';
import { renderedLines } from '../pr-template/body.mjs';
import { blocks, ownBlock, putBlock } from './changes.mjs';
import {
  addRevision,
  budgeted,
  describeRange,
  goalSentence,
  parseTable,
  previousHead,
} from './revisions.mjs';

/** How many times the row is worked out again because the description moved under it. */
const ATTEMPTS = 3;

/**
 * @typedef {object} Pull
 * @property {string} state `open` or `closed`
 * @property {string} author
 * @property {string} headRef
 * @property {string} headSha
 * @property {string} headRepo `owner/name` of the head's repository
 */

/**
 * @typedef {object} Compare
 * @property {string} status `ahead`, `behind`, `diverged` or `identical`
 * @property {number} behindBy
 * @property {string | null} base the merge base
 * @property {string[]} shas the commits from the old head to the new, oldest first
 */

/**
 * @typedef {object} Io
 * @property {() => Pull} pull
 * @property {() => string} body
 * @property {() => import('./revisions.mjs').Subject[]} commits every commit of the PR, oldest first
 * @property {(prev: string, head: string) => Compare | null} compare null when GitHub can't compare (the old head is gone)
 * @property {(body: string) => void} write with the person's token
 * @property {boolean} canWrite whether a person's token is at hand
 * @property {(line: string) => void} log
 */

/**
 * The io for one PR.
 *
 * @param {{ api: import('../lib/comment.mjs').Api, repo: string, number: number,
 *   token: string, log: (line: string) => void }} options
 * @returns {Io}
 */
export function gitHubIo({ api, repo, number, token, log }) {
  const issue = `repos/${repo}/issues/${number}`;
  return {
    pull: () => {
      const p =
        /** @type {{ state: string, user: { login: string } | null, head: { ref: string, sha: string, repo: { full_name: string } | null } }} */ (
          api('GET', `repos/${repo}/pulls/${number}`)
        );
      return {
        state: p.state,
        author: p.user?.login ?? '',
        headRef: p.head.ref,
        headSha: p.head.sha,
        headRepo: p.head.repo?.full_name ?? '',
      };
    },
    body: () => String(/** @type {{ body?: string | null }} */ (api('GET', issue)).body ?? ''),
    commits: () =>
      /** @type {{ sha: string, commit: { message: string }, parents: unknown[], author: { login: string } | null, committer: { login: string } | null }[]} */ (
        pages(api, `repos/${repo}/pulls/${number}/commits`)
      ).map((c) => ({
        sha: c.sha,
        subject: c.commit.message.split('\n')[0],
        skipped:
          c.parents.length > 1 || Boolean((c.author ?? c.committer)?.login.endsWith('[bot]')),
      })),
    compare: (prev, head) => {
      try {
        const route = `repos/${repo}/compare/${prev}...${head}`;
        const c =
          /** @type {{ status: string, behind_by: number, merge_base_commit?: { sha: string } }} */ (
            api('GET', `${route}?per_page=1`)
          );
        return {
          status: c.status,
          behindBy: c.behind_by,
          base: c.merge_base_commit?.sha ?? null,
          shas: /** @type {{ sha: string }[]} */ (pages(api, route, 'commits')).map((x) => x.sha),
        };
      } catch (error) {
        // 404: the old head was garbage collected; 422: GitHub can't compare the two.
        if (/HTTP (404|422)/.test(String(error instanceof Error ? error.message : error))) {
          return null;
        }
        throw error;
      }
    },
    write: (body) => {
      api('PATCH', issue, { body }, { token });
    },
    canWrite: token !== '',
    log,
  };
}

/**
 * Whether a `## Revisions` heading already stands just before position `at`,
 * apart from blank lines and comments.
 *
 * @param {string} body
 * @param {number} at
 */
export function headingBefore(body, at) {
  const lines = body.slice(0, at).split('\n');
  // Back from the pair, past blank lines and whole comments (the template puts
  // one between the heading and the pair): the first line left is the heading or not.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (line.endsWith('-->')) {
      while (i > 0 && !lines[i].includes('<!--')) i--;
      continue;
    }
    return /^##\s+Revisions$/.test(line);
  }
  return false;
}

/**
 * The block's content for the PR's head, or null when nothing is to be written.
 *
 * @param {Io} io
 * @param {string} body
 * @param {{ repo: string, head: string, before: string | null }} where
 * @returns {{ text: string, at: { from: number, to: number } } | null}
 */
function plan(io, body, { repo, head, before }) {
  const { start, end } = blocks.markers('revisions');
  if (body.split(start).length !== 2 || body.split(end).length !== 2) {
    if (body.includes(start)) {
      io.log(
        '::warning::pr-changes: the revisions markers are torn or repeated, so Revisions is left alone',
      );
    }
    return null;
  }
  const at = ownBlock(body, 'revisions');
  if (!at) return null;
  const table = parseTable(body.slice(at.from + start.length, at.to - end.length), repo);
  const kept = table.rest.length;
  if (kept > 0) {
    io.log(
      `::warning::pr-changes: ${kept} line(s) of the Revisions block are no row; they stay below the table`,
    );
  }
  const prev = previousHead(table.rows) ?? before;
  if (prev === null || prev === head) return null;
  const opened =
    table.rows.length === 0 ? { sha: prev, why: goalSentence(renderedLines(body)) } : null;
  const commits = io.commits();
  const byHead = io.compare(prev, head);
  const rewritten = byHead !== null && byHead.status !== 'ahead';
  if (byHead?.status === 'identical') return null;
  /** @type {import('./revisions.mjs').Subject[]} */
  const since =
    byHead === null || rewritten
      ? commits
      : (() => {
          const asked = new Set(byHead.shas);
          return commits.filter((c) => asked.has(c.sha));
        })();
  const how = byHead === null ? 'gone' : rewritten ? 'rewritten' : 'ahead';
  const text = budgeted(
    (subjects) =>
      addRevision(table, {
        head,
        opened,
        what: describeRange(
          {
            repo,
            prev,
            head,
            how,
            commits: since,
            dropped: byHead?.behindBy ?? 0,
            base: byHead?.base ?? null,
          },
          subjects,
        ),
      }),
    repo,
    { heading: !headingBefore(body, at.from) },
  );
  return { text, at };
}

/**
 * Adds the row for the PR's head to its Revisions block when it is missing.
 *
 * @param {Io} io
 * @param {{ repo: string, before: string | null }} where
 * @returns {boolean} whether the description was written
 */
export function revisions(io, { repo, before }) {
  const pull = io.pull();
  if (
    pull.state !== 'open' ||
    pull.author === 'dependabot[bot]' ||
    pull.headRef.startsWith('bot/')
  ) {
    return false;
  }
  let current = io.body();
  for (let attempt = 1; ; attempt++) {
    const planned = plan(io, current, { repo, head: pull.headSha, before });
    if (planned === null) return false;
    if (pull.headRepo !== repo) {
      io.log(
        "::notice::pr-changes: this PR is from a fork, which gets no person's token, so its Revisions row is added by hand",
      );
      return false;
    }
    if (!io.canWrite) {
      throw new Error(
        "pr-changes: Revisions needs BOT_PR_TOKEN (a person's token, Pull requests write): an edit by the Actions token starts no run of the description check, so the check would stay red until a hand edit",
      );
    }
    const out = putBlock(current, 'revisions', planned.text);
    if (out.length > MAX_CHARS) {
      io.log(
        `::warning::pr-changes: the description would be over ${MAX_CHARS} characters with the Revisions row: not written`,
      );
      return false;
    }
    // Read again just before the write, which overwrites: a push since means a
    // newer run writes for it; an edit since means working the row out again.
    if (io.pull().headSha !== pull.headSha) {
      io.log('::notice::pr-changes: the head moved on; the run for it writes its row');
      return false;
    }
    const now = io.body();
    if (now === current) {
      io.write(out);
      return true;
    }
    if (attempt === ATTEMPTS) {
      throw new Error(`the description kept changing: gave up after ${ATTEMPTS} reads`);
    }
    current = now;
  }
}

/** @param {Record<string, string | undefined>} env */
export function main(env) {
  const { repo, number } = prTarget(env);
  // The token is for the one write: no other call, and no child process, inherits it.
  const token = env.UPLOAD_TOKEN ?? '';
  delete env.UPLOAD_TOKEN;
  const before = /^[0-9a-f]{40}$/.test(env.BEFORE ?? '') ? (env.BEFORE ?? null) : null;
  return revisions(gitHubIo({ api: ghApi, repo, number, token, log: console.log }), {
    repo,
    before,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env);
}
