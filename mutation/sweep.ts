// The monthly mutation sweep, split into shards that run as parallel jobs
// (.github/workflows/mutation-sweep.yml).
//
// A sweep mutates every in-scope file from scratch. As one job it outgrew
// the job's limit (sift's went from 20 minutes to 117 in a month; BoardGames'
// 12,500 mutants would need most of a day), and a run cut off by the limit
// saves nothing, not even the baseline PR runs start from. So `plan` splits
// the files into shards of near-equal weight, each shard runs as its own job
// and uploads its results, and `merge` puts them back together, judges the
// whole and writes it as main's baseline.
//
// Splitting: the files are those the Stryker config's `mutate` globs select
// among the tracked ones (scope.ts's matching, so the sweep and PR runs
// can't drift). Each goes whole to one shard (a line range can't split a
// file safely: a mutant spanning two ranges belongs to neither), biggest
// first, each to the lightest shard so far, ties to the lower shard and equal
// weights in path order, so the same files and weights always give the same
// split. A file weighs what testing it took in the last results (main's
// baseline, when the cache has one): each mutant Stryker ran counts one,
// plus one for each test covering it, since a mutant's run takes about as
// long as its covering tests (sift's SiftContext.tsx runs about a hundred a
// mutant, and was a quarter of a sweep alone). Ignored mutants never run. A
// file the results don't have weighs its line count at the known files'
// weight per line (its line count when none is known). With
// `sweep.ignoreStatic` false, a static mutant (Stryker's `static`: code run
// as a module loads) weighs one run plus every test in the results, as
// Stryker reruns the whole suite for it, even where the last results ignored
// it for being static: main's baseline comes from PR-style runs that skip
// static mutants. One ignored for another reason (an excluded mutator, a
// disable comment) still never runs, and weighs nothing.
//
// Merging: each shard mutated its own files, so the reports' files are
// disjoint; a file in two means the split went wrong, and the merge stops.
// Every shard ran the whole suite, but Stryker numbers a report's tests in
// the order its run met them, so test "7" in one shard is another test in
// the next. Tests are matched across shards as Stryker's incremental mode
// matches them (test file, start position and name), numbered once, and
// every mutant's coveredBy and killedBy renumbered to match; a test a shard
// names but doesn't list is dropped from them.
//
// Judging: the merged score fails under Stryker's `thresholds.break`, and
// with `perFileThreshold` set, so does any file under it (gate.ts, every
// file whole). Where Stryker would pass a run that tested nothing (its score
// is NaN), this fails it: a sweep with nothing to score is broken. The
// merged results are written only when every shard reported, since they
// become main's baseline, which PR runs start from: one missing a shard
// would send PRs to re-test its files, or score them on nothing. A partial
// sweep's score is still shown, for information, and fails the run. With
// `sweep.ignoreStatic` false, static mutants are left out of the score, the
// break and the per-file gate, and shown in a row of their own: PR runs skip
// them, so they get no threshold until a sweep has measured them. The merged
// results still hold every mutant.
//
// Usage (in the app's checkout, or APP_ROOT):
//   node sweep.ts plan [results]
//     Splits into `sweep.shards` shards, weighed by [results] (main's last
//     reports/stryker-incremental.json) when it can be read. Prints the
//     split; writes the outputs `matrix` (one entry per shard, its files
//     comma-joined as `mutate`) and `count`, and the table to the summary.
//   node sweep.ts config <out>
//     Writes the Stryker config to <out> with no break threshold: a shard's
//     score is one part's, and only the merge judges. `sweep.ignoreStatic`,
//     when set, becomes its `ignoreStatic`.
//   node sweep.ts merge <dir> <count> <out>
//     Merges the shards' results (one directory per shard in <dir>, each
//     with its stryker-incremental.json) into <out>, written only when all
//     <count> reported. Writes the output `complete` (true/false) and the
//     verdict to the summary; exits 1 when incomplete, empty or failing.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput, summary } from '../lib/actions.ts';
import { appRoot } from '../lib/app.ts';
import { judge } from './gate.ts';
import { allMutants, counts, parseReport, readText, relativeName } from './report.ts';
import { gitIn, inMutateScope } from './scope.ts';
import { breakThreshold, readSettings, readStrykerConfig } from './settings.ts';
import type { Counts, Mutant, Report, Test } from './report.ts';

export type Shard = { files: string[]; weight: number };

/**
 * Whether a run testing static mutants reruns the whole suite for this one:
 * it is static, and not ignored for anything but that (Stryker's reason).
 */
export function runsSuite(mutant: Mutant) {
  if (mutant.static !== true) return false;
  return mutant.status !== 'Ignored' || String(mutant.statusReason).startsWith('Static mutant');
}

/**
 * What testing one mutant took: one run, plus each test covering it. Given
 * `suite`, the whole suite's test count, a static mutant runs all of them.
 */
export function mutantWeight(mutant: Mutant, suite: number | null = null) {
  if (suite !== null && runsSuite(mutant)) return 1 + suite;
  return mutant.status === 'Ignored' ? 0 : 1 + (mutant.coveredBy?.length ?? 0);
}

/**
 * Each file's weight in a set of results, by cwd-relative name; with
 * `testsStatic`, its static mutants weigh the whole suite.
 */
export function reportWeights(
  report: Report,
  cwd: string,
  testsStatic = false,
): Map<string, number> {
  const suite = testsStatic
    ? Object.values(report.testFiles ?? {}).reduce((n, file) => n + (file.tests?.length ?? 0), 0)
    : null;
  const weights: Map<string, number> = new Map();
  for (const [name, file] of Object.entries(report.files ?? {})) {
    const weight = (file.mutants ?? []).reduce((sum, m) => sum + mutantWeight(m, suite), 0);
    weights.set(relativeName(name, cwd), weight);
  }
  return weights;
}

/**
 * Each file's weight: its weight in `known` when there is one, else its line
 * count at the weight per line of the files `known` has (1 with none).
 */
export function fileWeights(
  files: string[],
  lines: (file: string) => number,
  known: Map<string, number>,
): Map<string, number> {
  let weight = 0;
  let knownLines = 0;
  for (const file of files) {
    const w = known.get(file);
    if (w === undefined) continue;
    weight += w;
    knownLines += lines(file);
  }
  const perLine = knownLines > 0 ? weight / knownLines : 1;
  return new Map(files.map((file) => [file, known.get(file) ?? Math.round(lines(file) * perLine)]));
}

/**
 * The files in at most `count` shards of near-equal weight (never an empty
 * one), each shard's files in path order.
 */
export function splitShards(weights: Map<string, number>, count: number): Shard[] {
  const weightOf = (file: string) => weights.get(file) ?? 0;
  const order = [...weights.keys()].sort((a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : 1));
  const shards: Shard[] = Array.from({ length: Math.min(count, order.length) }, () => ({
    files: [],
    weight: 0,
  }));
  for (const file of order) {
    let lightest = 0;
    for (let i = 1; i < shards.length; i++) {
      if (shards[i].weight < shards[lightest].weight) lightest = i;
    }
    shards[lightest].files.push(file);
    shards[lightest].weight += weightOf(file);
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

/**
 * The split for the tracked files, the `mutate` globs and the last results.
 */
export function plan({
  tracked,
  mutate,
  results,
  lines,
  count,
  cwd,
  testsStatic = false,
}: {
  tracked: string[];
  mutate: string[];
  results: Report | null;
  lines: (file: string) => number;
  count: number;
  cwd: string;
  testsStatic?: boolean;
}) {
  const files = tracked.filter((file) => inMutateScope(file, mutate)).sort();
  // No file means no shard, and GitHub fails an empty matrix with a message
  // that names neither the globs nor this repo: say what's wrong here.
  if (files.length === 0) {
    throw new Error(`no tracked file matches the mutate globs (${mutate.join(', ')})`);
  }
  const known = results ? reportWeights(results, cwd, testsStatic) : new Map();
  return {
    shards: splitShards(fileWeights(files, lines, known), count),
    fromResults: known.size > 0,
  };
}

/**
 * A GitHub Actions job matrix with one entry per shard.
 */
export function shardMatrix(shards: Shard[]) {
  return { include: shards.map(({ files }, i) => ({ shard: i + 1, mutate: files.join(',') })) };
}

/**
 * The split as a Markdown table.
 */
export function shardTable(shards: Shard[], fromResults: boolean, testsStatic = false) {
  const tested = testsStatic ? ', static ones as the whole suite' : '';
  const unit = fromResults ? `mutants plus covering tests${tested}, last results` : 'lines';
  const rows = shards.map(({ files, weight }, i) => `| ${i + 1} | ${files.length} | ${weight} |`);
  return [`| Shard | Files | Weight (${unit}) |`, '| --- | --- | --- |', ...rows, ''].join('\n');
}

/**
 * The Stryker config for one shard: no break threshold, and `ignoreStatic`
 * when the sweep sets one (null keeps the config's).
 */
export function shardConfig(config: Record<string, unknown>, ignoreStatic: boolean | null = null) {
  const thresholds =
    typeof config.thresholds === 'object' && config.thresholds !== null ? config.thresholds : {};
  const shard = { ...config, thresholds: { ...thresholds, break: null } };
  return ignoreStatic === null ? shard : { ...shard, ignoreStatic };
}

/**
 * The results with only their non-static mutants, or only their static ones.
 */
export function staticPart(report: Report, wanted: boolean): Report {
  const files: NonNullable<Report['files']> = {};
  for (const [name, file] of Object.entries(report.files ?? {})) {
    files[name] = {
      ...file,
      mutants: (file.mutants ?? []).filter((m) => (m.static === true) === wanted),
    };
  }
  return { ...report, files };
}

/**
 * The key Stryker's incremental mode knows a test by across runs.
 */
export function testKey(fileName: string, test: Test, cwd: string) {
  const start = test.location?.start;
  return `${relativeName(fileName, cwd)}@${start?.line ?? 0}:${start?.column ?? 0}\n${test.name}`;
}

/**
 * The shards' results as one, tests numbered once across them, with the
 * config's whole scope and thresholds. Throws on a file in two shards.
 */
export function mergeReports(
  reports: Report[],
  config: { mutate: string[]; thresholds: Record<string, unknown> },
  cwd: string,
): Report {
  const files: NonNullable<Report['files']> = {};
  const testFiles: NonNullable<Report['testFiles']> = {};
  const seen = new Set();
  const ids: Map<string, string> = new Map();
  for (const report of reports) {
    const local: Map<string, string> = new Map();
    for (const [fileName, testFile] of Object.entries(report.testFiles ?? {})) {
      const merged = (testFiles[fileName] ??= { ...testFile, tests: [] });
      for (const test of testFile.tests ?? []) {
        const key = testKey(fileName, test, cwd);
        let id = ids.get(key);
        if (id === undefined) {
          id = String(ids.size);
          ids.set(key, id);
          merged.tests?.push({ ...test, id });
        }
        local.set(test.id, id);
      }
    }
    const renumber = (list: string[] | undefined) =>
      list?.map((id) => local.get(id)).filter((id) => id !== undefined);
    for (const [fileName, file] of Object.entries(report.files ?? {})) {
      const name = relativeName(fileName, cwd);
      if (seen.has(name)) throw new Error(`${name} is in more than one shard's results`);
      seen.add(name);
      files[fileName] = {
        ...file,
        mutants: (file.mutants ?? []).map((mutant) => ({
          ...mutant,
          coveredBy: renumber(mutant.coveredBy),
          killedBy: renumber(mutant.killedBy),
        })),
      };
    }
  }
  const [first = {}] = reports;
  return {
    ...first,
    files,
    testFiles,
    thresholds: config.thresholds,
    config: { ...first.config, mutate: config.mutate, thresholds: config.thresholds },
  };
}

/**
 * The verdict on a merge: whether it's complete, whether it passes, and the
 * summary to show.
 */
export function verdict({
  found,
  expected,
  counts: c,
  breakAt,
  perFile = null,
  statics = null,
}: {
  found: number;
  expected: number;
  counts: Counts;
  breakAt: number | null;
  perFile?: { pass: boolean; lines: string[] } | null;
  statics?: Counts | null;
}) {
  const complete = found === expected;
  const row = (k: Counts, limit: string) =>
    `| ${k.score === null ? 'none' : `${k.score.toFixed(2)}%`} | ${limit} | ${k.killed} | ${k.timeout} | ${k.survived} | ${k.noCoverage} | ${k.errors} | ${k.ignored} |`;
  const head = '| Score | Break | Killed | Timeout | Survived | No coverage | Errors | Ignored |';
  const rule = '| --- | --- | --- | --- | --- | --- | --- | --- |';
  const table = statics
    ? [
        `| Mutants ${head}`,
        `| --- ${rule}`,
        `| Not static ${row(c, String(breakAt ?? 'none'))}`,
        `| Static ${row(statics, 'report only')}`,
      ]
    : [head, rule, row(c, String(breakAt ?? 'none'))];
  const lines = [
    `### Mutation sweep${complete ? '' : ' (incomplete)'}`,
    '',
    `Shards reported: ${found} of ${expected}.`,
    '',
    ...table,
    '',
  ];
  let pass = true;
  if (!complete) {
    pass = false;
    lines.push(
      "Not every shard reported, so this covers only some files, and main's baseline is left as it was.",
    );
  } else if (c.score === null) {
    pass = false;
    lines.push(statics ? 'No non-static mutant was tested.' : 'No mutant was tested.');
  } else {
    if (breakAt !== null && c.score < breakAt) {
      pass = false;
      lines.push(`The score is under the break threshold of ${breakAt}.`);
    }
    if (perFile) {
      pass &&= perFile.pass;
      lines.push('', '```', ...perFile.lines, '```');
    }
  }
  return { complete, pass, summary: `${lines.join('\n')}\n` };
}

/**
 * The shard directories in `dir`, sorted, or none when it can't be read.
 */
function shardDirs(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Writes `text` to `file`, making its directory first.
 */
function write(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const positive = (text: string | undefined) => {
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const USAGE = 'Usage: sweep.ts plan [results] | config <out> | merge <dir> <count> <out>';

/**
 * The command line. Returns the exit code.
 */
export function main(args: string[], root: string = appRoot()) {
  const [command, ...rest] = args;
  const settings = readSettings(root);
  const config = readStrykerConfig(settings, root);
  // Scored apart, static mutants are report only because PR runs skip them.
  if (settings.sweep.ignoreStatic === false && config.raw.ignoreStatic !== true) {
    throw new Error(
      `mutation: "sweep.ignoreStatic" false needs ${settings.strykerConfig} to set "ignoreStatic": true, so PR runs skip the static mutants the sweep tests`,
    );
  }
  const at = (file: string) => path.resolve(root, file);
  if (command === 'plan') {
    const tracked = gitIn(root)('ls-files', '-z').split('\0').filter(Boolean);
    const { shards, fromResults } = plan({
      tracked,
      mutate: config.mutate,
      results: rest[0] ? parseReport(readText(at(rest[0]))) : null,
      lines: (file) => (readText(at(file)) ?? '').split('\n').length,
      count: settings.sweep.shards,
      cwd: root,
      testsStatic: settings.sweep.ignoreStatic === false,
    });
    const table = shardTable(shards, fromResults, settings.sweep.ignoreStatic === false);
    console.log(table);
    for (const [i, { files }] of shards.entries())
      console.log(`Shard ${i + 1}: ${files.join(', ')}`);
    setOutput('matrix', JSON.stringify(shardMatrix(shards)));
    setOutput('count', String(shards.length));
    summary(`### Mutation sweep shards\n\n${table}`);
    return 0;
  }
  if (command === 'config' && rest[0]) {
    const shard = shardConfig(config.raw, settings.sweep.ignoreStatic);
    write(at(rest[0]), `${JSON.stringify(shard, null, 2)}\n`);
    return 0;
  }
  const expected = positive(rest[1]);
  if (command === 'merge' && rest[0] && expected !== null && rest[2]) {
    const reports: Report[] = [];
    for (const shard of shardDirs(at(rest[0]))) {
      const report = parseReport(
        readText(path.join(at(rest[0]), shard, 'stryker-incremental.json')),
      );
      if (report) reports.push(report);
      else console.error(`No readable results from ${shard}.`);
    }
    const merged = mergeReports(reports, config, root);
    const apart = settings.sweep.ignoreStatic === false;
    const scored = apart ? staticPart(merged, false) : merged;
    const threshold = settings.perFileThreshold;
    const result = verdict({
      found: reports.length,
      expected,
      counts: counts(allMutants(scored)),
      breakAt: breakThreshold(config),
      perFile: threshold === null ? null : judge(scored, null, threshold, root),
      statics: apart ? counts(allMutants(staticPart(merged, true))) : null,
    });
    if (result.complete) write(at(rest[2]), JSON.stringify(merged));
    console.log(result.summary);
    setOutput('complete', String(result.complete));
    summary(result.summary);
    return result.pass ? 0 : 1;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
