// Writes a job's summary and its report: how this run went beside the job's
// recent runs, so a step or test getting slower or flaky shows without
// comparing runs by hand (sift's accessibility audit went from about 2
// minutes to 10 before anyone did). The apps run it as the last step of a
// job (action.yml), with `if: !cancelled()`.
//
// This file gathers; the others do the rest. The job's steps and its earlier
// runs come from the Actions API (history.ts), which needs `actions: read`.
// Its tests come from JUnit XML (junit.ts: Maestro's, Playwright's,
// Vitest's), as many reports as the patterns match: a suite and its re-runs
// (sift's <flow>.retry.xml), never two suites, which could share a test's
// name. source.ts finds each test in the checkout, and which commits
// between the runs changed it; model.ts puts it all together (trends.ts
// compares the runs); render.ts writes the summary's Markdown and
// report.ts the report page. Both the page and a small record of this run
// (its tests and the job's time so far, which later runs read back: the
// Actions API keeps a run's step times but not its tests) go in one folder
// (`dir` output) that action.yml uploads as the job's artifact, for
// job-reports.yml to put on the repository's GitHub Pages; so does the
// job's section of the pull request's comment (section.md, render.ts
// section), which job-reports.yml's comment job (comment.ts) puts in the
// one comment it keeps on the PR, as only it may write that comment.
//
// It never fails the job: action.yml's steps continue on error, a lookup
// that doesn't work says why in the summary, and reading earlier runs stops
// after HISTORY_MS, so a slow API can't hold the job past its time limit.
//
// A job's notes and CPU samples come from the files its steps name (NOTES,
// LOAD: sift's own scripts write them) or else from what job-summary/note
// and job-summary/sample-load left in RUNNER_TEMP (telemetry.mjs).
//
//   node summary.ts   (env: JOB; JUNIT (patterns, one per line), NOUN,
//                       NOTES (a JSON file), LOAD (a CSV file), SETTLE,
//                       REPORT_BASE, all optional; GITHUB_REPOSITORY,
//                       GITHUB_WORKFLOW, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
//                       RUNNER_TEMP; GH_TOKEN for gh)

import { execFileSync } from 'node:child_process';
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput, summary } from '../lib/actions.ts';
import { artifactName, current, history } from './history.ts';
import { parseJunit, settleReruns } from './junit.ts';
import { buildModel, noteworthy, parts } from './model.ts';
import { render, section } from './render.ts';
import { pagesBase, report, reportUrl } from './report.ts';
import { changedFiles, locate, realGit, trackedFiles } from './source.ts';
import { telemetryFiles } from './telemetry.mjs';
import { byTest, jobSeconds, stepRows } from './trends.ts';
import type { Gh, Job, PastRun, Run } from './history.ts';
import type { TestCase } from './junit.ts';
import type { Git } from './source.ts';
import type { Sample } from './model.ts';

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
 * @param patterns one per line
 * @param glob
 */
export function reportFiles(
  patterns: string,
  glob: (pattern: string) => string[] = (p) => globSync(p),
): string[] {
  const files = patterns
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => glob(p).sort());
  return [...new Set(files)];
}

/**
 * This run's tests, one per test, or null when no reports were asked for.
 */
export function readTests(
  patterns: string,
  read: (file: string) => string,
  glob?: (pattern: string) => string[],
): TestCase[] | null {
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
 * The record of a run that later runs read back (history.ts parseRecord):
 * its tests (null without reports), and the job's time so far, which later
 * runs compare theirs with, as both stop at the summary (a job's end
 * includes its summary's downloads and the post-job steps).
 */
export function record(job: string, tests: TestCase[] | null, seconds: number | null) {
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
 */
export function parseNotes(text: string): [string, string][] {
  let data: unknown;
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
 * @param text
 * @param start the job's start, milliseconds
 * @param seconds the job's time so far
 */
export function parseLoad(text: string, start: number, seconds: number): Sample[] {
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

/** Options for build, each replaceable in a test. */
export type Io = {
  read?: (file: string) => string;
  glob?: (pattern: string) => string[];
  /** milliseconds */
  now?: number;
  /** an earlier run's record */
  download?: (runId: number, artifact: string) => string | null;
  /** milliseconds, for the history's time limit */
  clock?: () => number;
  /** git in the checkout */
  git?: Git;
  /** the report's template */
  page?: string;
};

/** What build makes. */
export type Built = {
  /** the summary */
  markdown: string;
  /** the job's part of the pull request's comment */
  section: string;
  /** this run's record, null when there's nothing to keep */
  record: string | null;
  /** the report page, null without a run */
  report: string | null;
};

export function build(env: Record<string, string | undefined>, gh: Gh, io: Io = {}): Built {
  const read = io.read ?? ((f) => readFileSync(f, 'utf8'));
  const clock = io.clock ?? Date.now;
  const git = io.git ?? realGit;
  const now = io.now ?? clock();
  const job = env.JOB ?? '';
  if (!job) throw new Error('JOB is not set');
  const repo = env.GITHUB_REPOSITORY ?? '';
  const tests = readTests(env.JUNIT ?? '', read, io.glob);
  const optional = (file: string | undefined) => {
    if (!file) return null;
    try {
      return read(file);
    } catch {
      return null;
    }
  };
  // Without a notes or load input, what job-summary/note and
  // job-summary/sample-load left in RUNNER_TEMP, if they ran.
  const left = telemetryFiles(env);
  const notesText = optional(env.NOTES || left?.notes);
  const notes: [string, string][] =
    notesText !== null
      ? parseNotes(notesText)
      : env.NOTES
        ? [['Notes', `${env.NOTES} couldn't be read`]]
        : [];
  const settle = Number(env.SETTLE);

  let problem = '';
  let run: Run | null = null;
  let thisJob: Job | null = null;
  let past: PastRun[] = [];
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
  const loadText = optional(env.LOAD || left?.load);
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
    section: section(model, link),
    record: tests || thisJob ? record(job, tests, thisJob ? jobSeconds(thisJob, now) : null) : null,
    report: run ? report(model, io.page) : null,
  };
}

function realGh(args: string[]): string {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
}

/**
 * Writes the summary, and puts this run's record, report and comment
 * section in one folder, named in the step's outputs for action.yml to
 * upload as the job's artifact. Never throws: a summary that can't be
 * written is a warning.
 */
export function main(
  env: Record<string, string | undefined> = process.env,
  gh: Gh = realGh,
  io: Io = {},
) {
  try {
    const built = build(env, gh, io);
    summary(built.markdown);
    if (built.record || built.report) {
      const name = artifactName(env.JOB ?? '');
      const dir = path.join(env.RUNNER_TEMP || tmpdir(), 'job-summary', name);
      mkdirSync(dir, { recursive: true });
      if (built.record) writeFileSync(path.join(dir, 'record.json'), built.record);
      if (built.report) writeFileSync(path.join(dir, 'report.html'), built.report);
      writeFileSync(path.join(dir, 'section.md'), built.section);
      setOutput('dir', dir);
      setOutput('artifact', name);
    }
  } catch (error) {
    console.log(`::warning::job-summary: ${error instanceof Error ? error.message : error}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
