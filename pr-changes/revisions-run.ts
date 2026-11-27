// revisions.ts against GitHub: when a PR's head has moved since its
// Revisions last named it, add a revision (and, the first time, the blocks
// with revision 1 for the head the PR opened at). Reads with the Actions token
// (GH_TOKEN); the one write, the description with the revision in it, is made with
// a person's token (UPLOAD_TOKEN), because an edit by the Actions token starts
// no workflow, and the description check must run again on the description it
// now reads (its current revision names the new head). The check's run for the
// push read the old description, was red, and is superseded by the run this
// edit starts, which stays red until the author fills the new revision's row
// (ci#140; the apps' PR description workflows cancel an older run per PR).
//
//   node revisions-run.ts   (env: GH_TOKEN, GITHUB_REPOSITORY, NUMBER;
//                             optional: UPLOAD_TOKEN, BEFORE)
//
// BEFORE is the head before a push (`github.event.before`), the only record
// of the head a PR opened at: a PR with no blocks has had one head until a push
// says otherwise. Without it (an `edited` run) a PR with no blocks is left
// alone.
//
// What it writes, and when:
//   - nothing for a PR with one head, a closed PR, Dependabot's, or one from a
//     `bot/` branch; and nothing for a PR whose description has a torn or
//     repeated pair of revisions markers (a warning says so);
//   - the empty pair itself, when a push has moved the head and the
//     description has no revisions marker at all (an author or a tool
//     rewrote it without the template's pair): `withPair` puts it where the
//     template does, and the revision goes in as below, so a rewritten
//     description doesn't leave a PR with no Revisions, silently;
//   - nothing when the current revision already names the PR's head, so a
//     rerun, the run the tool's own edit wakes and an author's edit of a Why
//     all leave the description alone;
//   - otherwise the revision, worked out again if the description changed under it
//     (3 attempts), and skipped if the PR's head moved on meanwhile: the run
//     for the newer head writes its revision.
//
// HARD RULES (the job runs on `pull_request_target` with a person's token):
//   - it checks out nothing and runs none of the PR's code: the PR is data;
//   - UPLOAD_TOKEN is taken out of the environment on start and reaches only
//     the one PATCH whose body this tool built; every other call uses GH_TOKEN;
//   - the repo and a sha come only from validated values, a commit subject
//     only through `escape`, the author's cells only as revisions.ts says.
//
// Without a token that may write, a PR that needs a row fails this job with
// the reason (a fork's PR, which the caller deliberately gives none, only
// says so); the job is never a required check.

import { pathToFileURL } from 'node:url';
import { MAX_CHARS, ghApi } from '../lib/comment.ts';
import { PAGES, pages, prTarget } from '../lib/github.ts';
import { renderedLines, revisionsPair } from '../pr-template/body.ts';
import { blocks, shielded } from './changes.ts';
import {
  FIRST_KNOWN,
  HISTORY_HEADS,
  NO_LONGER,
  REPLACED,
  UNREAD,
  addRevision,
  budgeted,
  capChain,
  goalSentence,
  headHistory,
  parseTable,
  previousHead,
  rangeNote,
  withPair,
} from './revisions.ts';
import type { Api } from '../lib/comment.ts';
import type { Table, TimelineEvent } from './revisions.ts';

/** How many times the row is worked out again because the description moved under it. */
const ATTEMPTS = 3;

export type Pull = {
  /** `open` or `closed` */
  state: string;
  author: string;
  headRef: string;
  headSha: string;
  /** `owner/name` of the head's repository */
  headRepo: string;
};

export type Commit = {
  sha: string;
  subject: string;
  /** a merge or a bot's commit */
  skipped: boolean;
};

export type Compare = {
  /** `ahead`, `behind`, `diverged` or `identical` */
  status: string;
  behindBy: number;
  /** the merge base */
  base: string | null;
  /** the commits from the old head to the new, oldest first */
  shas: string[];
};

export type Io = {
  pull: () => Pull;
  body: () => string;
  /** every commit of the PR, oldest first */
  commits: () => Commit[];
  /** null when GitHub can't compare (the old head is gone) */
  compare: (prev: string, head: string) => Compare | null;
  /** the PR's timeline events, oldest first */
  timeline: () => TimelineEvent[];
  /** with the person's token */
  write: (body: string) => void;
  /** whether a person's token is at hand */
  canWrite: boolean;
  log: (line: string) => void;
};

/**
 * The io for one PR.
 */
export function gitHubIo({
  api,
  repo,
  number,
  token,
  log,
}: {
  api: Api;
  repo: string;
  number: number;
  token: string;
  log: (line: string) => void;
}): Io {
  const issue = `repos/${repo}/issues/${number}`;
  return {
    pull: () => {
      const p = api('GET', `repos/${repo}/pulls/${number}`) as {
        state: string;
        user: { login: string } | null;
        head: { ref: string; sha: string; repo: { full_name: string } | null };
      };
      return {
        state: p.state,
        author: p.user?.login ?? '',
        headRef: p.head.ref,
        headSha: p.head.sha,
        headRepo: p.head.repo?.full_name ?? '',
      };
    },
    body: () => String((api('GET', issue) as { body?: string | null }).body ?? ''),
    commits: () =>
      (
        pages(api, `repos/${repo}/pulls/${number}/commits`) as {
          sha: string;
          commit: { message: string };
          parents: unknown[];
          author: { login: string } | null;
          committer: { login: string } | null;
        }[]
      ).map((c) => ({
        sha: c.sha,
        subject: c.commit.message.split('\n')[0],
        skipped:
          c.parents.length > 1 || Boolean((c.author ?? c.committer)?.login.endsWith('[bot]')),
      })),
    timeline: () =>
      pages(api, `repos/${repo}/issues/${number}/timeline`, undefined, () =>
        log(
          `::warning::pr-changes: the PR's timeline is longer than ${PAGES * 100} events: only the first are read, so the table may miss the latest heads`,
        ),
      ) as TimelineEvent[],
    compare: (prev, head) => {
      try {
        const route = `repos/${repo}/compare/${prev}...${head}`;
        // One request answers the status and the first 100 commits; more pages only for more commits.
        let out: Compare | null = null;
        for (let page = 1; page <= PAGES; page++) {
          const c = api('GET', `${route}?per_page=100&page=${page}`) as {
            status: string;
            behind_by: number;
            merge_base_commit?: { sha: string };
            commits?: { sha: string }[];
          };
          const list = c.commits ?? [];
          if (out === null) {
            out = {
              status: c.status,
              behindBy: c.behind_by,
              base: c.merge_base_commit?.sha ?? null,
              shas: [],
            };
          }
          out.shas.push(...list.map((x) => x.sha));
          if (list.length < 100) break;
        }
        return out;
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
 */
export function headingBefore(body: string, at: number) {
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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The table for a PR's first write, from GitHub's timeline of its heads
 * (revisions.ts's header says what that gives): one revision per head, the
 * first and the latest HISTORY_HEADS - 1 at most, each with what changed from
 * the head before it where GitHub still has the commits, else REPLACED, or
 * null when the timeline names no earlier head (or can't be read), and the
 * caller starts from `before`.
 *
 * @param io
 * @param body
 * @param table the block as it is: empty of rows, with what the author typed in it
 * @param where
 */
function history(
  io: Io,
  body: string,
  table: Table,
  { head, before }: { head: string; before: string },
): Table | null {
  let events: TimelineEvent[];
  try {
    events = io.timeline();
  } catch (error) {
    io.log(
      `::warning::pr-changes: the PR's timeline couldn't be read (${message(error)}), so Revisions starts from the head before this push`,
    );
    return null;
  }
  const { chain, fromTimeline } = headHistory(events, { head, before });
  if (chain.length < 2) return null;
  const { kept, omitted } = capChain(chain, HISTORY_HEADS);
  let commits: Commit[] = [];
  try {
    commits = io.commits();
  } catch (error) {
    io.log(
      `::warning::pr-changes: the PR's commits couldn't be read (${message(error)}), so no revision says whether its commits are still on the PR`,
    );
  }
  const why = goalSentence(renderedLines(body));
  const newest = chain.length;
  // A failed read of one range (a rate limit, a 5xx) costs that row its detail, not the table.
  const ranges = new Map(
    kept
      .filter((k) => k.rev > 1)
      .map((k) => {
        try {
          return [k.rev, io.compare(chain[k.rev - 2], k.sha)];
        } catch (error) {
          io.log(
            `::warning::pr-changes: the commits of revision ${k.rev} couldn't be compared (${message(error)}): its row says so`,
          );
          return [k.rev, undefined];
        }
      }),
  );
  /**
   * A revision after the first: the head before it (its compare link), and its note.
   */
  const range = (rev: number): { prev: string | null; note: string } => {
    const prev = chain[rev - 2];
    const found = ranges.get(rev);
    if (found === undefined) return { prev, note: UNREAD };
    if (found === null) return { prev: null, note: REPLACED };
    const asked = new Set(found.shas);
    const here = commits.filter((c) => asked.has(c.sha));
    const said = rangeNote({
      prev,
      how: found.status === 'ahead' ? 'ahead' : 'rewritten',
      dropped: found.behindBy,
    });
    // None of its commits is on the PR now (later rewritten): the note says so.
    return here.length === 0 ? { ...said, note: `${said.note} ${NO_LONGER}`.trim() } : said;
  };
  return {
    rows: kept.map((k) => ({
      rev: k.rev,
      current: k.rev === newest,
      sha: k.sha,
      ...(k.rev === 1 ? { prev: null, note: fromTimeline ? FIRST_KNOWN : 'Opened' } : range(k.rev)),
      // The goal's first sentence is what the first revision says it was for.
      rows: k.rev === 1 && why !== '' ? [`| — | ${why} |`] : [],
      typed: [],
    })),
    // What the author typed outside the blocks stays below them.
    rest: table.rest,
    omitted: table.omitted,
    capped: omitted,
  };
}

/**
 * The block's content for the PR's head, or null when nothing is to be written.
 */
function plan(
  io: Io,
  body: string,
  { repo, head, before }: { repo: string; head: string; before: string | null },
): { text: string; at: { from: number; to: number } } | null {
  const { start, end } = blocks.markers('revisions');
  // The pair as the description check counts it (revisionsPair): a marker in a
  // fence or a sentence is none, so the tool and the check never disagree.
  const found = revisionsPair(body);
  const at = found.at;
  if (!at) {
    if (found.starts.length + found.ends.length > 0) {
      io.log(
        '::warning::pr-changes: the revisions markers are torn or repeated, so Revisions is left alone',
      );
    }
    return null;
  }
  // Not inside another tool's block, which that tool rewrites.
  if (shielded(body).some((r) => r.from <= at.from && at.to <= r.to)) return null;
  const table = parseTable(body.slice(at.from + start.length, at.to - end.length), repo);
  const kept = table.rest.length;
  if (kept > 0) {
    io.log(
      `::warning::pr-changes: ${kept} line(s) of the Revisions block are no row; they stay below the blocks`,
    );
  }
  const prev = previousHead(table.rows) ?? before;
  if (prev === null || prev === head) return null;
  if (table.rows.length === 0) {
    const first = history(io, body, table, { head, before: prev });
    if (first) {
      return { text: budgeted(first, repo, { heading: !headingBefore(body, at.from) }), at };
    }
  }
  const opened =
    table.rows.length === 0 ? { sha: prev, why: goalSentence(renderedLines(body)) } : null;
  const byHead = io.compare(prev, head);
  if (byHead?.status === 'identical') return null;
  const how = byHead === null ? 'gone' : byHead.status === 'ahead' ? 'ahead' : 'rewritten';
  const range = rangeNote({ prev, how, dropped: byHead?.behindBy ?? 0 });
  const text = budgeted(
    addRevision(table, { head, prev: range.prev, note: range.note, opened }),
    repo,
    { heading: !headingBefore(body, at.from) },
  );
  return { text, at };
}

/**
 * The description with the block's content set to `text`, in the
 * description's own line endings.
 *
 * @param body
 * @param at the pair, from its start marker to the end of its end marker
 * @param text
 */
function putPair(body: string, at: { from: number; to: number }, text: string) {
  const { start, end } = blocks.markers('revisions');
  const nl = body.includes('\r\n') ? '\r\n' : '\n';
  const marked = `${start}${nl}${text.replace(/\r?\n/g, nl)}${nl}${end}`;
  return body.slice(0, at.from) + marked + body.slice(at.to);
}

/**
 * Adds the row for the PR's head to its Revisions block when it is missing.
 *
 * @returns whether the description was written
 */
export function revisions(
  io: Io,
  { repo, before }: { repo: string; before: string | null },
): boolean {
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
    // The pair is made only for a push that moved the head: a PR at one head,
    // or an `edited` run that has no BEFORE, is left as it is.
    const moved = before !== null && before !== pull.headSha;
    const base = moved ? withPair(current) : current;
    const planned = plan(io, base, { repo, head: pull.headSha, before });
    if (planned === null) return false;
    if (pull.headRepo !== repo) {
      io.log(
        "::notice::pr-changes: this PR is from a fork, which gets no person's token, so its Revisions row is added by hand",
      );
      return false;
    }
    if (!io.canWrite) {
      throw new Error(
        "pr-changes: Revisions needs BOT_PR_TOKEN (a person's token, Pull requests write): an edit by the Actions token starts no run of the description check, so the check would go on naming the old head, and the revision would have to be added by hand",
      );
    }
    const out = putPair(base, planned.at, planned.text);
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

export function main(env: Record<string, string | undefined>) {
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
