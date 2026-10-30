// Keeps one comment on a workflow run's pull request with every job's
// summary in it: each job's verdict, its report and what needs attention
// (render.mjs section, which summary.mjs leaves in the job's artifact as
// section.md). job-reports.yml's comment job runs it, through
// comment/action.yml, after each run that feeds job-reports finishes, green
// or red. Only that job writes the comment, never the jobs themselves, so
// jobs that finish together can't overwrite each other.
//
// The first run makes the comment and later ones edit it in place, so it
// never goes stale and an edit notifies nobody. An app can feed job-reports
// from two workflows (BoardGames' CI and E2E): each run replaces only its
// own workflow's sections, found by the hidden marker each starts with, and
// keeps the other's, labelled when they're from an earlier commit. Sections
// go by workflow name, then by the jobs' order in the run.
//
// Runs for one pull request take turns (the comment job's concurrency group
// in job-reports.yml), and each reads the comment again just before writing
// it. A run for a commit that's no longer the pull request's head writes
// nothing, so an older run never overwrites a newer one.
//
// It never fails the job: no pull request (a push to main), a token that
// can't comment (a caller that doesn't grant pull-requests: write, a
// Dependabot or fork token) and any other API error are logged and skipped.
//
//   node comment.mjs   (env: RUN_ID, GITHUB_REPOSITORY, GH_TOKEN)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactName } from './history.mjs';
import { cell } from './render.mjs';
import { pagesBase } from './report.mjs';

/**
 * A call to GitHub's REST API: the parsed answer, or a throw whose
 * message or `status` carries the HTTP status.
 *
 * @typedef {(method: string, route: string, body?: Record<string, unknown>) => unknown} Api
 */
/**
 * Downloads a run's job-summary-* artifacts into a folder, throwing when
 * there are none.
 *
 * @typedef {(runId: string, dir: string) => void} Download
 */

/**
 * One job's part of the comment.
 *
 * @typedef {object} Section
 * @property {string} workflow the workflow's name
 * @property {string} job its job-summary artifact's slug
 * @property {string} sha the commit its run was for
 * @property {string} text its Markdown (render.mjs section)
 */

/**
 * The run that last updated the comment, for its footer.
 *
 * @typedef {{ workflow: string, number: number, url: string }} Updater
 */

/**
 * What a run looks like to the API, as far as this reads it.
 *
 * @typedef {object} RunInfo
 * @property {string} name its workflow's name
 * @property {number} run_number
 * @property {string} head_sha
 * @property {string} html_url
 * @property {{ number: number, url?: string }[]} [pull_requests]
 */

/** The marker the comment starts with, to find it again. */
export const MARKER = '<!-- job-reports -->';
/**
 * Who posts it: the workflow's token. Anyone can write the marker, so a
 * comment is this one only if this account wrote it too.
 */
export const AUTHOR = 'github-actions[bot]';
/** Where a section ends. */
export const END = '<!-- job-reports:end -->';
/**
 * The most the comment may hold. GitHub refuses a body over 65,536
 * characters; this leaves room for counting them differently.
 */
export const MAX_CHARS = 65_000;
/** How many pages of a pull request's comments are read looking for it. */
export const PAGES = 30;

const SECTION =
  /^<!-- job-reports:section workflow=(\S*) job=(\S*) sha=(\S*) -->\n([\s\S]*?)\n<!-- job-reports:end -->$/gm;

/**
 * Text with any lone surrogate replaced, which encodeURIComponent can't
 * take.
 *
 * @param {string} text
 */
function wellFormed(text) {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '�',
  );
}

/**
 * A marker's value: no space, nothing that would end the comment.
 *
 * @param {string} value
 */
const encode = (value) => encodeURIComponent(wellFormed(value));

/**
 * A section's text as the comment holds it: trimmed, with nothing that
 * could open a marker of its own, and no `@mention`: a test named for a
 * scoped package ("@types/node") would otherwise notify whoever holds that
 * name, so a zero-width space goes after each @ that starts one. Cleaning
 * twice changes nothing.
 *
 * @param {string} text
 */
export function clean(text) {
  return text
    .replace(/\r/g, '')
    .replace(/<!--/g, '&lt;!--')
    .replace(/@(?=[\w-])/g, '@​')
    .trim();
}

/**
 * The sections a comment holds, in its order, each workflow and job once
 * (the first). Anything else in it (the heading, notes, the footer, text
 * someone added) is left out, as are markers that don't decode.
 *
 * @param {string} body
 * @returns {Section[]}
 */
export function parseSections(body) {
  /** @type {Section[]} */
  const sections = [];
  const seen = new Set();
  for (const m of body.replace(/\r\n/g, '\n').matchAll(SECTION)) {
    try {
      const section = {
        workflow: decodeURIComponent(m[1]),
        job: decodeURIComponent(m[2]),
        sha: decodeURIComponent(m[3]),
        text: m[4],
      };
      const key = JSON.stringify([section.workflow, section.job]);
      if (seen.has(key)) continue;
      seen.add(key);
      sections.push(section);
    } catch {
      // A marker someone edited into something that doesn't decode.
    }
  }
  return sections;
}

/**
 * The comment's sections once a run's are in: the run's workflow's old
 * sections replaced by its new ones (a job this run didn't summarize goes
 * too), every other workflow's kept, ordered by workflow name, each
 * workflow's in the order it came (the run's job order for this run's).
 *
 * @param {Section[]} existing
 * @param {Section[]} own this run's, in its job order
 * @param {string} workflow this run's
 * @returns {Section[]}
 */
export function mergeSections(existing, own, workflow) {
  const all = [...existing.filter((s) => s.workflow !== workflow), ...own];
  return all
    .map((s, i) => ({ s, i }))
    .sort((a, b) =>
      a.s.workflow < b.s.workflow ? -1 : a.s.workflow > b.s.workflow ? 1 : a.i - b.i,
    )
    .map(({ s }) => s);
}

/**
 * A commit as people read it, or '' for what isn't one.
 *
 * @param {string} sha
 */
const short = (sha) => (/^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : '');

/**
 * One section as the comment holds it: its marker, its text, its end, and
 * a note when it's from an earlier commit than the comment's.
 *
 * @param {Section} s
 * @param {string} head the commit the comment is for
 */
function block(s, head) {
  const marker = `<!-- job-reports:section workflow=${encode(s.workflow)} job=${encode(s.job)} sha=${encode(s.sha)} -->`;
  const lines = [marker, clean(s.text), END];
  if (s.sha !== head) {
    const sha = short(s.sha);
    lines.push(`<sub>From an earlier commit${sha ? `, \`${sha}\`` : ''}.</sub>`);
  }
  return lines.join('\n');
}

/**
 * The comment: a heading naming the commit, each section, and a footer
 * naming the run that last updated it, cut to MAX_CHARS with a note
 * pointing to the reports.
 *
 * @param {string} repo owner/name
 * @param {string} head the commit
 * @param {Section[]} sections in order
 * @param {Updater} by
 * @returns {string}
 */
export function composeComment(repo, head, sections, by) {
  const top = `${MARKER}\n### Job reports · \`${short(head) || 'unknown'}\``;
  const footer = `<sub>Updated by Job reports after each run, last after [${cell(by.workflow)} #${by.number}](${by.url}).</sub>`;
  const site = pagesBase(repo);
  const note = `…cut here: the comment would be over GitHub's limit of 65,536 characters. Every job's summary is on its run's page${site ? `, and its report on [the reports site](${site})` : ''}.`;
  const parts = [top];
  let used = top.length + footer.length + 2;
  const room = MAX_CHARS - note.length - 2;
  for (const s of sections) {
    const whole = block(s, head);
    if (used + whole.length + 2 <= room) {
      parts.push(whole);
      used += whole.length + 2;
      continue;
    }
    // Cut this one at a line, keeping its marker so a later run still
    // finds it, and leave out the rest.
    const lines = clean(s.text).split('\n');
    while (lines.length) {
      const cut = block({ ...s, text: lines.join('\n') }, head);
      if (used + cut.length + 2 <= room) {
        parts.push(cut);
        break;
      }
      lines.pop();
    }
    parts.push(note);
    break;
  }
  parts.push(footer);
  return parts.join('\n\n');
}

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
 * The first line of what went wrong, for a log.
 *
 * @param {unknown} error
 */
function reason(error) {
  const e = /** @type {{ stderr?: unknown }} */ (error ?? {});
  const text =
    (typeof e.stderr === 'string' && e.stderr.trim()) ||
    (error instanceof Error ? error.message : String(error));
  return text.split('\n').find((l) => l.trim() && !l.startsWith('Command failed')) ?? text;
}

/**
 * The run's own sections, from the folder its artifacts were downloaded
 * into: each job-summary-<job>/section.md, in the run's job order (jobs
 * the order doesn't name last, by name).
 *
 * @param {string} dir
 * @param {Map<string, number>} order by artifact slug
 * @param {string} workflow
 * @param {string} sha
 * @returns {Section[]}
 */
export function readSections(dir, order, workflow, sha) {
  return readdirSync(dir)
    .filter((name) => name.startsWith('job-summary-'))
    .filter((name) => existsSync(path.join(dir, name, 'section.md')))
    .map((name) => name.replace(/^job-summary-/, ''))
    .sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || (a < b ? -1 : 1))
    .map((job) => ({
      workflow,
      job,
      sha,
      text: readFileSync(path.join(dir, `job-summary-${job}`, 'section.md'), 'utf8'),
    }))
    .filter((s) => clean(s.text));
}

/**
 * The run's jobs in their order, by artifact slug; none when the API won't
 * say.
 *
 * @param {Api} api
 * @param {string} repo
 * @param {string} runId
 * @returns {Map<string, number>}
 */
export function jobOrder(api, repo, runId) {
  try {
    const answer = /** @type {{ jobs?: { name?: string }[] }} */ (
      api('GET', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`)
    );
    /** @type {Map<string, number>} */
    const order = new Map();
    for (const [i, job] of (answer?.jobs ?? []).entries()) {
      const slug = artifactName(String(job.name ?? '')).replace(/^job-summary-/, '');
      if (!order.has(slug)) order.set(slug, i);
    }
    return order;
  } catch {
    return new Map();
  }
}

/**
 * The run's pull requests: those the run names (in this repository), or
 * else the open ones from this repository whose head is the run's commit.
 *
 * @param {Api} api
 * @param {string} repo
 * @param {RunInfo} run
 * @returns {number[]}
 */
export function pullRequestsOf(api, repo, run) {
  const listed = (run.pull_requests ?? [])
    .filter((p) => !p.url || p.url.toLowerCase().includes(`/repos/${repo.toLowerCase()}/pulls/`))
    .map((p) => p.number);
  if (listed.length) return [...new Set(listed)];
  const found = /** @type {unknown} */ (api('GET', `repos/${repo}/commits/${run.head_sha}/pulls`));
  if (!Array.isArray(found)) return [];
  return found
    .map(
      (p) =>
        /** @type {{ number: number, state?: string, head?: { repo?: { full_name?: string } | null } }} */ (
          p
        ),
    )
    .filter(
      (p) =>
        p.state === 'open' &&
        String(p.head?.repo?.full_name ?? '').toLowerCase() === repo.toLowerCase(),
    )
    .map((p) => p.number);
}

/**
 * The comment this keeps on a pull request, or null before the first: the
 * marker alone could be anyone's, so it's also AUTHOR's.
 *
 * @param {Api} api
 * @param {string} repo
 * @param {number} pr
 * @returns {{ id: number, body: string } | null}
 */
export function findComment(api, repo, pr) {
  for (let page = 1; page <= PAGES; page++) {
    const comments = /** @type {unknown} */ (
      api('GET', `repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`)
    );
    if (!Array.isArray(comments)) return null;
    for (const c of comments) {
      const comment =
        /** @type {{ id: number, body?: string | null, user?: { login?: string } | null }} */ (c);
      if (comment.user?.login === AUTHOR && comment.body?.startsWith(MARKER)) {
        return { id: comment.id, body: comment.body };
      }
    }
    if (comments.length < 100) return null;
  }
  return null;
}

/**
 * Puts the run's sections in one pull request's comment, making it or
 * editing it, unless the pull request has moved on to a newer commit.
 *
 * @param {Api} api
 * @param {string} repo
 * @param {number} pr
 * @param {RunInfo} run
 * @param {Section[]} own
 * @returns {string} what happened
 */
export function updateComment(api, repo, pr, run, own) {
  const pull = /** @type {{ head?: { sha?: string } }} */ (api('GET', `repos/${repo}/pulls/${pr}`));
  const head = pull?.head?.sha ?? '';
  if (head !== run.head_sha) {
    return `::notice::job-reports: #${pr} is at ${short(head) || 'another commit'} now, newer than this run's ${short(run.head_sha)}; its comment is left to that commit's runs.`;
  }
  // Read again just before writing, as another run may have written since.
  const existing = findComment(api, repo, pr);
  const sections = mergeSections(parseSections(existing?.body ?? ''), own, run.name);
  const body = composeComment(repo, run.head_sha, sections, {
    workflow: run.name,
    number: run.run_number,
    url: run.html_url,
  });
  if (existing?.body === body) return `The job reports comment on #${pr} is already up to date.`;
  if (existing) {
    api('PATCH', `repos/${repo}/issues/comments/${existing.id}`, { body });
    return `Updated the job reports comment on #${pr}.`;
  }
  api('POST', `repos/${repo}/issues/${pr}/comments`, { body });
  return `Posted the job reports comment on #${pr}.`;
}

/**
 * What a failed call means for the log: a notice when the token may not
 * comment, a warning otherwise.
 *
 * @param {unknown} error
 * @param {string} what
 */
export function explain(error, what) {
  const status = statusOf(error);
  if (status === 403) {
    return `::notice::job-reports: no comment on ${what}: the token can't write it (HTTP 403; the caller's job-reports workflow needs pull-requests: write, which a Dependabot or fork run never has).`;
  }
  return `::warning::job-reports: no comment on ${what}: ${reason(error)}`;
}

/**
 * Keeps the comment on each of the run's pull requests.
 *
 * @param {Record<string, string | undefined>} env
 * @param {Api} api
 * @param {Download} download
 * @returns {string[]} what happened, a line each
 */
export function keepComments(env, api, download) {
  const repo = env.GITHUB_REPOSITORY ?? '';
  const runId = env.RUN_ID ?? '';
  if (!repo || !/^\d+$/.test(runId)) {
    return ['::warning::job-reports: GITHUB_REPOSITORY and RUN_ID are needed to comment.'];
  }
  const work = mkdtempSync(path.join(tmpdir(), 'job-reports-comment-'));
  try {
    try {
      download(runId, work);
    } catch {
      return [`Run ${runId} has no job reports, so no comment.`];
    }
    const run = /** @type {RunInfo} */ (api('GET', `repos/${repo}/actions/runs/${runId}`));
    const own = readSections(work, jobOrder(api, repo, runId), run.name, run.head_sha);
    if (!own.length) return [`Run ${runId} has no job sections, so no comment.`];
    const prs = pullRequestsOf(api, repo, run);
    if (!prs.length) return [`Run ${runId} has no open pull request, so no comment.`];
    return prs.map((pr) => {
      try {
        return updateComment(api, repo, pr, run, own);
      } catch (error) {
        return explain(error, `#${pr}`);
      }
    });
  } catch (error) {
    return [explain(error, `run ${runId}`)];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** @type {Api} */
function realApi(method, route, body) {
  const out = execFileSync('gh', ['api', '-X', method, route, ...(body ? ['--input', '-'] : [])], {
    input: body ? JSON.stringify(body) : undefined,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  return out.trim() ? JSON.parse(out) : null;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Download}
 */
const realDownload = (env) => (runId, dir) => {
  execFileSync(
    'gh',
    [
      'run',
      'download',
      runId,
      '--repo',
      env.GITHUB_REPOSITORY ?? '',
      '--pattern',
      'job-summary-*',
      '--dir',
      dir,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
  );
};

/**
 * Logs what happened. Never throws.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {Api} [api]
 * @param {Download} [download]
 */
export function main(env = process.env, api = realApi, download = realDownload(env)) {
  try {
    for (const line of keepComments(env, api, download)) console.log(line);
  } catch (error) {
    console.log(explain(error, 'this run'));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
