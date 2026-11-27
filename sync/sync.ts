// The sync (ci#109): keeps each app's copies of the files in
// sync/manifest.json byte-identical to their source here, through one PR per
// app from `bot/sync-files` that merges itself once the app's required checks
// pass. .github/workflows/sync-files.yml runs it for each app after this
// repo's CI passes on main, or by hand, in two jobs:
//
//   node sync/sync.ts check     (both jobs) refuses before anything reaches an
//                                app: an empty BOT_PR_TOKEN, or a ci commit whose
//                                CI didn't pass; skips one that isn't main's head,
//                                or isn't the checkout (main) the job runs
//   node sync/sync.ts prepare   (sync/prepare: no token, the only place an
//                                app's code runs) writes the app's ci.json for
//                                each file that adds a companion, formatted by
//                                the app's own Prettier (installed only then),
//                                into prepared.json, the next job's artifact
//   node sync/sync.ts publish   (sync, BOT_PR_TOKEN, no app code) opens,
//                                rebuilds, leaves or closes the PR, then fails
//                                naming whatever keeps it from merging
//   node sync/sync.ts dry-run <app> <app dir>
//                                prints the PR the sync would open for that
//                                checkout, from this checkout's manifest; reads
//                                nothing else and writes nothing
//
// What publish does, every run, for one app:
//   1. Reads the app's main as it is now, by git (a shallow, blobless fetch:
//      the apps are hundreds of MB), and works out which files differ
//      (plan.ts). The template is checked first (its shape), and a bad one
//      is refused before anything is pushed. The workflows it writes are
//      linted by this repo's CI (sync/content.test.ts), which must have
//      passed on the commit: that lint reads YAML, and the sync imports no
//      package, so its jobs install none. prepared.json is data: only its
//      ci.json texts are used, each held to the guard, and only when its
//      commit is still main's head.
//   2. Finds the open sync PR (into main, from the app's own bot/sync-files,
//      its description carrying plan.ts's MARKER; one from that branch
//      without it is a person's, and the run refuses it) and decides
//      (plan.ts's decide): nothing differs and none is open, nothing to do
//      but delete a stale branch; nothing differs any more, close it with a
//      comment and delete the branch; its branch already holds these bytes
//      and can merge, leave it (rebuilding would rerun every check: sift's
//      take an hour); otherwise rebuild it. A branch behind main where the
//      app requires an up-to-date one, or in conflict with main, is rebuilt
//      from main's head, which ends both: a conflict therefore never
//      outlives a run to be reported.
//   3. A rebuild turns auto-merge off first, then makes one commit per file
//      on the app's head (with the file's companions in the same commit), with
//      git's plumbing and no work tree, and force-pushes the branch, leased to
//      the head it read. Never a merge commit: the apps' commit check refuses
//      them. A synced path that is a link or a submodule in the app is
//      refused. A push GitHub refuses for want of the Workflows permission
//      fails naming it, and, being atomic, changes nothing.
//   4. The guard reads what GitHub holds, after a push and on a kept branch
//      alike (the compare and tree APIs): only the manifest's paths (and
//      ci.json, for a companion), each added or modified, never renamed,
//      deleted or a mode change, every one a plain file, each blob
//      byte-identical to its source, and ci.json the app's plus exactly the
//      companion keys (companion.ts's settingsProblems). Only then is the PR
//      opened or its description rewritten, and auto-merge (squash) turned on
//      bound to that head (expectedHeadOid, gh's --match-head-commit), unless
//      the run's auto-merge setting is off, which leaves it for a person. A
//      draft PR is left without auto-merge: making one a draft is how to hold
//      it. If GitHub refuses to open the PR, the pushed branch is deleted
//      again, so the app is as it was.
//   5. Reads the PR's review threads and, when its head is not new, its
//      required checks (the app's branch rules), and fails the run naming
//      each unresolved thread and failed check, or, for a PR GitHub calls
//      blocked with neither, that state and main's rule types. A check still
//      running is no cause. Nothing waits: a PR that is stuck later is
//      reported at the next run (a ci change, or a dispatch). A failure
//      after the push still prints what the run did first.
//
// What it does not do, by decision: a sync PR someone closes is opened
// afresh at the next drift (closing it is no way to stop the sync: make it a
// draft, or dispatch with auto-merge off); a synced file of the app that
// isn't UTF-8 text is refused, not synced.
//
// The token (BOT_PR_TOKEN, ci's Actions secret): a person's fine-grained
// token, since a PR or push the Actions token makes starts no workflow, so
// the app's required checks would never report. It needs, on each app,
// Contents, Pull requests and Workflows read and write, and Checks and
// Commit statuses read. There is no fallback: an empty one fails at once.
// GitHub can't be asked what a fine-grained token may do, so a token that
// may push but not open a PR is found by the refusal, and the branch it
// pushed is deleted again.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ghApi, statusOf } from '../lib/comment.mjs';
import { SETTINGS_FILE } from '../lib/app.mjs';
import { pages } from '../lib/github.mjs';
import { problems as templateProblems } from '../pr-template/structure.ts';
import { addCompanions, formatSettings, settingsProblems } from './companion.ts';
import { APPS, CI_ROOT, loadManifest, resolve } from './manifest.ts';
import {
  BRANCH,
  blobSha,
  MARKER,
  blockers,
  changesFor,
  CI_REPO,
  commitMessage,
  decide,
  PR_TITLE,
  prBody,
  report,
} from './plan.ts';
import type { Companion, Resolved } from './manifest.ts';
import type { Change, Thread } from './plan.ts';
import type { Api } from '../lib/comment.mjs';

export type Graphql = (query: string, variables: Record<string, unknown>) => unknown;
export type Git = (
  args: string[],
  options?: { input?: string | Buffer; env?: Record<string, string> },
) => string;

/** The secret the token comes from, as every refusal names it. */
export const SECRET = 'BOT_PR_TOKEN';
/** The PR template, whose shape is checked before it is synced. */
const TEMPLATE = '.github/pull_request_template.md';
/** The permissions the token needs on each app, as the refusals list them. */
const TOKEN_NEEDS =
  'Contents, Pull requests and Workflows read and write, and Checks and Commit statuses read';
/** The identity the sync's commits are made as. */
const COMMITTER = {
  GIT_AUTHOR_NAME: 'github-actions[bot]',
  GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'github-actions[bot]',
  GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
};
const SHA = /^[0-9a-f]{40}$/;

/**
 * The app a run is for, checked: one of the manifest's apps.
 */
export function appOf(value: string | undefined) {
  if (!value || !APPS.includes(value)) {
    throw new Error(`the app must be one of ${APPS.join(', ')}, not "${value ?? ''}"`);
  }
  return value;
}

/**
 * A commit SHA from the environment, checked.
 */
function shaOf(value: string | undefined, name: string) {
  if (!value || !SHA.test(value)) throw new Error(`${name} must be a full commit SHA`);
  return value;
}

/**
 * What is wrong with the files the sync would write, before any is written:
 * the template's shape (structure.ts). The workflows it writes are linted
 * by this repo's CI instead (sync/content.test.ts, with lint/actions.ts),
 * which must have passed on the commit before the sync runs: that lint reads
 * YAML, and the sync imports no package, so its jobs install none.
 */
export function contentProblems(files: Resolved[], ciRoot: string): string[] {
  return files
    .filter((file) => file.path === TEMPLATE)
    .flatMap((file) =>
      templateProblems(readFileSync(path.join(ciRoot, file.source), 'utf8')).map(
        (p) => `${file.source}: ${p}`,
      ),
    );
}

/**
 * An app's settings, from its ci.json's text ('' when it has none).
 */
function settingsOf(text: string): Record<string, unknown> {
  if (text.trim() === '') return {};
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${SETTINGS_FILE} must hold an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * What the sync would change in an app, read through `readApp`, refusing
 * content that fails its checks.
 */
export function planFor({
  app,
  ciRoot,
  readApp,
}: {
  app: string;
  ciRoot: string;
  readApp: (file: string) => Buffer | null;
}) {
  const files = resolve(loadManifest(ciRoot), app);
  const found = contentProblems(files, ciRoot);
  if (found.length > 0) {
    throw new Error(`refusing to sync files that fail their checks:\n  - ${found.join('\n  - ')}`);
  }
  const settingsText = readApp(SETTINGS_FILE)?.toString('utf8') ?? '';
  const changes = changesFor(
    files,
    (source) => readFileSync(path.join(ciRoot, source)),
    readApp,
    settingsOf(settingsText),
  );
  return { changes, settingsText };
}

/**
 * The app's ci.json after each change that adds companions, by the change's
 * path, the companions accumulating in commit order.
 */
export async function settingsAfter(
  changes: Change[],
  settingsText: string,
  format: (text: string) => Promise<string> | string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let text = settingsText;
  for (const change of changes) {
    if (change.companions.length === 0) continue;
    text = await format(addCompanions(text, change.companions));
    out[change.path] = text;
  }
  return out;
}

// ---------------------------------------------------------------- check

/**
 * The run's first step: refuses an empty token before any other command, and
 * a ci commit whose CI didn't pass; says to skip a commit that main has moved
 * past (that newer commit's own run syncs it).
 *
 * @param env TOKEN_SET, CI_SHA, and GH_TOKEN (the Actions token, with actions
 *   read here)
 * @param api
 * @param checkedOut the commit this repo's checkout holds:
 *   the workflow checks out main, so it must be CI_SHA, or main has moved on
 */
export function check(
  env: Record<string, string | undefined>,
  api: Api,
  checkedOut: () => string = () => gitIn(CI_ROOT)(['rev-parse', 'HEAD']).trim(),
): { go: boolean; message: string } {
  if (env.TOKEN_SET !== 'true') {
    throw new Error(
      `${SECRET} is empty: add it as an Actions secret of ${CI_REPO}, a fine-grained token on ` +
        `${APPS.map((app) => `jbhirsh/${app}`).join(', ')} with ${TOKEN_NEEDS}. ` +
        'Nothing was changed in any app.',
    );
  }
  const sha = shaOf(env.CI_SHA, 'CI_SHA');
  const head = (api('GET', `repos/${CI_REPO}/commits/main`) as { sha: string }).sha;
  const here = checkedOut();
  if (head !== sha || here !== sha) {
    return {
      go: false,
      message:
        `${CI_REPO}@${sha.slice(0, 7)} is not main's head (${head.slice(0, 7)}; this checkout of main: ` +
        `${here.slice(0, 7)}), so nothing is synced: ` +
        "a run from main's head syncs, after its CI passes or when dispatched on main.",
    };
  }
  const runs = api(
    'GET',
    `repos/${CI_REPO}/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&event=push&status=success&per_page=1`,
  ) as { total_count: number };
  if (!runs || runs.total_count < 1) {
    throw new Error(
      `CI hasn't passed on ${CI_REPO}@${sha.slice(0, 7)} (its push to main): the sync runs only from ` +
        'a commit whose Check and Against jobs passed. Dispatch it again once they have.',
    );
  }
  return { go: true, message: `Syncing from ${CI_REPO}@${sha.slice(0, 7)}, whose CI passed.` };
}

// -------------------------------------------------------------- prepare

/**
 * A reader of an app's checkout on disk, refusing a file that isn't UTF-8
 * text (publish, reading git's text, would see it lossily).
 */
function diskReader(root: string, app: string): (file: string) => Buffer | null {
  return (file) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path.join(root, file));
    } catch {
      return null;
    }
    if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) throw notText(file, app);
    return bytes;
  };
}

/**
 * The tokenless step: works out the changes from the app's checkout, and for
 * each one that adds companions writes the app's ci.json as it will be,
 * formatted by the app's own Prettier, which it installs (with no install
 * scripts) only then. publish re-reads everything else itself, from git.
 *
 * @param env APP, APP_ROOT, SYNC_OUT
 * @param deps `ciRoot`: this repo's checkout, unless a test brings its own
 * @returns what to print
 */
export async function prepare(
  env: Record<string, string | undefined>,
  {
    install,
    format = formatSettings,
    ciRoot = CI_ROOT,
  }: {
    install: (root: string) => void;
    format?: (text: string, root: string) => Promise<string>;
    ciRoot?: string;
  },
): Promise<string[]> {
  const app = appOf(env.APP);
  const root = path.resolve(env.APP_ROOT ?? '.');
  const out = env.SYNC_OUT;
  if (!out) throw new Error('SYNC_OUT names no folder');
  const readApp = diskReader(root, app);
  const { changes, settingsText } = planFor({
    app,
    ciRoot,
    readApp,
  });
  const appSha = gitIn(root)(['rev-parse', 'HEAD']).trim();
  const needs = changes.some((change) => change.companions.length > 0);
  if (needs) install(root);
  const settings = await settingsAfter(changes, settingsText, (text) => format(text, root));
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'prepared.json'), JSON.stringify({ appSha, settings }));
  return report(app, changes, env.CI_SHA ?? 'HEAD');
}

// -------------------------------------------------------------- publish

/**
 * What prepare left, checked where it enters the step with the token.
 */
export function readPrepared(file: string): { appSha: string; settings: Record<string, string> } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `${file} is missing: the Prepare job for this app failed or was skipped, so its log says why.`,
    );
  }
  const value: unknown = JSON.parse(text);
  const v = value as { appSha?: unknown; settings?: unknown };
  if (typeof value !== 'object' || value === null || typeof v.appSha !== 'string') {
    throw new Error(`${file} is not what prepare writes`);
  }
  const settings = v.settings;
  if (
    typeof settings !== 'object' ||
    settings === null ||
    Array.isArray(settings) ||
    !Object.values(settings).every((text) => typeof text === 'string')
  ) {
    throw new Error(`${file}: settings must map paths to text`);
  }
  return {
    appSha: shaOf(v.appSha, 'prepared.json appSha'),
    settings: settings as Record<string, string>,
  };
}

/** A pull request, as far as the sync reads it. */
export type Pull = {
  number: number;
  node_id: string;
  draft: boolean;
  mergeable_state: string | null;
  auto_merge: unknown;
  head: { sha: string };
};

/**
 * The app's open sync PR, or null: one into main from the app's own
 * bot/sync-files whose description carries the sync's marker. Anyone can
 * push a branch of that name, so an open PR from it without the marker is a
 * person's, and the run refuses rather than force-push it.
 */
function openPull(api: Api, repo: string): Pull | null {
  const [owner] = repo.split('/');
  const list = (
    api('GET', `repos/${repo}/pulls?head=${owner}:${BRANCH}&base=main&state=open&per_page=100`) as {
      number: number;
      body: string | null;
      head: { repo: { full_name: string } | null };
    }[]
  ).filter((pull) => pull.head.repo?.full_name === repo);
  if (list.length === 0) return null;
  const ours = list.find((pull) => pull.body?.includes(MARKER));
  if (!ours) {
    throw new Error(
      `${repo}#${list[0].number} comes from ${BRANCH} but the sync didn't open it (its description lacks ` +
        `${MARKER}): close it, or move its work to another branch, and the next run opens its own.`,
    );
  }
  return api('GET', `repos/${repo}/pulls/${ours.number}`) as Pull;
}

/** A file of a compare, as GitHub lists it. */
export type ComparedFile = {
  filename: string;
  status: string;
  sha: string | null;
  previous_filename?: string;
};

/** A three-dot compare, as far as the sync reads it. */
export type Comparison = {
  ahead_by: number;
  behind_by: number;
  merge_base_commit: { sha: string };
  files?: ComparedFile[];
};

/**
 * The files a branch changes since it left `base` (GitHub's three-dot
 * compare), with their blobs.
 */
function compare(api: Api, repo: string, base: string, head: string): Comparison {
  return api('GET', `repos/${repo}/compare/${base}...${head}`) as Comparison;
}

/**
 * Whether a branch changes exactly these files, to exactly these bytes.
 */
function holdsExactly(
  files: { filename: string; status: string; sha: string | null }[],
  expected: Map<string, Buffer>,
) {
  return (
    files.length === expected.size &&
    files.every(
      (file) =>
        ['added', 'modified'].includes(file.status) &&
        expected.has(file.filename) &&
        file.sha === blobSha(expected.get(file.filename) as Buffer),
    )
  );
}

/**
 * The mode GitHub holds for a path at a commit, or null when it holds none.
 */
function modeAt(api: Api, repo: string, commit: string, file: string) {
  let tree = (api('GET', `repos/${repo}/git/commits/${commit}`) as { tree: { sha: string } }).tree
    .sha;
  const segments = file.split('/');
  for (const [i, segment] of segments.entries()) {
    const { tree: entries } = api('GET', `repos/${repo}/git/trees/${tree}`) as {
      tree: { path: string; mode: string; type: string; sha: string }[];
    };
    const entry = entries.find((e) => e.path === segment);
    if (!entry) return null;
    if (i === segments.length - 1) return entry.mode;
    if (entry.type !== 'tree') return null;
    tree = entry.sha;
  }
  return null;
}

/**
 * The guard: what GitHub holds on the pushed branch is only what the sync
 * meant to write. Returns each problem; [] when there is none.
 */
export function guard({
  api,
  repo,
  base,
  head,
  commits,
  expected,
  settingsBefore,
  companions,
}: {
  api: Api;
  repo: string;
  base: string;
  head: string;
  commits: number;
  expected: Map<string, Buffer>;
  settingsBefore: string;
  companions: Companion[];
}): string[] {
  const { ahead_by: ahead, behind_by: behind, files = [] } = compare(api, repo, base, head);
  const problems: string[] = [];
  if (ahead !== commits || behind !== 0) {
    problems.push(
      `the branch is ${ahead} commit(s) ahead and ${behind} behind its base, not ${commits} and 0`,
    );
  }
  const seen = new Set(files.map((file) => file.filename));
  for (const file of files) {
    const want = expected.get(file.filename);
    if (!want) {
      problems.push(`${file.filename} is not a file the sync writes`);
      continue;
    }
    if (!['added', 'modified'].includes(file.status) || file.previous_filename) {
      problems.push(`${file.filename} is ${file.status}: only an added or modified file is synced`);
    }
    if (file.sha !== blobSha(want))
      problems.push(`${file.filename} is not byte-identical to its source`);
    const now = modeAt(api, repo, head, file.filename);
    const before = file.status === 'added' ? null : modeAt(api, repo, base, file.filename);
    if (now !== (before ?? '100644') || !PLAIN.has(String(now))) {
      problems.push(`${file.filename} has mode ${now}, not ${before ?? '100644'} (a plain file)`);
    }
  }
  for (const file of expected.keys()) {
    if (!seen.has(file)) problems.push(`${file} is missing from the branch`);
  }
  if (expected.has(SETTINGS_FILE)) {
    problems.push(
      ...settingsProblems(
        settingsBefore,
        (expected.get(SETTINGS_FILE) as Buffer).toString('utf8'),
        companions,
      ),
    );
  }
  return problems;
}

/**
 * git in a folder, its output as text; the environment's GIT_* left out, so
 * nothing a hook or a caller set reaches it.
 */
export function gitIn(cwd: string): Git {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return (args, { input, env = {} } = {}) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...base, GIT_TERMINAL_PROMPT: '0', ...env },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    });
}

/**
 * The environment that hands the token to git for github.com, as
 * actions/checkout does, but in this process's children only (nothing on
 * disk).
 */
function tokenEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

/**
 * The text of a failed command, for matching what git said.
 */
const said = (error: unknown) =>
  `${error instanceof Error ? error.message : String(error)}\n${String((error as { stderr?: unknown })?.stderr ?? '')}`;

/**
 * The refusals GitHub gives when a PR could merge now, so auto-merge has
 * nothing to wait for: its merge state is clean, unstable (a check that
 * isn't required failed) or has_hooks. gh's `pr merge --auto` merges such a
 * PR at once for the same three states (its isImmediatelyMergeable).
 */
const MERGEABLE_NOW = /\bis in (clean|unstable|has_hooks) status\b/i;

/**
 * Turns auto-merge on for the PR's verified head, squashing; merges it at
 * once, bound to that head, when GitHub says there is nothing to wait for.
 * Any other refusal fails, naming the PR and what to do.
 */
function autoMerge({
  api,
  graphql,
  repo,
  pull,
  head,
}: {
  api: Api;
  graphql: Graphql;
  repo: string;
  pull: Pull;
  head: string;
}) {
  try {
    graphql(
      `
        mutation ($id: ID!, $head: GitObjectID!) {
          enablePullRequestAutoMerge(
            input: { pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $head }
          ) {
            clientMutationId
          }
        }
      `,
      { id: pull.node_id, head },
    );
    return `auto-merge is on for ${head.slice(0, 7)}`;
  } catch (error) {
    const text = said(error).trim();
    if (!MERGEABLE_NOW.test(text)) {
      throw new Error(
        `GitHub refused to turn auto-merge on for ${repo}#${pull.number} (${text.split('\n')[0]}): ` +
          'merge it by hand once its checks pass, or dispatch the sync again.',
        { cause: error },
      );
    }
    api('PUT', `repos/${repo}/pulls/${pull.number}/merge`, { sha: head, merge_method: 'squash' });
    return `nothing to wait for, so merged ${head.slice(0, 7)}`;
  }
}

/**
 * Turns the PR's auto-merge off: before its branch is pushed, when the guard
 * refuses it, or when this run may not turn it on.
 */
function autoMergeOff(graphql: Graphql, pull: Pull) {
  graphql(
    `
      mutation ($id: ID!) {
        disablePullRequestAutoMerge(input: { pullRequestId: $id }) {
          clientMutationId
        }
      }
    `,
    { id: pull.node_id },
  );
}

/**
 * The PR's review threads.
 */
function threadsOf(graphql: Graphql, repo: string, number: number): Thread[] {
  const [owner, name] = repo.split('/');
  const data = graphql(
    `
      query ($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                isResolved
                path
                line
                comments(first: 1) {
                  nodes {
                    url
                  }
                }
              }
            }
          }
        }
      }
    `,
    { owner, name, number },
  );
  type ThreadNode = {
    isResolved: boolean;
    path: string | null;
    line: number | null;
    comments?: { nodes?: { url: string }[] };
  };
  const answer = data as {
    repository?: { pullRequest?: { reviewThreads?: { nodes?: ThreadNode[] } } };
  } | null;
  return (answer?.repository?.pullRequest?.reviewThreads?.nodes ?? []).map((n) => ({
    isResolved: n.isResolved,
    path: n.path,
    line: n.line,
    url: n.comments?.nodes?.[0]?.url,
  }));
}

/**
 * The app's rules on main: the status checks they require, and the type of
 * every rule, for a PR GitHub calls blocked with nothing else to name.
 */
function rulesOf(api: Api, repo: string): { required: string[]; types: string[] } {
  const rules = pages(api, `repos/${repo}/rules/branches/main`) as {
    type: string;
    parameters?: { required_status_checks?: { context: string }[] };
  }[];
  return {
    required: rules
      .filter((rule) => rule.type === 'required_status_checks')
      .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
      .map((check) => check.context),
    types: [...new Set(rules.map((rule) => rule.type))],
  };
}

/** The modes of a plain file, the only thing the sync writes. */
const PLAIN = new Set(['100644', '100755']);

/**
 * Builds the branch: one commit per change on `base`, with git's plumbing
 * (no work tree, no blob of the app fetched), and pushes it, leased to the
 * head it read. Returns the new head.
 */
function build({
  git,
  base,
  changes,
  settings,
  ciSha,
  oldHead,
  remote,
  token,
  app,
}: {
  git: Git;
  base: string;
  changes: Change[];
  settings: Record<string, string>;
  ciSha: string;
  oldHead: string;
  remote: string;
  token: string;
  app: string;
}) {
  git(['read-tree', base]);
  let parent = base;
  for (const change of changes) {
    const files: [string, Buffer][] = [[change.path, change.bytes]];
    if (settings[change.path] !== undefined) {
      files.push([SETTINGS_FILE, Buffer.from(settings[change.path])]);
    }
    for (const [file, bytes] of files) {
      const blob = git(['hash-object', '-w', '--stdin'], { input: bytes }).trim();
      const mode = git(['ls-tree', base, '--', file]).split(' ')[0] || '100644';
      // A link (120000) would keep the text as its target; a submodule
      // (160000) can't hold it at all.
      if (!PLAIN.has(mode)) {
        throw new Error(
          `${file} in jbhirsh/${app} is not a plain file (mode ${mode}): the sync writes only ` +
            'plain files, so replace it with one in the app. Nothing was pushed.',
        );
      }
      git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${file}`]);
    }
    // --missing-ok: without it git first fetches every blob the index
    // names, the whole app (hundreds of MB), to check they exist.
    const tree = git(['write-tree', '--missing-ok']).trim();
    const { subject, body } = commitMessage(change, ciSha);
    parent = git(['commit-tree', tree, '-p', parent, '-m', subject, '-m', body], {
      env: COMMITTER,
    }).trim();
  }
  try {
    // push.negotiate: once main has moved past `base`, GitHub no longer
    // advertises it, and without negotiating git fetches every blob of
    // base's tree to work out what to send: the whole app again.
    git(
      [
        '-c',
        'push.negotiate=true',
        'push',
        '--atomic',
        `--force-with-lease=refs/heads/${BRANCH}:${oldHead}`,
        remote,
        `${parent}:refs/heads/${BRANCH}`,
      ],
      { env: tokenEnv(token) },
    );
  } catch (error) {
    const text = said(error);
    if (/refusing to allow .*workflow/i.test(text)) {
      throw new Error(
        `${SECRET} lacks the Workflows permission on jbhirsh/${app}, which a push of a ` +
          `workflow file needs: give the token Workflows read and write there. Nothing was pushed.`,
        { cause: error },
      );
    }
    if (/denied|403|Authentication failed|could not read Username/i.test(text)) {
      throw new Error(
        `${SECRET} can't push to jbhirsh/${app}: give the token ${TOKEN_NEEDS} on it. Nothing was pushed.`,
        { cause: error },
      );
    }
    throw error;
  }
  return parent;
}

/**
 * An error that also carries what the run had done when it was thrown, so
 * the log says it (main prints `done` first).
 */
function withDone(error: unknown, done: string[]) {
  const out = error instanceof Error ? error : new Error(String(error));
  (out as Error & { done?: string[] }).done = done;
  return out;
}

/**
 * The step with the token: brings the app's sync PR in line with this
 * repo's files, then fails naming whatever keeps it from merging.
 *
 * @param env APP, CI_SHA, GH_TOKEN, SYNC_OUT,
 *   RUN_URL, and AUTO_MERGE ('false' leaves the PR for a person to merge)
 * @param deps `remote` and `ciRoot`: the app's GitHub repository and this
 *   checkout, unless a test brings its own
 * @returns what it did
 */
export function publish(
  env: Record<string, string | undefined>,
  {
    api,
    graphql,
    git,
    remote,
    ciRoot = CI_ROOT,
  }: { api: Api; graphql: Graphql; git: Git; remote?: string; ciRoot?: string },
): string[] {
  const token = env.GH_TOKEN ?? '';
  if (!token) throw new Error(`${SECRET} is empty: the publish step got no token`);
  const app = appOf(env.APP);
  const ciSha = shaOf(env.CI_SHA, 'CI_SHA');
  const autoMergeOn = env.AUTO_MERGE !== 'false';
  const repo = `jbhirsh/${app}`;
  const url = remote ?? `https://github.com/${repo}.git`;
  const prepared = readPrepared(path.join(env.SYNC_OUT ?? '', 'prepared.json'));

  // The app's main as it is now, from GitHub (never the commit prepare
  // names, which is a step without the token's word): trees now, blobs as read.
  git(['init', '-q']);
  git(['config', 'remote.origin.url', url]);
  git(['config', 'remote.origin.promisor', 'true']);
  git(['config', 'remote.origin.partialclonefilter', 'blob:none']);
  const remoteHead = (ref: string) =>
    git(['ls-remote', url, ref], { env: tokenEnv(token) }).split(/\s/)[0];
  const base = shaOf(remoteHead('refs/heads/main'), `jbhirsh/${app}'s main`);
  git(['fetch', '-q', '--filter=blob:none', '--depth=1', 'origin', base]);
  // Every synced file is text (Markdown, YAML, JSON), read as UTF-8: one
  // that isn't (a replacement character after decoding) is refused, as
  // prepare refuses it, rather than compared lossily.
  const readApp: (file: string) => Buffer | null = (file) => {
    let text: string;
    try {
      text = git(['cat-file', 'blob', `${base}:${file}`]);
    } catch {
      return null;
    }
    if (text.includes('\uFFFD')) throw notText(file, app);
    return Buffer.from(text, 'utf8');
  };
  const { changes, settingsText } = planFor({ app, ciRoot, readApp });

  // What the branch must change, and to what.
  const expected: Map<string, Buffer> = new Map(
    changes.map((change) => [change.path, change.bytes]),
  );
  const companions = changes.flatMap((change) => change.companions);
  const withSettings = changes.filter((change) => change.companions.length > 0);
  if (withSettings.length > 0 && prepared.appSha !== base) {
    throw new Error(
      `jbhirsh/${app}'s main moved (${prepared.appSha.slice(0, 7)} → ${base.slice(0, 7)}) after ` +
        `prepare wrote its ${SETTINGS_FILE}: nothing was pushed; dispatch the sync again.`,
    );
  }
  for (const change of withSettings) {
    if (prepared.settings[change.path] === undefined) {
      throw new Error(
        `prepare wrote no ${SETTINGS_FILE} for ${change.path}, which adds companions`,
      );
    }
  }
  if (withSettings.length > 0) {
    expected.set(
      SETTINGS_FILE,
      Buffer.from(prepared.settings[(withSettings.at(-1) as Change).path]),
    );
  }

  const lines: string[] = [];
  let pull = openPull(api, repo);
  const matches =
    pull !== null && holdsExactly(compare(api, repo, base, pull.head.sha).files ?? [], expected);
  const action = decide({
    changes: changes.length,
    open: pull !== null,
    matches,
    mergeable: pull?.mergeable_state ?? null,
  });

  if (action === 'none') {
    // A branch left by a PR someone closed, or by a run that failed after
    // its push: with nothing to sync it holds nothing anyone needs.
    if (remoteHead(`refs/heads/${BRANCH}`)) {
      deleteBranch(api, repo);
      return [`${app}: every synced file matches ${CI_REPO}; deleted a stale ${BRANCH}.`];
    }
    return [`${app}: every synced file matches ${CI_REPO}; no PR open.`];
  }
  if (action === 'close') {
    const number = (pull as Pull).number;
    api('POST', `repos/${repo}/issues/${number}/comments`, {
      body: `Every synced file in this repo matches [${CI_REPO}@${ciSha.slice(0, 7)}](https://github.com/${CI_REPO}/commit/${ciSha}) again, so this PR has nothing left to sync.`,
    });
    api('PATCH', `repos/${repo}/pulls/${number}`, { state: 'closed' });
    deleteBranch(api, repo);
    return [`${app}: closed #${number}: every synced file matches ${CI_REPO} again.`];
  }

  let head = pull?.head.sha as string;
  const fresh = action === 'build';
  if (fresh) {
    if (pull?.auto_merge) autoMergeOff(graphql, pull);
    // '' when there is no branch yet: the lease then requires there still is none.
    const oldHead = remoteHead(`refs/heads/${BRANCH}`);
    head = build({
      git,
      base,
      changes,
      settings: prepared.settings,
      ciSha,
      oldHead,
      remote: url,
      token,
      app,
    });
    lines.push(
      `${app}: pushed ${BRANCH} at ${head.slice(0, 7)}, ${changes.length} commit(s) on ${base.slice(0, 7)}.`,
    );
  }

  try {
    // Every run guards the head it leaves, kept or new: a push to the
    // branch after the sync's (a mode change, say) holds the same bytes.
    const guardBase = fresh ? base : compare(api, repo, base, head).merge_base_commit.sha;
    const problems = guard({
      api,
      repo,
      base: guardBase,
      head,
      commits: changes.length,
      expected,
      settingsBefore: fresh ? settingsText : readSettingsAt(api, repo, guardBase),
      companions,
    });
    if (problems.length > 0) {
      if (!fresh && pull?.auto_merge) autoMergeOff(graphql, pull);
      throw new Error(
        `${app}: the guard refused ${BRANCH} at ${head.slice(0, 7)}; auto-merge is off:\n  - ${problems.join('\n  - ')}`,
      );
    }

    if (fresh) {
      const body = prBody({ ciSha, runUrl: env.RUN_URL, changes });
      let number = pull?.number;
      if (number) {
        api('PATCH', `repos/${repo}/pulls/${number}`, { title: PR_TITLE, body });
        lines.push(`${app}: rewrote #${number}'s description.`);
      } else {
        number = openNew(api, repo, body, () =>
          git(
            [
              'push',
              '--atomic',
              `--force-with-lease=refs/heads/${BRANCH}:${head}`,
              url,
              `:refs/heads/${BRANCH}`,
            ],
            {
              env: tokenEnv(token),
            },
          ),
        );
        lines.push(`${app}: opened #${number}.`);
      }
      pull = api('GET', `repos/${repo}/pulls/${number}`) as Pull;
    }
    const current = pull as Pull;
    if (current.draft) {
      lines.push(
        `${app}: #${current.number} is a draft, so auto-merge stays off until it is marked ready.`,
      );
    } else if (!autoMergeOn) {
      if (current.auto_merge) autoMergeOff(graphql, current);
      lines.push(
        `${app}: #${current.number} is left for a person to merge: this run's auto-merge is off.`,
      );
    } else if (fresh || !current.auto_merge) {
      lines.push(
        `${app}: #${current.number}: ${autoMerge({ api, graphql, repo, pull: current, head })}.`,
      );
    } else {
      lines.push(`${app}: #${current.number} already holds these files; left as it is.`);
    }

    // A head pushed this run has no results yet: only its threads count.
    const rules = fresh ? { required: [], types: [] } : rulesOf(api, repo);
    const causes = blockers({
      threads: threadsOf(graphql, repo, current.number),
      required: rules.required,
      checkRuns: fresh
        ? []
        : (pages(api, `repos/${repo}/commits/${head}/check-runs`, 'check_runs') as {
            id: number;
            name: string;
            status: string;
            conclusion: string | null;
          }[]),
      statuses: fresh
        ? []
        : (
            api('GET', `repos/${repo}/commits/${head}/status?per_page=100`) as {
              statuses: { context: string; state: string }[];
            }
          ).statuses,
      mergeable: fresh ? null : (pull?.mergeable_state ?? null),
      ruleTypes: rules.types,
    });
    if (causes.length > 0) {
      throw new Error(causes.map((cause) => `${app}: ${BRANCH} is blocked: ${cause}`).join('\n'));
    }
  } catch (error) {
    throw withDone(error, lines);
  }
  return lines;
}

/**
 * Why a synced file of the app can't be compared: it isn't UTF-8 text.
 */
function notText(file: string, app: string) {
  return new Error(
    `${file} in jbhirsh/${app} is not UTF-8 text: the sync holds only text files, so replace it in the app.`,
  );
}

/**
 * Deletes the sync's branch; one already gone is what this wanted.
 */
function deleteBranch(api: Api, repo: string) {
  try {
    api('DELETE', `repos/${repo}/git/refs/heads/${BRANCH}`);
  } catch (error) {
    if (![404, 422].includes(statusOf(error) ?? 0)) throw error;
  }
}

/**
 * Opens the sync PR for the branch just pushed. If GitHub refuses (the
 * token may push but not open a PR), the branch is deleted again, so a
 * refusal leaves the app as it was, and the run fails naming the permission.
 *
 * @param api
 * @param repo
 * @param body
 * @param unpush deletes the pushed branch, leased to its head
 */
function openNew(api: Api, repo: string, body: string, unpush: () => void): number {
  try {
    return (
      api('POST', `repos/${repo}/pulls`, { title: PR_TITLE, head: BRANCH, base: 'main', body }) as {
        number: number;
      }
    ).number;
  } catch (error) {
    unpush();
    throw new Error(
      `GitHub refused to open the sync PR in ${repo} (${said(error).trim().split('\n')[0]}): ` +
        `${SECRET} needs Pull requests read and write there. The pushed ${BRANCH} was deleted again.`,
      { cause: error },
    );
  }
}

/**
 * The app's ci.json at a commit, by the contents API ('' when it has none).
 */
function readSettingsAt(api: Api, repo: string, ref: string) {
  try {
    const file = api('GET', `repos/${repo}/contents/${SETTINGS_FILE}?ref=${ref}`) as {
      content: string;
    };
    return Buffer.from(file.content, 'base64').toString('utf8');
  } catch (error) {
    if (statusOf(error) === 404) return '';
    throw error;
  }
}

// ------------------------------------------------------------------ CLI

/**
 * GitHub's GraphQL API through gh (GH_TOKEN from the environment).
 */
function ghGraphql(query: string, variables: Record<string, unknown>): unknown {
  const out = execFileSync('gh', ['api', 'graphql', '--input', '-'], {
    input: JSON.stringify({ query, variables }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  const parsed: { data?: unknown; errors?: { message: string }[] } = JSON.parse(out);
  if (parsed.errors?.length) throw new Error(parsed.errors.map((e) => e.message).join('; '));
  return parsed.data;
}

/**
 * The dry run: the PR the sync would open for an app's checkout.
 */
export function dryRun(app: string, root: string, ciRoot: string = CI_ROOT): string[] {
  const readApp = diskReader(root, app);
  const { changes } = planFor({
    app: appOf(app),
    ciRoot,
    readApp,
  });
  let ciSha = 'HEAD';
  try {
    ciSha = gitIn(ciRoot)(['rev-parse', 'HEAD']).trim();
  } catch {
    // Not a git checkout: the report names no commit.
  }
  const lines = report(app, changes, ciSha);
  if (changes.length > 0) lines.push('', prBody({ ciSha, changes }));
  return lines;
}

/**
 * Installs the app's packages, with no install scripts, for its Prettier.
 */
function npmCi(root: string) {
  execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: 'inherit',
  });
}

/**
 * The command line; returns its exit code.
 *
 * @param argv
 * @param env
 * @param log
 * @param deps GitHub, git and npm, unless a test brings its own
 */
export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  log: (line: string) => void = console.log,
  deps: {
    api?: Api;
    graphql?: Graphql;
    gitFor?: (cwd: string) => Git;
    install?: (root: string) => void;
    remote?: string;
    ciRoot?: string;
    checkedOut?: () => string;
  } = {},
) {
  const { api = ghApi, graphql = ghGraphql, gitFor = gitIn, install = npmCi } = deps;
  const { remote, ciRoot = CI_ROOT } = deps;
  const [command, ...rest] = argv;
  try {
    if (command === 'check') {
      const { go, message } = check(env, api, deps.checkedOut);
      log(message);
      if (env.GITHUB_OUTPUT) writeFileSync(env.GITHUB_OUTPUT, `go=${go}\n`, { flag: 'a' });
      return 0;
    }
    if (command === 'prepare') {
      for (const line of await prepare(env, { install, ciRoot })) log(line);
      return 0;
    }
    if (command === 'publish') {
      const work = path.join(env.RUNNER_TEMP ?? env.SYNC_OUT ?? '.', 'sync-files-git');
      mkdirSync(work, { recursive: true });
      for (const line of publish(env, { api, graphql, git: gitFor(work), remote, ciRoot })) {
        log(line);
      }
      return 0;
    }
    if (command === 'dry-run' && rest.length === 2) {
      for (const line of dryRun(rest[0], path.resolve(rest[1]), ciRoot)) log(line);
      return 0;
    }
    log('usage: node sync/sync.ts check | prepare | publish | dry-run <app> <app dir>');
    return 2;
  } catch (error) {
    for (const line of (error as { done?: string[] })?.done ?? []) log(line);
    const message = error instanceof Error ? error.message : String(error);
    for (const line of message.split('\n')) log(`::error::${line}`);
    return 1;
  }
}

/* c8 ignore next 3: the command line itself, run by the action */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
