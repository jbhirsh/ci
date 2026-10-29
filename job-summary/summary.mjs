// Writes a job's step times and, from JUnit reports, each test's result and
// time to the job summary, so a step or test getting slower shows on the
// run's page without opening an artifact: sift's accessibility audit went
// from about 2 minutes to 10 before anyone compared runs by hand. The apps
// run it as the last step of a job (action.yml), with
// `if: ${{ !cancelled() }}`.
//
// The step times come from the Actions API, the job found by its name, which
// needs `actions: read`; a step the API still shows running (this one, or the
// one before it, which the API can be slow to close) is timed up to now. The
// tests come from JUnit XML (Maestro's, Playwright's, Vitest's), as many
// files as the patterns match. A test that failed in one report and passed
// in another (a re-run: sift's <flow>.retry.xml) counts as passed on re-run,
// not failed. Every failure is listed, then the slowest of the rest, up to
// MAX_ROWS, as GitHub drops a summary over 1 MiB.
//
// It never fails the job: action.yml's steps continue on error, and a lookup
// that doesn't work says why in the summary.
//
//   node summary.mjs   (env: JOB, JUNIT (patterns, one per line, optional),
//                       GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT;
//                       GH_TOKEN for gh)

import { execFileSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { summary } from '../lib/actions.mjs';

/** @typedef {(args: string[]) => string} Gh */

/**
 * A job's step, as the Actions API gives it.
 *
 * @typedef {object} Step
 * @property {string} name
 * @property {string | null} conclusion
 * @property {string | null} started_at
 * @property {string | null} completed_at
 */

/**
 * @typedef {object} StepRow
 * @property {string} name
 * @property {number} seconds
 * @property {string} conclusion "running" for a step not finished yet
 */

/**
 * The job's steps, or why there are none.
 *
 * @typedef {{ rows: StepRow[] } | { problem: string }} JobSteps
 */

/**
 * One test (a flow, a spec) from a JUnit report.
 *
 * @typedef {object} TestCase
 * @property {string} name
 * @property {number} seconds
 * @property {'passed' | 'failed' | 'skipped' | 'passed on re-run'} result
 * @property {string} file the report it came from
 */

/** The most test rows listed; every failure is listed even past it. */
export const MAX_ROWS = 50;

/**
 * Seconds between two API timestamps, never negative or NaN.
 *
 * @param {string} start
 * @param {number} end milliseconds
 */
function elapsed(start, end) {
  const seconds = (end - Date.parse(start)) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

/**
 * The steps that ran, with how long each took: not skipped ones, nor those
 * not started yet (the post-job steps). One the API still shows running is
 * timed up to `now`.
 *
 * @param {Step[]} steps
 * @param {number} [now] milliseconds
 * @returns {StepRow[]}
 */
export function stepRows(steps, now = Date.now()) {
  return steps
    .filter((s) => s.started_at && s.conclusion !== 'skipped')
    .map((s) => ({
      name: s.name,
      seconds: elapsed(s.started_at ?? '', s.completed_at ? Date.parse(s.completed_at) : now),
      conclusion: s.completed_at ? (s.conclusion ?? '') : 'running',
    }));
}

const ENTITIES = /** @type {Record<string, string>} */ ({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

/**
 * An XML attribute value or text with its entities replaced.
 *
 * @param {string} text
 */
export function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? whole;
    const n =
      code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}

/**
 * A tag's attributes.
 *
 * @param {string} tag the text between `<testcase` and `>`
 * @returns {Record<string, string>}
 */
function attributes(tag) {
  /** @type {Record<string, string>} */
  const found = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    found[m[1]] = unescapeXml(m[3] ?? m[4] ?? '');
  }
  return found;
}

/** Maestro's statuses for a flow that didn't fail: anything else did. */
const OK_STATUS = /^(|success|passed|pass|ok|warning)$/;

/**
 * The test cases in a JUnit report. Read with patterns rather than an XML
 * library (this repo installs nothing in the app), after taking out comments
 * and CDATA sections, which hold captured output and messages that may look
 * like elements. A `<failure>` or `<error>` inside a case, or a status
 * attribute other than a success (Maestro's), is a failure; `<skipped>` is a
 * skip. Anything that isn't JUnit yields no cases, never an error.
 *
 * @param {string} xml
 * @param {string} [file]
 * @returns {TestCase[]}
 */
export function parseJunit(xml, file = '') {
  const text = xml.replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/<!\[CDATA\[[\s\S]*?(\]\]>|$)/g, '');
  /** @type {TestCase[]} */
  const cases = [];
  const pattern = /<testcase\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/testcase\s*>)/g;
  for (const m of text.matchAll(pattern)) {
    const attrs = attributes(m[1]);
    const inner = m[3] ?? '';
    const status = (attrs.status ?? '').toLowerCase();
    /** @type {TestCase['result']} */
    let result = 'passed';
    if (/<skipped\b/.test(inner) || /^(skip|skipped)$/.test(status)) result = 'skipped';
    if (/<(failure|error)\b/.test(inner) || !(OK_STATUS.test(status) || result === 'skipped')) {
      result = 'failed';
    }
    const seconds = Number(attrs.time);
    cases.push({
      name: attrs.name || attrs.classname || attrs.file || '?',
      seconds: Number.isFinite(seconds) && seconds >= 0 ? seconds : 0,
      result,
      file,
    });
  }
  return cases;
}

/**
 * The cases with re-runs settled: a failure whose test passed in another
 * report reads "passed on re-run" (the re-run's row stays as it is). Which
 * report came first isn't known: the patterns' files sort by name, and
 * sift's 19_swipe_decisions.retry.xml sorts before its suite.xml.
 *
 * @param {TestCase[]} cases
 * @returns {TestCase[]}
 */
export function settleReruns(cases) {
  return cases.map((c) =>
    c.result === 'failed' &&
    cases.some(
      (other) => other.file !== c.file && other.name === c.name && other.result === 'passed',
    )
      ? { ...c, result: 'passed on re-run' }
      : c,
  );
}

/**
 * A table cell: one line, shown as written (no Markdown or HTML of its own,
 * so a test named "renders <Card />" keeps its tag), with no character that
 * would end the cell.
 *
 * @param {string} text
 */
export function cell(text) {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]|])/g, '\\$1');
}

/**
 * The summary: the job's step times, then its tests: every failure, then the
 * slowest of the rest, up to MAX_ROWS rows.
 *
 * @param {string} job
 * @param {JobSteps} steps
 * @param {TestCase[]} cases
 * @returns {string}
 */
export function markdown(job, steps, cases) {
  const lines = [`### ${cell(job)}: step times`, ''];
  if ('problem' in steps) {
    lines.push(`No step times: ${cell(steps.problem)}`);
  } else if (steps.rows.length === 0) {
    lines.push('No steps have run.');
  } else {
    lines.push('| Step | Seconds | Result |', '|---|--:|---|');
    for (const s of steps.rows) {
      lines.push(`| ${cell(s.name)} | ${Math.round(s.seconds)} | ${s.conclusion} |`);
    }
  }
  if (cases.length > 0) {
    const count = (/** @type {TestCase['result']} */ r) =>
      cases.filter((c) => c.result === r).length;
    const files = new Set(cases.map((c) => c.file)).size;
    const rerun = count('passed on re-run');
    const bySpeed = [...cases].sort((a, b) => b.seconds - a.seconds);
    const failures = bySpeed.filter((c) => c.result === 'failed');
    const rest = bySpeed.filter((c) => c.result !== 'failed');
    const shown = [...failures, ...rest.slice(0, Math.max(0, MAX_ROWS - failures.length))];
    lines.push(
      '',
      `### Tests: ${cases.length} from ${files} report${files === 1 ? '' : 's'}, ` +
        `${failures.length} failed${rerun ? `, ${rerun} passed on re-run` : ''}`,
      '',
      '| Test | Seconds | Result | Report |',
      '|---|--:|---|---|',
    );
    for (const c of shown) {
      lines.push(
        `| ${cell(c.name)} | ${Math.round(c.seconds)} | ${c.result} | ${cell(c.file.split('/').pop() ?? '')} |`,
      );
    }
    if (shown.length < cases.length) {
      lines.push(
        '',
        `…and ${cases.length - shown.length} faster ones that passed or were skipped.`,
      );
    }
  }
  return lines.join('\n');
}

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
 * The job's steps, or why there are none: the API refused (most likely no
 * `actions: read`), or no job in this attempt has that name.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} job
 * @param {Gh} gh
 * @param {number} [now] milliseconds
 * @returns {JobSteps}
 */
export function jobSteps(env, job, gh, now = Date.now()) {
  const run = `repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const attempt = env.GITHUB_RUN_ATTEMPT || '1';
  /** @type {{ jobs: { name: string, steps?: Step[] }[] }} */
  let data;
  try {
    data = JSON.parse(gh(['api', `${run}/attempts/${attempt}/jobs?per_page=100`]));
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return { problem: `the run's jobs couldn't be read (${reason}); the job needs actions: read.` };
  }
  const found = data.jobs.find((j) => j.name === job);
  if (!found) {
    const names = data.jobs.map((j) => `"${j.name}"`).join(', ');
    return { problem: `no job named "${job}" in this attempt; it has ${names || 'none'}.` };
  }
  return { rows: stepRows(found.steps ?? [], now) };
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {Gh} gh
 * @param {(file: string) => string} [read]
 * @param {(pattern: string) => string[]} [glob]
 * @param {number} [now] milliseconds
 * @returns {string} the summary's Markdown
 */
export function build(env, gh, read = (f) => readFileSync(f, 'utf8'), glob, now = Date.now()) {
  const job = env.JOB ?? '';
  if (!job) throw new Error('JOB is not set');
  const cases = reportFiles(env.JUNIT ?? '', glob).flatMap((f) => {
    try {
      return parseJunit(read(f), f);
    } catch {
      return [];
    }
  });
  return markdown(job, jobSteps(env, job, gh, now), settleReruns(cases));
}

/** @type {Gh} */
function realGh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    summary(build(process.env, realGh));
  } catch (error) {
    console.log(`::warning::job-summary: ${error instanceof Error ? error.message : error}`);
  }
}
