// One weekly-audit check, run from the app's checkout (audit/action.yml):
//
//   node run.ts knip [--dry-run]                    dead code
//   node run.ts jscpd [--dry-run]                   duplicated code
//   node run.ts lychee <report.json> <exit code> [--dry-run]
//                                                    broken links, from the
//                                                    report lychee-action wrote
//   node run.ts graph <out dir>                     the architecture graph
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
// its installed version, turns the report into findings (audit/report.ts),
// writes them to the job summary, sets the `findings` output to their count,
// and keeps the category's tracking issue (audit/issue.ts). jscpd runs as
// the app's `jscpd` package script, which must be bare `jscpd` (its settings
// are .jscpd.json): the command anyone runs locally, and what tells knip the
// package is used. Findings never fail the run; a tool that breaks does:
// knip exiting above 1, jscpd writing no report (or the app having no
// `jscpd` script), lychee exiting other than 0 or 2 (2 is broken links).
// So does a knip suppression (audit/suppressions.ts: an `ignore*` option,
// a loosened rule, an `@public` tag, …): the knip check lists them at the
// top of the Dead code issue, counted with the findings, syncs the issue,
// then fails, so a suppression the PR-time step missed still turns the run
// red.
// `--dry-run` leaves the issue alone, for a local run or a self-test.
// The issue needs GH_TOKEN (issues write); the run's link comes from
// GITHUB_SERVER_URL, GITHUB_REPOSITORY and GITHUB_RUN_ID.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput, summary } from '../lib/actions.ts';
import { appConfig, appRoot } from '../lib/app.ts';
import { sync } from './issue.ts';
import { jscpdFindings, knipFindings, lycheeFindings } from './report.ts';
import { KNIP_CONFIG_LOCATIONS, suppressions, suppressionsMessage } from './suppressions.ts';
import type { Findings } from './report.ts';
import type { Suppression } from './suppressions.ts';
import type { Gh } from './issue.ts';

/** Each check's tracking issue. */
export const TITLES = {
  knip: 'Dead code (weekly audit)',
  jscpd: 'Duplicated code (weekly audit)',
  lychee: 'Broken links (weekly audit)',
} as const;

/**
 * The app's knip config file, for the findings' advice.
 */
export function knipConfig(root: string) {
  return KNIP_CONFIG_LOCATIONS.find((name) => existsSync(path.join(root, name))) ?? 'knip’s config';
}

/**
 * The app's `audit` settings, checked, with the defaults filled in.
 */
export function settings(config: Record<string, unknown>): { graph: string[] } {
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

export type Spawn = (
  command: string,
  args: string[],
  cwd: string,
  input?: string,
) => { status: number | null; stdout: string; stderr: string };

export const spawn: Spawn = (command, args, cwd, input) => {
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
 */
export function runKnip(root: string, run: Spawn): unknown {
  const result = run('npx', ['--no-install', 'knip', '--reporter', 'json', '--no-progress'], root);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`knip failed (exit ${result.status}): ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * Runs the app's `jscpd` script (its .jscpd.json), its JSON report written
 * where this reads it, and returns the report. Some apps' configs exit
 * non-zero on clones, so it's the missing report that says jscpd broke.
 */
export function runJscpd(root: string, run: Spawn): unknown {
  const pkg: unknown = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const scripts = (pkg as { scripts?: Record<string, unknown> }).scripts;
  if (scripts?.jscpd !== 'jscpd') {
    throw new Error(
      'package.json needs the script `"jscpd": "jscpd"`: the audit runs jscpd through it (its settings stay in .jscpd.json)',
    );
  }
  const out = mkdtempSync(path.join(tmpdir(), 'jscpd-'));
  try {
    const result = run(
      'npm',
      ['run', '--silent', 'jscpd', '--', '--reporters', 'json', '--output', out, '--silent'],
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
 */
export function drawGraph(root: string, folders: string[], out: string, run: Spawn) {
  const ok = (result: ReturnType<Spawn>, what: string) => {
    if (result.status !== 0)
      throw new Error(`${what} failed (exit ${result.status}): ${result.stderr.trim()}`);
    return result.stdout;
  };
  const cruise = (type: string) =>
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

export type Deps = {
  /** the app's checkout */
  root: string;
  env: Record<string, string | undefined>;
  spawn: Spawn;
  gh: Gh;
  summary: (markdown: string) => void;
  setOutput: (name: string, value: string) => void;
  now: Date;
};

function defaultDeps(): Deps {
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
 */
export function main(argv: string[], deps: Deps = defaultDeps()) {
  const dryRun = argv.includes('--dry-run');
  const [check, ...rest] = argv.filter((arg) => arg !== '--dry-run');
  if (check === 'graph') {
    const [out] = rest;
    if (!out) throw new Error('graph <out dir>');
    const { graph } = settings(appConfig('audit', deps.root));
    const files = drawGraph(deps.root, graph, path.resolve(out), deps.spawn);
    return `Architecture graph of ${graph.join(', ')}: ${files.join(', ')}.`;
  }
  let findings: Findings;
  let refused: string | undefined;
  if (check === 'knip') {
    // A config the scan can't read (a knip.ts) fails the run too, and heads
    // the issue as one suppression would, but only once the issue shows
    // this week's findings.
    let hidden: { config: string; list: Suppression[] } = {
      config: knipConfig(deps.root),
      list: [],
    };
    try {
      hidden = suppressions(deps.root);
    } catch (error) {
      refused = (error as Error).message;
    }
    findings = knipFindings(runKnip(deps.root, deps.spawn), hidden.config);
    if (hidden.list.length > 0) refused = suppressionsMessage(hidden);
    if (refused) {
      const count = Math.max(1, hidden.list.length);
      const top = `### Suppressions (${count})\n\n${refused}`;
      findings = {
        count: findings.count + count,
        markdown: [top, findings.markdown].filter(Boolean).join('\n\n'),
      };
    }
  } else if (check === 'jscpd') {
    findings = jscpdFindings(runJscpd(deps.root, deps.spawn), deps.root);
  } else if (check === 'lychee') {
    const [report, exitCode] = rest;
    if (!report || exitCode === undefined) throw new Error('lychee <report.json> <exit code>');
    if (exitCode !== '0' && exitCode !== '2') throw new Error(`lychee failed (exit ${exitCode})`);
    const parsed: unknown = JSON.parse(readFileSync(report, 'utf8'));
    // lychee lists broken links under error_map (fail_map once). A report
    // with neither changed shape: fail, rather than read it as a clean sweep.
    // (Exit 2 alone isn't the sign: an unknown status, LinkedIn's 999, exits
    // 2 with an empty error_map.)
    const r = typeof parsed === 'object' && parsed !== null ? parsed : {};
    if (!('error_map' in r) && !('fail_map' in r)) {
      throw new Error("lychee's report has no error_map: update lycheeFindings to its format");
    }
    findings = lycheeFindings(parsed);
  } else {
    throw new Error(
      'usage: run.ts knip|jscpd [--dry-run] | lychee <report.json> <exit code> [--dry-run] | graph <out dir>',
    );
  }
  const title = TITLES[check];
  deps.summary(`## ${title}\n\n${findings.markdown || 'Nothing found.'}`);
  deps.setOutput('findings', String(findings.count));
  let done = `${title}: ${findings.count} found (dry run, issue left alone).`;
  if (!dryRun) {
    const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = deps.env;
    const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
    done = sync(
      { title, findings: findings.markdown, runUrl, date: deps.now.toISOString().slice(0, 10) },
      deps.gh,
    );
  }
  if (refused) throw new Error(refused);
  return done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(main(process.argv.slice(2)));
}
