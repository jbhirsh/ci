// Holds `verify.command` (settings.mjs) to the job it stands in for: the
// rewrite runs it on the amended commit in place of `verify.check`, so if
// it ran less than that job, a functional failure behind the visual one
// could come out green (carry.mjs). The self-test finds the job whose name
// (or id, without one) is `verify.check` in the app's workflows, and
// passes when the command's `&&`-joined parts are, in order, the job's
// one-line `run:` steps from the first of them to its last: it may leave
// out the setup before (npm ci, which the rewrite has done), never a step
// after. Multi-line steps (scripts noting versions, checking files) aren't
// counted. For a job that compares through this repo's compare action
// (sift's), the command must be COMPARE_COMMAND.
//
// The workflows are read line by line, by indentation, as GitHub writes
// them: the self-test runs with this repo's runtime packages only, which
// hold no YAML parser.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * A job as read here: its id, its name if it has one, and the `run:` and
 * `uses:` of its steps.
 *
 * @typedef {{ id: string, name: string | undefined, runs: string[], uses: string[] }} Job
 */

/**
 * The verify command for a job using the compare action: compare.mjs on
 * the run's screenshots, writing its diffs where from-run/action.yml
 * uploads them from (the variables that action sets).
 */
export const COMPARE_COMMAND =
  'node "$VISUAL_BASELINES_TOOLS/compare.mjs" "$VISUAL_BASELINES_FRESH" "$VISUAL_BASELINES_DIFFS"';

/** @param {string} line */
const indentOf = (line) => line.length - line.trimStart().length;

/** @param {string} line */
const blank = (line) => line.trim() === '' || line.trimStart().startsWith('#');

/**
 * A scalar's text, its quotes and any trailing comment taken off.
 *
 * @param {string} value
 */
function scalar(value) {
  const v = value.trim();
  const quoted = /^(['"])(.*)\1$/.exec(v);
  if (quoted) return quoted[2];
  return v.replace(/\s+#.*$/, '');
}

/**
 * The jobs in a workflow's text.
 *
 * @param {string} text
 * @returns {Job[]}
 */
export function jobsOf(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line));
  if (start === -1) return [];
  /** @type {Job[]} */
  const jobs = [];
  let jobIndent = -1;
  /** @type {Job | undefined} */
  let job;
  let keyIndent = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (blank(line)) continue;
    const indent = indentOf(line);
    if (indent === 0) break;
    if (jobIndent === -1) jobIndent = indent;
    if (indent <= jobIndent) {
      const id = /^\s*([\w-]+):\s*(#.*)?$/.exec(line)?.[1];
      job = id === undefined ? undefined : { id, name: undefined, runs: [], uses: [] };
      if (job) jobs.push(job);
      keyIndent = -1;
      continue;
    }
    if (!job) continue;
    if (keyIndent === -1) keyIndent = indent;
    const name = indent === keyIndent ? /^\s*name:\s*(.+)$/.exec(line) : null;
    if (name) job.name = scalar(name[1]);
    const step = /^(\s*)(?:-\s+)?(run|uses):\s*(.*)$/.exec(line);
    if (!step || (indent === keyIndent && !line.trimStart().startsWith('-'))) continue;
    const [, , key, value] = step;
    let text = value.trim();
    if (/^[|>][-+]?$/.test(text)) {
      // A block: the lines indented past the key.
      const own = indentOf(line) + (line.trimStart().startsWith('-') ? 2 : 0);
      /** @type {string[]} */
      const block = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || indentOf(lines[i + 1]) > own)) {
        block.push(lines[++i].trim());
      }
      text = block.join('\n').trim();
    } else {
      text = scalar(text);
    }
    (key === 'run' ? job.runs : job.uses).push(text);
  }
  return jobs;
}

/**
 * Whether `command` is what `job` runs: its one-line run steps from the
 * first part on, in order, or COMPARE_COMMAND for a job using the compare
 * action.
 *
 * @param {Job} job
 * @param {string} command
 */
export function runsAsJob(job, command) {
  if (job.uses.some((u) => /^jbhirsh\/ci\/visual-baselines\/compare@/.test(u))) {
    return command === COMPARE_COMMAND;
  }
  const parts = command.split('&&').map((part) => part.trim());
  const steps = job.runs.filter((run) => !run.includes('\n'));
  const from = steps.indexOf(parts[0]);
  const rest = steps.slice(from);
  return from !== -1 && rest.length === parts.length && rest.every((step, i) => step === parts[i]);
}

/**
 * Checks `verify` against the app's workflows, returning a log line;
 * throws when no job is `verify.check`, or the command isn't what it runs.
 *
 * @param {string} root
 * @param {import('./settings.mjs').Verify} verify
 */
export function checkVerify(root, { check, command }) {
  const dir = path.join(root, '.github', 'workflows');
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /\.ya?ml$/.test(f))
        .sort()
    : [];
  const found = files.flatMap((file) =>
    jobsOf(readFileSync(path.join(dir, file), 'utf8'))
      .filter((job) => (job.name ?? job.id) === check)
      .map((job) => ({ file, job })),
  );
  if (found.length === 0) {
    throw new Error(`visual-baselines.verify.check: no job in .github/workflows is named ${check}`);
  }
  const match = found.find(({ job }) => runsAsJob(job, command));
  if (!match) {
    throw new Error(
      `visual-baselines.verify.command \`${command}\` isn't what ${check} runs (${found.map(({ file, job }) => `${file}: ${job.runs.join(' / ') || 'no run steps'}`).join('; ')}): its one-line run steps, in order, from any of them to the last, joined by &&`,
    );
  }
  return `visual-baselines: verify runs ${check}'s \`${command}\` (${match.file}).`;
}
