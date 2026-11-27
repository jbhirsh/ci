// The per-file mutation-score gate (setting `perFileThreshold`).
//
// Stryker's own `thresholds.break` is one floor for the aggregate score of
// everything mutated. An app that wants every file to clear the bar on its
// own sets `perFileThreshold`, and this fails the run when any mutated file
// scores below it, even when the aggregate passes.
//
// On a PR, MUTATE_SCOPE holds the run's --mutate entries, and only the files
// and lines they name are scored: a file's score is then its changed lines'
// alone (report.ts's rule for a range), and results the incremental file
// carries for anything else don't count. A file with nothing scorable there
// (only types or comments changed, or only compile-error mutants) has no
// score, which isn't a failure. Without a scope (the sweep) every file is
// scored whole.
//
// Usage: node gate.ts [report]
// The report defaults to reports/mutation/mutation.json, the `json`
// reporter's output; the sweep's merge passes its merged results instead.
// Prints each file's score, adds them to the job summary, and exits 1 when
// a file is under the threshold or the report is missing.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { summary } from '../lib/actions.ts';
import { appRoot } from '../lib/app.ts';
import { counts, inRanges, parseReport, parseScope, readText, relativeName } from './report.ts';
import { readSettings } from './settings.ts';
import type { Report, Scope } from './report.ts';

export type FileScore = { file: string; score: number | null };

/**
 * Each scored file's score, lowest first, files without one last. With a
 * scope, only the files it names count, each on its named lines.
 */
export function fileScores(report: Report, scope: Scope | null, cwd: string): FileScore[] {
  const scores: FileScore[] = [];
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
  const rank = (s: number | null) => s ?? Infinity;
  return scores.sort((a, b) => rank(a.score) - rank(b.score));
}

/**
 * The scored files below `threshold`.
 */
export function failures(scores: FileScore[], threshold: number) {
  return scores.filter((s) => s.score !== null && s.score < threshold);
}

/**
 * The gate's verdict on a report: the lines to print and whether it passes.
 */
export function judge(report: Report, scope: Scope | null, threshold: number, cwd: string) {
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
 */
export function main(
  args: string[],
  root: string = appRoot(),
  env: Record<string, string | undefined> = process.env,
) {
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
