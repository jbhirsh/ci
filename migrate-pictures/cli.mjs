// Moves an app's old PR pictures off its picture branch (`screenshots`, and
// the legacy `pr-screenshots/*`) to GitHub attachments, and rewrites every
// link to them, so the branch can be deleted (ci#33). Run by this
// directory's action (action.yml), from each app's throwaway
// migrate-pictures branch, a step or several a run, the state carried
// between runs as an artifact; or locally,
// read-only steps only, for a dry run:
//
//   node migrate-pictures/cli.mjs <step> --repo <owner/name> --state <dir>
//     [--repos <owner/name,…>]   whose posts to read (default: the app's and
//                                the other jbhirsh/ci repos', since ci's
//                                issues show app pictures)
//     [--branch screenshots] [--legacy pr-screenshots]
//     [--host <PR>]              upload: the PR whose description takes the
//                                attachments (plan: named in the report)
//     [--include-others]         plan: also rewrite posts by people other
//                                than the owner and bots
//     [--minutes <n>]            stop starting writes after this long (300)
//
// Steps, in order: inventory, plan, upload, rewrite, verify; undo puts the
// rewritten posts back. steps.mjs's header says what each reads and writes.
// The token is GH_TOKEN (the app's BOT_PR_TOKEN in the workflow: Contents
// and Pull requests write, plus Issues write for issue bodies and
// comments); without one, requests go unauthenticated, as a local run
// behind a proxy that signs them does.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { client, pacer, realClock } from './github.mjs';
import { inventory, plan, rewrite, undo, upload, verify } from './steps.mjs';

/** The repos whose posts are read by default: every repo sharing this CI. */
export const ALL_REPOS = [
  'jbhirsh/BoardGames',
  'jbhirsh/fog-and-frontier',
  'jbhirsh/sift',
  'jbhirsh/ci',
];

const STEPS = ['inventory', 'plan', 'upload', 'rewrite', 'verify', 'undo'];
const REPO = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^[\w.-]+$/;

/**
 * @typedef {object} Args
 * @property {string} step
 * @property {string} repo
 * @property {string} state
 * @property {string[]} repos
 * @property {string} branch
 * @property {string} legacy
 * @property {number | null} host
 * @property {boolean} includeOthers
 * @property {number} minutes
 */

/**
 * The command line, checked.
 *
 * @param {readonly string[]} argv
 * @returns {Args}
 */
export function parseArgs(argv) {
  const [step, ...rest] = argv;
  if (!STEPS.includes(step))
    throw new Error(
      `usage: node migrate-pictures/cli.mjs ${STEPS.join(' | ')} --repo <owner/name> --state <dir> …`,
    );
  /** @type {Record<string, string | true>} */
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!flag.startsWith('--')) throw new Error(`migrate-pictures: unexpected "${flag}"`);
    if (flag === '--include-others') flags['include-others'] = true;
    else {
      const value = rest[++i];
      if (value === undefined) throw new Error(`migrate-pictures: ${flag} needs a value`);
      flags[flag.slice(2)] = value;
    }
  }
  /** @param {string} name */
  const text = (name) => {
    const value = flags[name];
    return typeof value === 'string' ? value : '';
  };
  const known = ['repo', 'state', 'repos', 'branch', 'legacy', 'host', 'include-others', 'minutes'];
  for (const name of Object.keys(flags))
    if (!known.includes(name)) throw new Error(`migrate-pictures: unknown --${name}`);
  const repo = text('repo');
  if (!REPO.test(repo)) throw new Error(`migrate-pictures: --repo is owner/name, not "${repo}"`);
  const state = text('state');
  if (!state) throw new Error('migrate-pictures: --state names the state folder');
  const repos = text('repos')
    ? text('repos')
        .split(/[\s,]+/)
        .filter(Boolean)
    : [...ALL_REPOS];
  for (const r of repos)
    if (!REPO.test(r)) throw new Error(`migrate-pictures: "${r}" in --repos isn't owner/name`);
  if (!repos.some((r) => r.toLowerCase() === repo.toLowerCase())) repos.unshift(repo);
  const branch = text('branch') || 'screenshots';
  const legacy = text('legacy') || 'pr-screenshots';
  for (const name of [branch, legacy])
    if (!BRANCH.test(name)) throw new Error(`migrate-pictures: "${name}" isn't a branch name`);
  const hostText = text('host');
  if (hostText && !/^[1-9]\d*$/.test(hostText))
    throw new Error(`migrate-pictures: --host is a PR number, not "${hostText}"`);
  const host = hostText ? Number(hostText) : null;
  if (step === 'upload' && host === null)
    throw new Error(
      'migrate-pictures: upload needs --host, the PR whose description takes the attachments',
    );
  const minutes = Number(text('minutes') || 300);
  if (!(minutes > 0)) throw new Error('migrate-pictures: --minutes is a number of minutes');
  return {
    step,
    repo,
    state,
    repos,
    branch,
    legacy,
    host,
    includeOthers: flags['include-others'] === true,
    minutes,
  };
}

/**
 * Runs one step; returns its exit code.
 *
 * @param {readonly string[]} argv
 * @param {{ env?: Record<string, string | undefined>; log?: (line: string) => void; fetch?: typeof globalThis.fetch; clock?: import('./github.mjs').Clock; gh?: (args: string[], cwd: string) => void; remote?: string }} [context]
 *   fetch, clock, gh, remote: for tests (steps.mjs's Context)
 */
export async function main(argv, context = {}) {
  const { env = process.env, log = console.log, clock = realClock } = context;
  const args = parseArgs(argv);
  const { step } = args;
  // Absolute, as git runs in scratch folders and reads paths from there.
  const state = path.resolve(args.state);
  mkdirSync(state, { recursive: true });
  const metaFile = path.join(state, 'meta.json');
  if (step === 'inventory' && existsSync(path.join(state, 'inventory.json'))) {
    throw new Error(
      'migrate-pictures: this state already has an inventory: start inventory with no from-run',
    );
  }
  if (step !== 'inventory' && !existsSync(metaFile)) {
    throw new Error(
      `migrate-pictures: ${step} continues a migration: pass the run before it as from-run (no meta.json in the state)`,
    );
  }
  /** @type {{ repo: string; repos: string[]; branch: string; legacy: string; runs: { step: string; run: string; at: string }[] }} */
  const meta =
    step === 'inventory'
      ? { repo: args.repo, repos: args.repos, branch: args.branch, legacy: args.legacy, runs: [] }
      : JSON.parse(readFileSync(metaFile, 'utf8'));
  if (meta.repo.toLowerCase() !== args.repo.toLowerCase()) {
    throw new Error(`migrate-pictures: this state is ${meta.repo}'s, not ${args.repo}'s`);
  }
  const deadline = clock.now() + args.minutes * 60_000;
  const token = env.GH_TOKEN || undefined;
  // The writes the runs before made, so GitHub's hourly limit holds across runs.
  const writesFile = path.join(state, 'writes.json');
  const history = existsSync(writesFile) ? JSON.parse(readFileSync(writesFile, 'utf8')) : undefined;
  const pace = pacer({ clock, deadline, history });
  const api = client({ token, fetch: context.fetch, clock, log, pace, deadline });
  /** @type {import('./steps.mjs').Context} */
  const ctx = {
    state,
    api,
    log,
    token,
    clock,
    gh: context.gh,
    fetch: context.fetch,
    remote: context.remote,
  };
  meta.runs.push({
    step,
    run: env.GITHUB_RUN_ID ?? 'local',
    at: new Date(clock.now()).toISOString(),
  });
  writeFileSync(metaFile, `${JSON.stringify(meta, null, 1)}\n`);
  let code = 0;
  try {
    if (step === 'inventory') await inventory(ctx, meta);
    else if (step === 'plan') plan(ctx, { host: args.host, includeOthers: args.includeOthers });
    else if (step === 'upload')
      code = await upload(ctx, { host: /** @type {number} */ (args.host) });
    else if (step === 'rewrite') code = await rewrite(ctx);
    else if (step === 'verify') code = await verify(ctx);
    else code = await undo(ctx);
  } finally {
    writeFileSync(writesFile, `${JSON.stringify(pace.history())}\n`);
  }
  const report = { plan: 'plan.md', rewrite: 'rewrite.md', verify: 'verify.md', undo: 'undo.md' }[
    step
  ];
  if (report && env.GITHUB_STEP_SUMMARY && existsSync(path.join(state, report))) {
    // A step summary holds at most 1 MiB; the whole report is in the artifact.
    const text = readFileSync(path.join(state, report), 'utf8');
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      text.length > 900_000
        ? `${text.slice(0, 900_000)}\n\n…cut: the whole report is ${report} in the artifact.\n`
        : text,
    );
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (/** @type {unknown} */ error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
