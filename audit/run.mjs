// One weekly-audit check, run from the app's checkout (audit/action.yml):
//
//   node run.mjs knip [--dry-run]                    dead code
//   node run.mjs jscpd [--dry-run]                   duplicated code
//   node run.mjs lychee <report.json> <exit code> [--dry-run]
//                                                    broken links, from the
//                                                    report lychee-action wrote
//   node run.mjs graph <out dir>                     the architecture graph
//
// The graph is dependency-cruiser's picture of the import graph, by folder
// (architecture.svg) and by module (modules.svg, both drawn by Graphviz's
// `dot`), and its HTML report (report.html), from the app's own
// .dependency-cruiser.cjs, whose rules already gate every PR; the action
// uploads it as the `architecture-graph` artifact. It opens no issue.
//
// Settings, `audit` in the app's .github/ci.json:
//   graph  the folders dependency-cruiser draws (default ["src"])
//
// It runs the tool with the app's own config (knip.json or knip.jsonc,
// .jscpd.json, .lycheeignore: what each looks at stays the app's choice) and
// its installed version, turns the report into findings (audit/report.mjs),
// writes them to the job summary, sets the `findings` output to their count,
// and keeps the category's tracking issue (audit/issue.mjs). Findings never
// fail the run; a tool that breaks does: knip exiting above 1, jscpd writing
// no report, lychee exiting other than 0 or 2 (2 is broken links).
// `--dry-run` leaves the issue alone, for a local run or a self-test.
// The issue needs GH_TOKEN (issues write); the run's link comes from
// GITHUB_SERVER_URL, GITHUB_REPOSITORY and GITHUB_RUN_ID.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput, summary } from '../lib/actions.mjs';
import { appConfig, appRoot } from '../lib/app.mjs';
import { sync } from './issue.mjs';
import { jscpdFindings, knipFindings, lycheeFindings } from './report.mjs';

/** Each check's tracking issue. */
export const TITLES = /** @type {const} */ ({
  knip: 'Dead code (weekly audit)',
  jscpd: 'Duplicated code (weekly audit)',
  lychee: 'Broken links (weekly audit)',
});

/** The config files knip reads, in the order it looks for them. */
const KNIP_CONFIGS = [
  'knip.json',
  'knip.jsonc',
  '.knip.json',
  '.knip.jsonc',
  'knip.config.ts',
  'knip.ts',
];

/**
 * The app's knip config file, for the findings' advice.
 *
 * @param {string} root
 */
export function knipConfig(root) {
  return KNIP_CONFIGS.find((name) => existsSync(path.join(root, name))) ?? 'knip’s config';
}

/**
 * The app's `audit` settings, checked, with the defaults filled in.
 *
 * @param {Record<string, unknown>} config
 * @returns {{ graph: string[] }}
 */
export function settings(config) {
  const { graph = ['src'] } = config;
  if (
    !Array.isArray(graph) ||
    graph.length === 0 ||
    !graph.every((p) => typeof p === 'string' && p !== '' && !p.startsWith('-'))
  ) {
    throw new Error('.github/ci.json: audit.graph must be a list of folders');
  }
  return { graph };
}

/**
 * @typedef {(command: string, args: string[], cwd: string, input?: string) => { status: number | null, stdout: string, stderr: string }} Spawn
 */

/** @type {Spawn} */
export const spawn = (command, args, cwd, input) => {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/**
 * Runs knip and returns its JSON report. Exit 1 means findings; anything
 * above, that knip broke.
 *
 * @param {string} root
 * @param {Spawn} run
 * @returns {unknown}
 */
export function runKnip(root, run) {
  const result = run('npx', ['--no-install', 'knip', '--reporter', 'json', '--no-progress'], root);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`knip failed (exit ${result.status}): ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * Runs jscpd with the app's .jscpd.json, but its JSON report written where
 * this reads it, and returns the report. Some apps' configs exit non-zero on
 * clones, so it's the missing report that says jscpd broke.
 *
 * @param {string} root
 * @param {Spawn} run
 * @returns {unknown}
 */
export function runJscpd(root, run) {
  const out = mkdtempSync(path.join(tmpdir(), 'jscpd-'));
  try {
    const result = run(
      'npx',
      ['--no-install', 'jscpd', '--reporters', 'json', '--output', out, '--silent'],
      root,
    );
    const file = path.join(out, 'jscpd-report.json');
    if (!existsSync(file)) {
      throw new Error(`jscpd wrote no report (exit ${result.status}): ${result.stderr.trim()}`);
    }
    return JSON.parse(readFileSync(file, 'utf8'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * Draws the architecture graph into `out`.
 *
 * @param {string} root
 * @param {string[]} folders
 * @param {string} out
 * @param {Spawn} run
 */
export function drawGraph(root, folders, out, run) {
  const ok = (/** @type {ReturnType<Spawn>} */ result, /** @type {string} */ what) => {
    if (result.status !== 0)
      throw new Error(`${what} failed (exit ${result.status}): ${result.stderr.trim()}`);
    return result.stdout;
  };
  const cruise = (/** @type {string} */ type) =>
    ok(
      run('npx', ['--no-install', 'depcruise', ...folders, '--output-type', type], root),
      `depcruise ${type}`,
    );
  mkdirSync(out, { recursive: true });
  for (const [type, file] of [
    ['archi', 'architecture.svg'],
    ['dot', 'modules.svg'],
  ]) {
    writeFileSync(path.join(out, file), ok(run('dot', ['-Tsvg'], root, cruise(type)), 'dot'));
  }
  writeFileSync(path.join(out, 'report.html'), cruise('html'));
  return ['architecture.svg', 'modules.svg', 'report.html'];
}

/**
 * @typedef {object} Deps
 * @property {string} root the app's checkout
 * @property {Record<string, string | undefined>} env
 * @property {Spawn} spawn
 * @property {import('./issue.mjs').Gh} gh
 * @property {(markdown: string) => void} summary
 * @property {(name: string, value: string) => void} setOutput
 * @property {Date} now
 */

/** @returns {Deps} */
function defaultDeps() {
  return {
    root: appRoot(),
    env: process.env,
    spawn,
    gh: (args, input) => execFileSync('gh', args, { encoding: 'utf8', input }),
    summary,
    setOutput,
    now: new Date(),
  };
}

/**
 * Runs one check and returns what it did with the issue.
 *
 * @param {string[]} argv
 * @param {Deps} [deps]
 */
export function main(argv, deps = defaultDeps()) {
  const dryRun = argv.includes('--dry-run');
  const [check, ...rest] = argv.filter((arg) => arg !== '--dry-run');
  if (check === 'graph') {
    const [out] = rest;
    if (!out) throw new Error('graph <out dir>');
    const { graph } = settings(appConfig('audit', deps.root));
    const files = drawGraph(deps.root, graph, path.resolve(out), deps.spawn);
    return `Architecture graph of ${graph.join(', ')}: ${files.join(', ')}.`;
  }
  /** @type {import('./report.mjs').Findings} */
  let findings;
  if (check === 'knip') {
    findings = knipFindings(runKnip(deps.root, deps.spawn), knipConfig(deps.root));
  } else if (check === 'jscpd') {
    findings = jscpdFindings(runJscpd(deps.root, deps.spawn), deps.root);
  } else if (check === 'lychee') {
    const [report, exitCode] = rest;
    if (!report || exitCode === undefined) throw new Error('lychee <report.json> <exit code>');
    if (exitCode !== '0' && exitCode !== '2') throw new Error(`lychee failed (exit ${exitCode})`);
    findings = lycheeFindings(JSON.parse(readFileSync(report, 'utf8')));
  } else {
    throw new Error(
      'usage: run.mjs knip|jscpd [--dry-run] | lychee <report.json> <exit code> [--dry-run] | graph <out dir>',
    );
  }
  const title = TITLES[check];
  deps.summary(`## ${title}\n\n${findings.markdown || 'Nothing found.'}`);
  deps.setOutput('findings', String(findings.count));
  if (dryRun) return `${title}: ${findings.count} found (dry run, issue left alone).`;
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = deps.env;
  const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  return sync(
    { title, findings: findings.markdown, runUrl, date: deps.now.toISOString().slice(0, 10) },
    deps.gh,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(main(process.argv.slice(2)));
}
