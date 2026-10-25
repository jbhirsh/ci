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
// among the tracked ones (scope.mjs's matching, so the sweep and PR runs
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
// weight per line (its line count when none is known).
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
// with `perFileThreshold` set, so does any file under it (gate.mjs, every
// file whole). Where Stryker would pass a run that tested nothing (its score
// is NaN), this fails it: a sweep with nothing to score is broken. The
// merged results are written only when every shard reported, since they
// become main's baseline, which PR runs start from: one missing a shard
// would send PRs to re-test its files, or score them on nothing. A partial
// sweep's score is still shown, for information, and fails the run.
//
// Usage (in the app's checkout, or APP_ROOT):
//   node sweep.mjs plan [results]
//     Splits into `sweep.shards` shards, weighed by [results] (main's last
//     reports/stryker-incremental.json) when it can be read. Prints the
//     split; writes the outputs `matrix` (one entry per shard, its files
//     comma-joined as `mutate`) and `count`, and the table to the summary.
//   node sweep.mjs config <out>
//     Writes the Stryker config to <out> with no break threshold: a shard's
//     score is one part's, and only the merge judges.
//   node sweep.mjs merge <dir> <count> <out>
//     Merges the shards' results (one directory per shard in <dir>, each
//     with its stryker-incremental.json) into <out>, written only when all
//     <count> reported. Writes the output `complete` (true/false) and the
//     verdict to the summary; exits 1 when incomplete, empty or failing.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput, summary } from '../lib/actions.mjs';
import { appRoot } from '../lib/app.mjs';
import { judge } from './gate.mjs';
import { allMutants, counts, parseReport, readText, relativeName } from './report.mjs';
import { gitIn, inMutateScope } from './scope.mjs';
import { breakThreshold, readSettings, readStrykerConfig } from './settings.mjs';

/**
 * @typedef {import('./report.mjs').Report} Report
 * @typedef {import('./report.mjs').Mutant} Mutant
 * @typedef {import('./report.mjs').Test} Test
 * @typedef {import('./report.mjs').Counts} Counts
 * @typedef {{ files: string[], weight: number }} Shard
 */

/**
 * What testing one mutant took: one run, plus each test covering it.
 *
 * @param {Mutant} mutant
 */
export function mutantWeight(mutant) {
  return mutant.status === 'Ignored' ? 0 : 1 + (mutant.coveredBy?.length ?? 0);
}

/**
 * Each file's weight in a set of results, by cwd-relative name.
 *
 * @param {Report} report
 * @param {string} cwd
 * @returns {Map<string, number>}
 */
export function reportWeights(report, cwd) {
  /** @type {Map<string, number>} */
  const weights = new Map();
  for (const [name, file] of Object.entries(report.files ?? {})) {
    const weight = (file.mutants ?? []).reduce((sum, m) => sum + mutantWeight(m), 0);
    weights.set(relativeName(name, cwd), weight);
  }
  return weights;
}

/**
 * Each file's weight: its weight in `known` when there is one, else its line
 * count at the weight per line of the files `known` has (1 with none).
 *
 * @param {string[]} files
 * @param {(file: string) => number} lines
 * @param {Map<string, number>} known
 * @returns {Map<string, number>}
 */
export function fileWeights(files, lines, known) {
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
 *
 * @param {Map<string, number>} weights
 * @param {number} count
 * @returns {Shard[]}
 */
export function splitShards(weights, count) {
  const weightOf = (/** @type {string} */ file) => weights.get(file) ?? 0;
  const order = [...weights.keys()].sort((a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : 1));
  /** @type {Shard[]} */
  const shards = Array.from({ length: Math.min(count, order.length) }, () => ({
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
 *
 * @param {{ tracked: string[], mutate: string[], results: Report | null,
 *   lines: (file: string) => number, count: number, cwd: string }} args
 */
export function plan({ tracked, mutate, results, lines, count, cwd }) {
  const files = tracked.filter((file) => inMutateScope(file, mutate)).sort();
  const known = results ? reportWeights(results, cwd) : new Map();
  return {
    shards: splitShards(fileWeights(files, lines, known), count),
    fromResults: known.size > 0,
  };
}

/**
 * A GitHub Actions job matrix with one entry per shard.
 *
 * @param {Shard[]} shards
 */
export function shardMatrix(shards) {
  return { include: shards.map(({ files }, i) => ({ shard: i + 1, mutate: files.join(',') })) };
}

/**
 * The split as a Markdown table.
 *
 * @param {Shard[]} shards
 * @param {boolean} fromResults
 */
export function shardTable(shards, fromResults) {
  const unit = fromResults ? 'mutants plus covering tests, last results' : 'lines';
  const rows = shards.map(({ files, weight }, i) => `| ${i + 1} | ${files.length} | ${weight} |`);
  return [`| Shard | Files | Weight (${unit}) |`, '| --- | --- | --- |', ...rows, ''].join('\n');
}

/**
 * The Stryker config for one shard: no break threshold.
 *
 * @param {Record<string, unknown>} config
 */
export function shardConfig(config) {
  const thresholds =
    typeof config.thresholds === 'object' && config.thresholds !== null ? config.thresholds : {};
  return { ...config, thresholds: { ...thresholds, break: null } };
}

/**
 * The key Stryker's incremental mode knows a test by across runs.
 *
 * @param {string} fileName
 * @param {Test} test
 * @param {string} cwd
 */
export function testKey(fileName, test, cwd) {
  const start = test.location?.start;
  return `${relativeName(fileName, cwd)}@${start?.line ?? 0}:${start?.column ?? 0}\n${test.name}`;
}

/**
 * The shards' results as one, tests numbered once across them, with the
 * config's whole scope and thresholds. Throws on a file in two shards.
 *
 * @param {Report[]} reports
 * @param {{ mutate: string[], thresholds: Record<string, unknown> }} config
 * @param {string} cwd
 * @returns {Report}
 */
export function mergeReports(reports, config, cwd) {
  /** @type {NonNullable<Report['files']>} */
  const files = {};
  /** @type {NonNullable<Report['testFiles']>} */
  const testFiles = {};
  const seen = new Set();
  /** @type {Map<string, string>} */
  const ids = new Map();
  for (const report of reports) {
    /** @type {Map<string, string>} */
    const local = new Map();
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
    const renumber = (/** @type {string[] | undefined} */ list) =>
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
 *
 * @param {{ found: number, expected: number, counts: Counts, breakAt: number | null,
 *   perFile?: { pass: boolean, lines: string[] } | null }} args
 */
export function verdict({ found, expected, counts: c, breakAt, perFile = null }) {
  const complete = found === expected;
  const score = c.score === null ? 'none' : `${c.score.toFixed(2)}%`;
  const lines = [
    `### Mutation sweep${complete ? '' : ' (incomplete)'}`,
    '',
    `Shards reported: ${found} of ${expected}.`,
    '',
    '| Score | Break | Killed | Timeout | Survived | No coverage | Errors | Ignored |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    `| ${score} | ${breakAt ?? 'none'} | ${c.killed} | ${c.timeout} | ${c.survived} | ${c.noCoverage} | ${c.errors} | ${c.ignored} |`,
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
    lines.push('No mutant was tested.');
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
 *
 * @param {string} dir
 */
function shardDirs(dir) {
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
 *
 * @param {string} file
 * @param {string} text
 */
function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** @param {string | undefined} text */
const positive = (text) => {
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const USAGE = 'Usage: sweep.mjs plan [results] | config <out> | merge <dir> <count> <out>';

/**
 * The command line. Returns the exit code.
 *
 * @param {string[]} args
 * @param {string} [root]
 */
export function main(args, root = appRoot()) {
  const [command, ...rest] = args;
  const settings = readSettings(root);
  const config = readStrykerConfig(settings, root);
  const at = (/** @type {string} */ file) => path.resolve(root, file);
  if (command === 'plan') {
    const tracked = gitIn(root)('ls-files', '-z').split('\0').filter(Boolean);
    const { shards, fromResults } = plan({
      tracked,
      mutate: config.mutate,
      results: rest[0] ? parseReport(readText(at(rest[0]))) : null,
      lines: (file) => (readText(at(file)) ?? '').split('\n').length,
      count: settings.sweep.shards,
      cwd: root,
    });
    const table = shardTable(shards, fromResults);
    console.log(table);
    for (const [i, { files }] of shards.entries())
      console.log(`Shard ${i + 1}: ${files.join(', ')}`);
    setOutput('matrix', JSON.stringify(shardMatrix(shards)));
    setOutput('count', String(shards.length));
    summary(`### Mutation sweep shards\n\n${table}`);
    return 0;
  }
  if (command === 'config' && rest[0]) {
    write(at(rest[0]), `${JSON.stringify(shardConfig(config.raw), null, 2)}\n`);
    return 0;
  }
  const expected = positive(rest[1]);
  if (command === 'merge' && rest[0] && expected !== null && rest[2]) {
    /** @type {Report[]} */
    const reports = [];
    for (const shard of shardDirs(at(rest[0]))) {
      const report = parseReport(
        readText(path.join(at(rest[0]), shard, 'stryker-incremental.json')),
      );
      if (report) reports.push(report);
      else console.error(`No readable results from ${shard}.`);
    }
    const merged = mergeReports(reports, config, root);
    const threshold = settings.perFileThreshold;
    const result = verdict({
      found: reports.length,
      expected,
      counts: counts(allMutants(merged)),
      breakAt: breakThreshold(config),
      perFile: threshold === null ? null : judge(merged, null, threshold, root),
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
