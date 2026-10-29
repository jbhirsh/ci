// Publishes a workflow run's job reports (job-summary's report.html, one
// per job, in the job-summary-<job> artifacts) to the repository's GitHub
// Pages branch, `job-reports`, at runs/<run>/<job>/, where each run's
// summary links. publish/action.yml runs it after the workflow finishes
// (job-reports.yml), so a test job never needs write access.
//
// The branch keeps only what Pages serves: reports from the last KEEP_DAYS
// days, an index of them, and no history, as a branch gaining a few hundred
// kilobytes a run would otherwise keep every report forever. So each
// publish is one commit with no parent, pushed with a lease on the commit it
// replaced: a report published meanwhile is read in and kept on the next
// try. (A concurrency group would serialize publishes instead, but GitHub
// keeps only one waiting run per group and cancels the rest, which would
// drop a run's reports.)
//
//   node publish.mjs   (env: RUN_ID, GITHUB_REPOSITORY, GH_TOKEN, KEEP_DAYS;
//                       REMOTE, a git remote in place of GitHub's, for tests)

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { KEEP_DAYS } from './report.mjs';

/** @typedef {(args: string[], cwd?: string, env?: Record<string, string>) => string} Run */

/** The branch Pages serves. */
export const BRANCH = 'job-reports';
/** How many times a push is tried when another publish got there first. */
export const TRIES = 6;

/**
 * A run's facts, kept beside its reports for the index.
 *
 * @typedef {object} RunMeta
 * @property {number} id
 * @property {number} number
 * @property {string} workflow
 * @property {string} branch
 * @property {string} sha
 * @property {string} created ISO time
 * @property {string} url
 * @property {string[]} jobs the report folders
 */

/**
 * Text escaped for HTML.
 *
 * @param {string} text
 */
function esc(text) {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

/**
 * The runs the site holds, newest first, each from its meta.json.
 *
 * @param {string} site
 * @returns {RunMeta[]}
 */
export function runsIn(site) {
  const dir = path.join(site, 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((id) => {
      try {
        /** @type {RunMeta} */
        const meta = JSON.parse(readFileSync(path.join(dir, id, 'meta.json'), 'utf8'));
        return [meta];
      } catch {
        return [];
      }
    })
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
}

/**
 * Puts a run's reports in the site: each artifact folder's report.html at
 * runs/<run>/<job>/index.html, with the run's facts beside them.
 *
 * @param {string} site
 * @param {string} downloaded the folder the artifacts were downloaded into
 * @param {Omit<RunMeta, 'jobs'>} meta
 * @returns {string[]} the jobs added
 */
export function addRun(site, downloaded, meta) {
  const jobs = readdirSync(downloaded)
    .filter((name) => name.startsWith('job-summary-'))
    .filter((name) => existsSync(path.join(downloaded, name, 'report.html')))
    .sort();
  if (!jobs.length) return [];
  const runDir = path.join(site, 'runs', String(meta.id));
  const slugs = jobs.map((name) => {
    const slug = name.replace(/^job-summary-/, '');
    mkdirSync(path.join(runDir, slug), { recursive: true });
    cpSync(path.join(downloaded, name, 'report.html'), path.join(runDir, slug, 'index.html'));
    return slug;
  });
  const before = existsSync(path.join(runDir, 'meta.json'))
    ? /** @type {RunMeta} */ (JSON.parse(readFileSync(path.join(runDir, 'meta.json'), 'utf8')))
    : null;
  const all = [...new Set([...(before?.jobs ?? []), ...slugs])].sort();
  writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ ...meta, jobs: all }, null, 2));
  return slugs;
}

/**
 * Deletes runs older than `days`, or with no facts to date them by.
 *
 * @param {string} site
 * @param {number} days
 * @param {number} now milliseconds
 * @returns {string[]} the run folders deleted
 */
export function prune(site, days, now) {
  const dir = path.join(site, 'runs');
  if (!existsSync(dir)) return [];
  const kept = new Set(
    runsIn(site)
      .filter((m) => now - Date.parse(m.created) <= days * 86_400_000)
      .map((m) => String(m.id)),
  );
  const gone = readdirSync(dir).filter((id) => !kept.has(id));
  for (const id of gone) rmSync(path.join(dir, id), { recursive: true, force: true });
  return gone;
}

/**
 * The site's front page: its runs, newest first, each with its jobs'
 * reports.
 *
 * @param {string} repo owner/name
 * @param {RunMeta[]} runs newest first
 */
export function indexPage(repo, runs) {
  const rows = runs
    .map(
      (r) =>
        `<li><a class="run" href="${esc(r.url)}">${esc(r.workflow)} #${r.number}</a> <span>${esc(r.branch)} · ${esc(r.sha.slice(0, 7))} · ${esc(new Date(r.created).toISOString().slice(0, 16).replace('T', ' '))} UTC</span><div>${r.jobs
          .map((j) => `<a href="runs/${r.id}/${esc(j)}/">${esc(j)}</a>`)
          .join('')}</div></li>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job reports · ${esc(repo)}</title>
<style>
:root { --bg: #f7f8fa; --fg: #1c2230; --muted: #5d6677; --line: #dfe3ea; --accent: #2f5fd0; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #12151b; --fg: #e4e8ef; --muted: #98a2b3; --line: #2c323d; --accent: #7ea2ff; } }
body { background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 24px max(16px, env(safe-area-inset-left)); }
main { max-width: 860px; margin: 0 auto; } h1 { font-size: 20px; } a { color: var(--accent); }
ul { list-style: none; padding: 0; } li { border-bottom: 1px solid var(--line); padding: 10px 0; }
li span { color: var(--muted); font-size: 13px; } li div { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 4px; font-size: 13px; }
</style></head>
<body><main><h1>Job reports for ${esc(repo)}</h1>
<p>Each CI run's job reports, from jbhirsh/ci's job-summary, for the last ${KEEP_DAYS} days.</p>
<ul>
${rows || '<li>No reports yet.</li>'}
</ul></main></body></html>
`;
}

/**
 * A command, run in a folder, its output returned, throwing when it fails.
 *
 * @type {Run}
 */
function realRun(args, cwd, env) {
  const [cmd, ...rest] = args;
  return execFileSync(cmd, rest, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}

/**
 * Publishes a run's reports: downloads its artifacts, then up to TRIES
 * times reads the branch, adds the run, prunes, writes the index and pushes
 * one parentless commit with a lease on the one it replaces.
 *
 * @param {Record<string, string | undefined>} env
 * @param {Run} [run]
 * @param {number} [now] milliseconds
 * @returns {string} what happened
 */
export function publish(env, run = realRun, now = Date.now()) {
  const repo = env.GITHUB_REPOSITORY ?? '';
  const runId = env.RUN_ID ?? '';
  const token = env.GH_TOKEN ?? '';
  const days = Number(env.KEEP_DAYS) || KEEP_DAYS;
  if (!repo || !/^\d+$/.test(runId)) throw new Error('GITHUB_REPOSITORY and RUN_ID are needed');
  const work = mkdtempSync(path.join(tmpdir(), 'job-reports-'));
  try {
    const downloaded = path.join(work, 'artifacts');
    mkdirSync(downloaded);
    try {
      run([
        'gh',
        'run',
        'download',
        runId,
        '--repo',
        repo,
        '--pattern',
        'job-summary-*',
        '--dir',
        downloaded,
      ]);
    } catch {
      return `Run ${runId} has no job reports.`;
    }
    /** @type {{ run_number: number, name: string, head_branch: string | null, head_sha: string, created_at: string, html_url: string }} */
    const info = JSON.parse(run(['gh', 'api', `repos/${repo}/actions/runs/${runId}`]));
    const meta = {
      id: Number(runId),
      number: info.run_number,
      workflow: info.name,
      branch: info.head_branch ?? '',
      sha: info.head_sha,
      created: info.created_at,
      url: info.html_url,
    };
    const site = path.join(work, 'site');
    mkdirSync(site);
    // The token goes to git through its environment, never its command
    // line, which an error message or the process list would show.
    const auth = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    };
    const git = (/** @type {string[]} */ args) => run(['git', ...args], site, auth);
    git(['init', '-q']);
    git(['remote', 'add', 'origin', env.REMOTE || `https://github.com/${repo}.git`]);
    git(['config', 'user.name', 'github-actions[bot]']);
    git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      let lease = '';
      try {
        git(['fetch', '-q', '--depth=1', 'origin', BRANCH]);
        lease = git(['rev-parse', 'FETCH_HEAD']).trim();
        git(['checkout', '-q', '--force', '-B', BRANCH, 'FETCH_HEAD']);
      } catch {
        lease = '';
      }
      const added = addRun(site, downloaded, meta);
      if (!added.length) return `Run ${runId} has no job reports.`;
      prune(site, days, now);
      writeFileSync(path.join(site, 'index.html'), indexPage(repo, runsIn(site)));
      writeFileSync(path.join(site, '.nojekyll'), '');
      git(['add', '--all', '.']);
      const tree = git(['write-tree']).trim();
      const commit = git([
        'commit-tree',
        tree,
        '-m',
        `Publish job reports for run ${meta.number}`,
      ]).trim();
      try {
        git([
          'push',
          '-q',
          `--force-with-lease=refs/heads/${BRANCH}:${lease}`,
          'origin',
          `${commit}:refs/heads/${BRANCH}`,
        ]);
        return `Published ${added.length} report${added.length === 1 ? '' : 's'} for run ${meta.number}: ${added.join(', ')}.`;
      } catch (error) {
        if (attempt === TRIES) throw error;
      }
    }
    return '';
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(publish(process.env));
}
