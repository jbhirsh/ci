// Writes a job's summary and its report: how this run went beside the job's
// recent runs, so a step or test getting slower or flaky shows without
// comparing runs by hand (sift's accessibility audit went from about 2
// minutes to 10 before anyone did). The apps run it as the last step of a
// job (action.yml), with `if: !cancelled()`.
//
// This file gathers; the others do the rest. The job's steps and its earlier
// runs come from the Actions API (history.mjs), which needs `actions: read`.
// Its tests come from JUnit XML (junit.mjs: Maestro's, Playwright's,
// Vitest's), as many reports as the patterns match: a suite and its re-runs
// (sift's <flow>.retry.xml), never two suites, which could share a test's
// name. source.mjs finds each test in the checkout, and which commits
// between the runs changed it; model.mjs puts it all together (trends.mjs
// compares the runs); render.mjs writes the summary's Markdown and
// report.mjs the report page. Both the page and a small record of this run
// (its tests and the job's time so far, which later runs read back: the
// Actions API keeps a run's step times but not its tests) go in one folder
// (`dir` output) that action.yml uploads as the job's artifact, for
// job-reports.yml to put on the repository's GitHub Pages.
//
// It never fails the job: action.yml's steps continue on error, a lookup
// that doesn't work says why in the summary, and reading earlier runs stops
// after HISTORY_MS, so a slow API can't hold the job past its time limit.
//
//   node summary.mjs   (env: JOB; JUNIT (patterns, one per line), NOUN,
//                       NOTES (a JSON file), LOAD (a CSV file), SETTLE,
//                       REPORT_BASE, all optional; GITHUB_REPOSITORY,
//                       GITHUB_WORKFLOW, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
//                       RUNNER_TEMP; GH_TOKEN for gh)

import { execFileSync } from 'node:child_process';
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput, summary } from '../lib/actions.mjs';
import { artifactName, current, history } from './history.mjs';
import { parseJunit, settleReruns } from './junit.mjs';
import { buildModel, noteworthy, parts } from './model.mjs';
import { render } from './render.mjs';
import { pagesBase, report, reportUrl } from './report.mjs';
import { changedFiles, locate, realGit, trackedFiles } from './source.mjs';
import { byTest, jobSeconds, stepRows } from './trends.mjs';

/** @typedef {import('./history.mjs').Gh} Gh */
/** @typedef {import('./junit.mjs').TestCase} TestCase */
/** @typedef {import('./source.mjs').Git} Git */
/** @typedef {import('./model.mjs').Sample} Sample */

/** How many earlier runs are compared. */
export const HISTORY = 9;
/** How long reading them may take, so the step can't hold the job up. */
export const HISTORY_MS = 60_000;
/** How far outside the job a CPU sample may fall and still be charted. */
export const LOAD_MARGIN = 60;

/**
 * The files the JUnit patterns match, each once, in order. A pattern's `*`
 * and `**` don't enter dot-folders; name one outright to read it.
 *
 * @param {string} patterns one per line
 * @param {(pattern: string) => string[]} [glob]
 * @returns {string[]}
 */
export function reportFiles(patterns, glob = (p) => globSync(p)) {
  const files = patterns
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => glob(p).sort());
  return [...new Set(files)];
}

/**
 * This run's tests, one per test, or null when no reports were asked for.
 *
 * @param {string} patterns
 * @param {(file: string) => string} read
 * @param {(pattern: string) => string[]} [glob]
 * @returns {TestCase[] | null}
 */
export function readTests(patterns, read, glob) {
  if (!patterns.trim()) return null;
  const cases = reportFiles(patterns, glob).flatMap((f) => {
    try {
      return parseJunit(read(f), f);
    } catch {
      return [];
    }
  });
  return byTest(settleReruns(cases));
}

/**
 * The record of a run that later runs read back (history.mjs parseRecord):
 * its tests (null without reports), and the job's time so far, which later
 * runs compare theirs with, as both stop at the summary (a job's end
 * includes its summary's downloads and the post-job steps).
 *
 * @param {string} job
 * @param {TestCase[] | null} tests
 * @param {number | null} seconds
 */
export function record(job, tests, seconds) {
  return JSON.stringify({
    version: 2,
    job,
    seconds,
    tests: tests?.map(({ name, seconds, result }) => ({ name, seconds, result })) ?? null,
  });
}

/**
 * The notes a job's steps wrote (NOTES): a JSON object, or a list of
 * [label, value] pairs, shown in the report's Environment section.
 *
 * @param {string} text
 * @returns {[string, string][]}
 */
export function parseNotes(text) {
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [['Notes', "couldn't be read: not JSON"]];
  }
  const pairs = Array.isArray(data)
    ? data.filter((p) => Array.isArray(p) && p.length === 2).map((p) => [p[0], p[1]])
    : typeof data === 'object' && data !== null
      ? Object.entries(data)
      : [];
  return pairs.map(([k, v]) => [String(k), String(v)]);
}

/**
 * The machine's CPU samples a job's steps wrote (LOAD): CSV rows of
 * `time,load,busy`, time in Unix seconds, busy in %, made relative to the
 * job's start. A header, bad rows and samples from outside the job (before
 * it, or more than LOAD_MARGIN seconds after it so far: a time in
 * milliseconds, say) are left out.
 *
 * @param {string} text
 * @param {number} start the job's start, milliseconds
 * @param {number} seconds the job's time so far
 * @returns {Sample[]}
 */
export function parseLoad(text, start, seconds) {
  return text
    .split('\n')
    .map((line) => line.split(',').map((v) => Number(v.trim())))
    .filter((r) => r.length >= 3 && r.every(Number.isFinite))
    .map(([time, load, busy]) => ({
      t: time - start / 1000,
      load,
      busy: Math.min(100, Math.max(0, busy)),
    }))
    .filter((p) => p.t >= -LOAD_MARGIN && p.t <= seconds + LOAD_MARGIN)
    .map((p) => ({ ...p, t: Math.max(0, p.t) }));
}

/**
 * Options for build, each replaceable in a test.
 *
 * @typedef {object} Io
 * @property {(file: string) => string} [read]
 * @property {(pattern: string) => string[]} [glob]
 * @property {number} [now] milliseconds
 * @property {(runId: number, artifact: string) => string | null} [download] an
 *   earlier run's record
 * @property {() => number} [clock] milliseconds, for the history's time limit
 * @property {Git} [git] git in the checkout
 * @property {string} [page] the report's template
 */

/**
 * What build makes.
 *
 * @typedef {object} Built
 * @property {string} markdown the summary
 * @property {string | null} record this run's record, null when there's nothing to keep
 * @property {string | null} report the report page, null without a run
 */

/**
 * @param {Record<string, string | undefined>} env
 * @param {Gh} gh
 * @param {Io} [io]
 * @returns {Built}
 */
export function build(env, gh, io = {}) {
  const read = io.read ?? ((f) => readFileSync(f, 'utf8'));
  const clock = io.clock ?? Date.now;
  const git = io.git ?? realGit;
  const now = io.now ?? clock();
  const job = env.JOB ?? '';
  if (!job) throw new Error('JOB is not set');
  const repo = env.GITHUB_REPOSITORY ?? '';
  const tests = readTests(env.JUNIT ?? '', read, io.glob);
  const optional = (/** @type {string | undefined} */ file) => {
    if (!file) return null;
    try {
      return read(file);
    } catch {
      return null;
    }
  };
  const notesText = optional(env.NOTES);
  /** @type {[string, string][]} */
  const notes = env.NOTES
    ? notesText === null
      ? [['Notes', `${env.NOTES} couldn't be read`]]
      : parseNotes(notesText)
    : [];
  const settle = Number(env.SETTLE);

  let problem = '';
  /** @type {import('./history.mjs').Run | null} */
  let run = null;
  /** @type {import('./history.mjs').Job | null} */
  let thisJob = null;
  /** @type {import('./history.mjs').PastRun[]} */
  let past = [];
  // One time limit for reading the history and asking git about it.
  const until = clock() + HISTORY_MS;
  const found = current(env, gh);
  if ('problem' in found) {
    problem = found.problem;
  } else {
    thisJob = found.jobs.find((j) => j.name === job) ?? null;
    if (!thisJob) {
      const names = found.jobs.map((j) => `"${j.name}"`).join(', ');
      problem = `no job named "${job}" in this attempt; it has ${names || 'none'}.`;
    } else {
      run = found.run;
      past = history(repo, run, found.defaultBranch, job, HISTORY, gh, io.download, until, clock);
    }
  }

  const base = env.REPORT_BASE || pagesBase(repo);
  const artifact = artifactName(job);
  const files = tests ? trackedFiles(git) : [];
  const titled = (tests ?? []).map((t) => ({ ...t, title: parts(t).title }));
  const located = locate(titled, new Set(), files, read);
  const commits = run
    ? [...past]
        .reverse()
        .map((p) => p.run)
        .concat(run)
        .map((r) => ({ sha: r.head_sha, branch: r.head_branch ?? '' }))
    : [];
  const changed = tests && run ? changedFiles(commits, git, until, clock) : [];
  const started = Date.parse(thisJob?.started_at ?? '');
  const loadText = optional(env.LOAD);
  const model = buildModel({
    repo,
    workflow: env.GITHUB_WORKFLOW ?? '',
    job,
    noun: env.NOUN || 'test',
    now,
    run,
    current: thisJob,
    steps: thisJob ? stepRows(thisJob.steps ?? [], now) : [],
    problem,
    tests,
    past,
    located,
    changed,
    reportOf: (id) => reportUrl(base, id, artifact),
    notes,
    load:
      loadText && thisJob && Number.isFinite(started)
        ? parseLoad(loadText, started, jobSeconds(thisJob, now))
        : [],
    settle: Number.isFinite(settle) && env.SETTLE ? settle : null,
  });
  // Snippets only for the tests worth reading, now that the model says which.
  const wanted = noteworthy(model);
  if (wanted.size && model.tests) {
    const snippets = locate(
      titled.filter((t) => wanted.has(t.name)),
      wanted,
      files,
      read,
    );
    for (const t of model.tests) t.code = snippets.get(t.name)?.code ?? t.code;
  }
  // A fork's run isn't published (job-reports.yml), so it has no report to link.
  const fork = Boolean(run?.head_repository && run.head_repository.full_name !== repo);
  const link = run && base && !fork ? reportUrl(base, run.id, artifact) : '';
  return {
    markdown: render(model, link),
    record: tests || thisJob ? record(job, tests, thisJob ? jobSeconds(thisJob, now) : null) : null,
    report: run ? report(model, io.page) : null,
  };
}

/** @type {Gh} */
function realGh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
}

/**
 * Writes the summary, and puts this run's record and report in one folder,
 * named in the step's outputs for action.yml to upload as the job's
 * artifact. Never throws: a summary that can't be written is a warning.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {Gh} [gh]
 * @param {Io} [io]
 */
export function main(env = process.env, gh = realGh, io = {}) {
  try {
    const built = build(env, gh, io);
    summary(built.markdown);
    if (built.record || built.report) {
      const name = artifactName(env.JOB ?? '');
      const dir = path.join(env.RUNNER_TEMP || tmpdir(), 'job-summary', name);
      mkdirSync(dir, { recursive: true });
      if (built.record) writeFileSync(path.join(dir, 'record.json'), built.record);
      if (built.report) writeFileSync(path.join(dir, 'report.html'), built.report);
      setOutput('dir', dir);
      setOutput('artifact', name);
    }
  } catch (error) {
    console.log(`::warning::job-summary: ${error instanceof Error ? error.message : error}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
