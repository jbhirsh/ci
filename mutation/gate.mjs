// The per-file mutation-score gate (setting `perFileThreshold`).
//
// Stryker's own `thresholds.break` is one floor for the aggregate score of
// everything mutated. An app that wants every file to clear the bar on its
// own sets `perFileThreshold`, and this fails the run when any mutated file
// scores below it, even when the aggregate passes.
//
// On a PR, MUTATE_SCOPE holds the run's --mutate entries, and only the files
// and lines they name are scored: a file's score is then its changed lines'
// alone (report.mjs's rule for a range), and results the incremental file
// carries for anything else don't count. A file with nothing scorable there
// (only types or comments changed, or only compile-error mutants) has no
// score, which isn't a failure. Without a scope (the sweep) every file is
// scored whole.
//
// Usage: node gate.mjs [report]
// The report defaults to reports/mutation/mutation.json, the `json`
// reporter's output; the sweep's merge passes its merged results instead.
// Prints each file's score, adds them to the job summary, and exits 1 when
// a file is under the threshold or the report is missing.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { summary } from '../lib/actions.mjs';
import { appRoot } from '../lib/app.mjs';
import { counts, inRanges, parseReport, parseScope, readText, relativeName } from './report.mjs';
import { readSettings } from './settings.mjs';

/**
 * @typedef {import('./report.mjs').Report} Report
 * @typedef {import('./report.mjs').Scope} Scope
 * @typedef {{ file: string, score: number | null }} FileScore
 */

/**
 * Each scored file's score, lowest first, files without one last. With a
 * scope, only the files it names count, each on its named lines.
 *
 * @param {Report} report
 * @param {Scope | null} scope
 * @param {string} cwd
 * @returns {FileScore[]}
 */
export function fileScores(report, scope, cwd) {
  /** @type {FileScore[]} */
  const scores = [];
  for (const [file, data] of Object.entries(report.files ?? {})) {
    const name = relativeName(file, cwd);
    if (scope && !scope.has(name)) continue;
    const ranges = scope?.get(name) ?? null;
    const mutants = data.mutants ?? [];
    scores.push({
      file: name,
      score: counts(ranges ? mutants.filter((m) => inRanges(m, ranges)) : mutants).score,
    });
  }
  const rank = (/** @type {number | null} */ s) => s ?? Infinity;
  return scores.sort((a, b) => rank(a.score) - rank(b.score));
}

/**
 * The scored files below `threshold`.
 *
 * @param {FileScore[]} scores
 * @param {number} threshold
 */
export function failures(scores, threshold) {
  return scores.filter((s) => s.score !== null && s.score < threshold);
}

/**
 * The gate's verdict on a report: the lines to print and whether it passes.
 *
 * @param {Report} report
 * @param {Scope | null} scope
 * @param {number} threshold
 * @param {string} cwd
 */
export function judge(report, scope, threshold, cwd) {
  const scores = fileScores(report, scope, cwd);
  const failed = failures(scores, threshold);
  const where = scope ? 'in its changed lines ' : '';
  const lines = scores.map(({ file, score }) =>
    score === null
      ? `  [none] nothing scorable ${where}— ${file}`
      : `  [${score < threshold ? 'FAIL' : 'ok'}] ${score.toFixed(2)}%  ${file}`,
  );
  lines.push('');
  if (failed.length > 0) {
    lines.push(`Mutation score below ${threshold}% for ${failed.length} file(s):`);
    for (const { file, score } of failed) lines.push(`  - ${file}: ${Number(score).toFixed(2)}%`);
    lines.push(
      'Write tests that kill the surviving mutants (see the HTML report) to clear the bar.',
    );
  } else {
    const scored = scores.filter(({ score }) => score !== null).length;
    lines.push(`All ${scored} scored file(s) >= ${threshold}% mutation score.`);
  }
  return { pass: failed.length === 0, lines };
}

/**
 * The command line: `[report]`. Returns the exit code.
 *
 * @param {string[]} args
 * @param {string} [root]
 * @param {Record<string, string | undefined>} [env]
 */
export function main(args, root = appRoot(), env = process.env) {
  const threshold = readSettings(root).perFileThreshold;
  if (threshold === null) {
    console.log('No per-file threshold set (mutation.perFileThreshold): nothing to gate.');
    return 0;
  }
  const file = path.resolve(root, args[0] ?? path.join('reports', 'mutation', 'mutation.json'));
  const report = parseReport(readText(file));
  if (report === null) {
    console.error(
      `No readable mutation report at ${file}: did Stryker run with the json reporter?`,
    );
    return 1;
  }
  const scope = env.MUTATE_SCOPE ? parseScope(env.MUTATE_SCOPE.split(','), root) : null;
  const { pass, lines } = judge(report, scope, threshold, root);
  console.log(lines.join('\n'));
  summary(`### Per-file mutation scores\n\n\`\`\`\n${lines.join('\n')}\n\`\`\``);
  return pass ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
