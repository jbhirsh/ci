// The steps of the PR GIFs workflows, which record a PR's before/after GIFs
// in Actions and attach them to the PR, so nothing goes in git:
// pr-gif.yml (recording, and the manual run's attach) and pr-gif-attach.yml
// (the automatic runs' attach, on workflow_run). Their actions run these:
//
//   node gif/workflow.mjs source   the app's `gif.source` ("web" or
//                                  "ci-videos"), as the step output `source`
//   node gif/workflow.mjs changed  which scenarios a pull_request run
//                                  records (gif/changed), or a dispatch's
//                                  inputs passed through
//   node gif/workflow.mjs record   records the GIFs into pr-gif/<scenario>/
//   node gif/workflow.mjs check    whether a finished run's GIFs may be
//                                  attached (gif/check), on workflow_run
//   node gif/workflow.mjs gh       fails unless gh can attach (lib/gh.mjs)
//   node gif/workflow.mjs attach   attaches pr-gif/'s GIFs to the PR
//
// from the app's checkout (changed, record, check) or the artifact's folder
// (attach), with the workflow's inputs in the environment: PR (its number),
// SCENARIOS (the scenario files, separated by spaces, commas or lines),
// SIDE_BY_SIDE and AFTER_ONLY ("true" or "false"), and for an automatic run
// AUTOMATIC ("true") with the rest each step's header names.
//
// record runs cli.mjs once a scenario, without --dir, so each one's GIFs are
// left in pr-gif/<scenario name>/ as a run on the owner's machine leaves
// them; for an app whose CI records videos (sift), it runs videos.mjs once
// with --out pr-gif, which takes every scenario the PR's run recorded, so
// SCENARIOS must be empty. Every scenario is recorded even after one fails;
// the step fails if any did, but what did record is still uploaded. It also
// writes pr-gif/pr-gif.json (MANIFEST): the PR, the commit recorded, and
// which scenarios recorded and which failed. A manual run attaches nothing
// once anything failed; an automatic one attaches what recorded.
//
// The automatic runs (ci#49): pr-gif.yml's record job runs on the
// pull_request event for a web app, recording each scenario the PR's whole
// diff adds or changes (changedScenarios), "before" allowed to fail for a
// screen main doesn't have (--before-may-fail); sift's CI already records
// its scenarios' "after" on the PR's run. pr-gif-attach.yml then runs on
// workflow_run, from main's copy of the workflow, which a PR can't change:
// check reads the finished run (event, conclusion, fork, PR, head) and the
// PR's changed files through the API, never the PR's code, and says whether
// to go on; for sift, record then runs videos.mjs with that run as "after";
// and attach, alone holding BOT_PR_TOKEN, checks the artifact as below and
// against the PR's current head, attaches what recorded, marks the failed
// scenarios' earlier blocks "Not updated", and drops each automatic block
// whose scenario the PR no longer changes (publish.mjs). A fork's PR is
// never attached, nor recorded on main for sift.
//
// attach is its own job, the only one holding the token that may attach
// (BOT_PR_TOKEN: GitHub refuses the Actions token), and it runs none of the
// PR's code: it reads only the artifact's folder names, GIFs and manifest,
// refusing a name that isn't a plain scenario name, a file that isn't a GIF,
// one over the 10 MB GitHub attaches, and a manifest of any other shape or
// for another PR or commit.
// publish.mjs's attachToPr writes the tables into the description and
// uploads; then each new link is fetched, signed out, until it answers 200,
// for up to a minute, since an edited-in attachment goes live a moment after
// the edit (ci#33's trial T1).

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { appRoot } from '../lib/app.mjs';
import { checkGh } from '../lib/gh.mjs';
import {
  HeadMovedError,
  attachToPr,
  attachmentTable,
  blockKeys,
  findBlock,
  gifNames,
  isAutomatic,
  recordedLine,
  shownFiles,
  staleNote,
  staleText,
  withBlock,
  withoutBlock,
} from './publish.mjs';
import { scenarioName } from './options.mjs';
import { isScenarioFile } from './scenario.mjs';
import { loadSettings } from './settings.mjs';

/** @typedef {import('./publish.mjs').Published} Published */

/** Where record leaves the GIFs and attach reads them, from the step's folder. */
export const OUT = 'pr-gif';

/** The largest image GitHub takes as an attachment (its docs: 10 MB). */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;

/** What record wrote, beside the scenarios' folders in OUT. */
export const MANIFEST = 'pr-gif.json';

/** The most a manifest may weigh: a few hundred scenario names. */
export const MANIFEST_MAX_BYTES = 64 * 1024;

/** pr-gif.yml's record job, as a caller's run names it ("gif / Record the GIFs"). */
const RECORD_JOB = /(^|\/ )Record the GIFs$/;

/** The commit status the automatic runs set on the PR's head. */
export const STATUS_CONTEXT = 'PR GIFs';

/** A scenario's name as it goes into a marker and a folder. */
const NAME = /^\w[\w.-]*$/;

/** @param {string} name */
const isName = (name) => NAME.test(name) && !name.includes('--');

/** A full commit SHA. */
const SHA = /^[0-9a-f]{40}$/;

/**
 * @typedef {object} Inputs The workflow's inputs.
 * @property {string} pr
 * @property {string[]} scenarios
 * @property {boolean} sideBySide
 * @property {boolean} afterOnly
 * @property {boolean} automatic recorded on its own (ci#49), not run by hand
 * @property {string} [head] the commit the scenarios are recorded at
 * @property {string} [afterRun] for sift's automatic run: its CI run, "after"
 */

/**
 * Reads the workflow's inputs from the environment, refusing any it can't
 * pass on safely as arguments.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Inputs}
 */
export function parseInputs(env) {
  const pr = env.PR ?? '';
  if (!/^[1-9]\d*$/.test(pr)) throw new Error(`pr-gif: PR is the PR's number, not "${pr}"`);
  const scenarios = (env.SCENARIOS ?? '').split(/[\s,]+/).filter(Boolean);
  for (const file of scenarios) {
    // A path in the app, never an option or a way out of it.
    if (!/^[\w][\w./-]*$/.test(file) || file.split('/').includes('..')) {
      throw new Error(`pr-gif: "${file}" isn't a scenario file in the app`);
    }
  }
  /** @param {string} name */
  const flag = (name) => {
    const value = env[name] ?? 'false';
    if (value !== 'true' && value !== 'false') {
      throw new Error(`pr-gif: ${name} is "true" or "false", not "${value}"`);
    }
    return value === 'true';
  };
  const sideBySide = flag('SIDE_BY_SIDE');
  const afterOnly = flag('AFTER_ONLY');
  const automatic = flag('AUTOMATIC');
  if (sideBySide && afterOnly)
    throw new Error('pr-gif: side-by-side needs a before: drop after-only');
  if (automatic && (sideBySide || afterOnly)) {
    throw new Error('pr-gif: an automatic run records a separate before and after');
  }
  const head = env.HEAD_SHA || undefined;
  if (head !== undefined && !SHA.test(head)) {
    throw new Error(`pr-gif: HEAD_SHA is a full commit SHA, not "${head}"`);
  }
  const afterRun = env.AFTER_RUN || undefined;
  if (afterRun !== undefined && !/^[1-9]\d*$/.test(afterRun)) {
    throw new Error(`pr-gif: AFTER_RUN is a run's id, not "${afterRun}"`);
  }
  return { pr, scenarios, sideBySide, afterOnly, automatic, head, afterRun };
}

/**
 * The command lines cli.mjs is run with, one a run. An automatic run of a
 * web app lets "before" fail (a screen main doesn't have); sift's takes its
 * CI run for "after", at the commit that run recorded, and only the named
 * scenarios (SCENARIOS holds names there, not files).
 *
 * @param {'web' | 'ci-videos'} source the app's `gif.source`
 * @param {Inputs} inputs
 * @returns {string[][]}
 */
export function recordRuns(
  source,
  { pr, scenarios, sideBySide, afterOnly, automatic, head, afterRun },
) {
  const both = sideBySide ? ['--side-by-side'] : [];
  if (source === 'ci-videos' && automatic) {
    if (!head || !afterRun) {
      throw new Error('pr-gif: an automatic run of CI videos needs HEAD_SHA and AFTER_RUN');
    }
    if (scenarios.length === 0 || !scenarios.every(isName)) {
      throw new Error('pr-gif: name the scenarios the PR changes, as plain names');
    }
    return [
      [pr, '--out', OUT, '--after-run', afterRun, '--head', head, '--only', scenarios.join(',')],
    ];
  }
  if (source === 'ci-videos') {
    if (scenarios.length > 0) {
      throw new Error(
        "pr-gif: this app's CI records every scenario on the PR's run, so leave scenarios empty",
      );
    }
    return [[pr, '--out', OUT, ...both, ...(afterOnly ? ['--no-before'] : [])]];
  }
  if (scenarios.length === 0) throw new Error('pr-gif: name the scenario files to record');
  return scenarios.map((file) => [
    file,
    ...both,
    ...(afterOnly ? ['--after-only'] : []),
    ...(automatic ? ['--before-may-fail'] : []),
  ]);
}

/**
 * @typedef {object} Manifest What record wrote in OUT/MANIFEST.
 * @property {number} pr
 * @property {string} head the commit the scenarios were recorded at
 * @property {boolean} automatic
 * @property {string[]} recorded the scenarios with GIFs
 * @property {string[]} failed the ones without
 */

/**
 * The manifest as record writes it.
 *
 * @param {Manifest} manifest
 */
export function writeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The manifest from the artifact, which the PR's run wrote: so data, of
 * exactly the shape writeManifest writes, or an error saying what's wrong.
 *
 * @param {string | Buffer} text
 * @returns {Manifest}
 */
export function readManifest(text) {
  const fail = (/** @type {string} */ why) => new Error(`pr-gif: ${OUT}/${MANIFEST} ${why}`);
  if (Buffer.byteLength(text) > MANIFEST_MAX_BYTES) throw fail('is over 64 KB');
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(String(text));
  } catch {
    throw fail("isn't JSON");
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fail("isn't an object");
  }
  const m = /** @type {Record<string, unknown>} */ (value);
  const keys = ['pr', 'head', 'automatic', 'recorded', 'failed'];
  if (Object.keys(m).some((k) => !keys.includes(k)) || keys.some((k) => !(k in m))) {
    throw fail(`must hold exactly ${keys.join(', ')}`);
  }
  if (typeof m.pr !== 'number' || !Number.isSafeInteger(m.pr) || m.pr < 1) {
    throw fail("'s pr isn't a PR number");
  }
  if (typeof m.head !== 'string' || !SHA.test(m.head)) throw fail("'s head isn't a commit SHA");
  if (typeof m.automatic !== 'boolean') throw fail("'s automatic isn't true or false");
  /** @param {unknown} list */
  const names = (list) =>
    Array.isArray(list) && list.every((n) => typeof n === 'string' && isName(n));
  if (!names(m.recorded) || !names(m.failed)) throw fail("'s lists aren't scenario names");
  return /** @type {Manifest} */ (m);
}

/**
 * @typedef {object} Change One file a PR changes.
 * @property {string} file its path, from the repository's root
 * @property {boolean} removed
 */

/**
 * The files `git diff --name-status --no-renames -z` lists.
 *
 * @param {string} text
 * @returns {Change[]}
 */
export function parseNameStatus(text) {
  const fields = text.split('\0');
  /** @type {Change[]} */
  const changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (!fields[i]) break;
    changes.push({ file: fields[i + 1], removed: fields[i].startsWith('D') });
  }
  return changes;
}

/**
 * The files the API's pulls/<n>/files lists, one JSON object a line, as
 * `gh api --paginate --jq '.[] | {filename, status}'` prints them; anything
 * else in a line is passed over.
 *
 * @param {string} text
 * @returns {Change[]}
 */
export function parseApiFiles(text) {
  /** @type {Change[]} */
  const changes = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    /** @type {unknown} */
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const { filename, status } = /** @type {Record<string, unknown>} */ (value ?? {});
    if (typeof filename === 'string' && typeof status === 'string') {
      changes.push({ file: filename, removed: status === 'removed' });
    }
  }
  return changes;
}

/**
 * The scenario files a PR's whole diff adds or changes: directly in
 * `folder` (the `gif.scenarios` setting), scenarios by isScenarioFile, and
 * named plainly enough to pass on as an argument and a marker (any other is
 * passed over); each once, sorted. A removed one isn't recorded.
 *
 * @param {readonly Change[]} changes
 * @param {string | undefined} folder
 * @param {'web' | 'ci-videos'} source
 */
export function changedScenarios(changes, folder, source) {
  if (!folder) return [];
  const dir = path.posix.normalize(folder).replace(/\/+$/, '');
  const files = changes
    .filter(({ file, removed }) => {
      if (removed || path.posix.dirname(file) !== dir) return false;
      const name = path.posix.basename(file);
      return isScenarioFile(name, source) && isName(name);
    })
    .map(({ file }) => file);
  return [...new Set(files)].sort();
}

/**
 * The name a changed scenario file's GIFs go by, as far as can be told
 * without loading it: its file's name (a web scenario may name itself
 * otherwise, which only its recording tells).
 *
 * @param {string} file
 */
export const fileScenarioName = (file) => scenarioName(file, undefined);

/**
 * @typedef {object} WorkflowRun What check reads of the workflow_run event's run.
 * @property {number} id
 * @property {string} event
 * @property {string | null} conclusion
 * @property {string} head_sha
 * @property {string} [head_branch]
 * @property {string} html_url
 * @property {{ full_name?: string; owner?: { login?: string } } | null} [head_repository]
 * @property {{ number: number }[]} [pull_requests]
 */

/**
 * @typedef {object} Pull What check reads of the PR.
 * @property {number} number
 * @property {string} state
 * @property {string | null} [body]
 * @property {{ sha: string; repo: { full_name: string } | null }} head
 */

/**
 * Whether a finished run is one to look further at: a pull_request run that
 * ended, success or failure (a failure may still have recorded some). A
 * cancelled run was overtaken by a newer push, whose own run follows.
 *
 * @param {WorkflowRun} run
 * @param {string} repo this repository, owner/name
 * @returns {{ ignore: string } | { fork: boolean }}
 */
export function screenRun(run, repo) {
  if (run.event !== 'pull_request') return { ignore: `a ${run.event} run, not a PR's` };
  if (run.conclusion !== 'success' && run.conclusion !== 'failure') {
    return { ignore: `the run ended ${run.conclusion}` };
  }
  return { fork: run.head_repository?.full_name !== repo };
}

/**
 * @typedef {object} Verdict What check decided.
 * @property {boolean} go attach (or only prune) with the token
 * @property {boolean} record the PR changes a scenario, so GIFs are made and attached
 * @property {string[]} names those scenarios' names
 * @property {{ state: 'pending' | 'success'; description: string } | null} status the commit status to set now
 * @property {string} why for the log
 */

/**
 * What to do about a pull_request run that screenRun let through, once its
 * PR is read: never anything with the token for a fork's, nothing for a
 * run whose PR has moved on or closed, and a prune-only attach for a PR
 * that has nothing recorded but still shows an automatic block.
 *
 * Whether there is a recording is the run's own word for a web app (its
 * record job ran: `recorded`), so the two workflows can't disagree on it,
 * whatever main's or the PR's settings say; for sift, whether the PR
 * changes a scenario, as nothing recorded them for this yet.
 *
 * @param {{ run: WorkflowRun; pull: Pull; repo: string; fork: boolean; changed: readonly string[]; source: 'web' | 'ci-videos'; recorded?: boolean }} facts
 *   changed: the scenario files the PR changes (changedScenarios), which
 *   name them; recorded: for a web app, whether the run's record job ran
 * @returns {Verdict}
 */
export function checkRun({ run, pull, repo, fork, changed, source, recorded }) {
  const names = [...new Set(changed.map(fileScenarioName))].sort();
  const any = source === 'web' ? recorded === true : names.length > 0;
  const none = { go: false, record: false, names, status: null };
  if (pull.state !== 'open') return { ...none, why: `#${pull.number} is ${pull.state}` };
  if (pull.head.sha !== run.head_sha) {
    return {
      ...none,
      why: `#${pull.number}'s head is ${pull.head.sha.slice(0, 7)} now, not ${run.head_sha.slice(0, 7)}: its own run follows`,
    };
  }
  if (fork || pull.head.repo?.full_name !== repo) {
    return {
      ...none,
      status: any
        ? {
            state: 'success',
            description:
              source === 'web'
                ? "A fork's PR: recorded, not attached. Run PR GIFs by hand if you trust it"
                : "A fork's PR: not recorded here. Run PR GIFs by hand if you trust it",
          }
        : null,
      why: `#${pull.number} is a fork's: nothing is attached`,
    };
  }
  if (any) {
    return {
      go: true,
      record: true,
      names,
      status: {
        state: 'pending',
        description:
          source === 'web' ? 'Checking and attaching the GIFs' : 'Making and attaching the GIFs',
      },
      why: `#${pull.number} changes ${names.join(', ') || 'its GIF scenarios'}`,
    };
  }
  const body = pull.body ?? '';
  const prune = blockKeys(body).filter((key) => isAutomatic(body, key));
  return {
    ...none,
    go: prune.length > 0,
    why:
      prune.length > 0
        ? `#${pull.number} no longer changes ${prune.join(', ')}: dropping their GIFs`
        : `#${pull.number} changes no GIF scenario`,
  };
}

/**
 * The description's change an automatic attach makes, given what recorded:
 * each recorded scenario's block put in, saying the commit and a "before"
 * main couldn't play; each failed one's automatic block marked "Not updated";
 * and, when `keep` is known, each automatic block not in it dropped.
 *
 * @param {{ scenarios: readonly Published[]; failed: readonly string[]; keep: string[] | null; head: string; runUrl: string }} what
 * @returns {(body: string) => string}
 */
export function automaticChange({ scenarios, failed, keep, head, runUrl }) {
  return (body) => {
    let next = body;
    for (const s of scenarios) {
      const line = recordedLine(head, { automatic: true, noBefore: !s.before && !s.sideBySide });
      next = withBlock(next, s.name, `${line}\n\n${attachmentTable(s)}`);
    }
    for (const name of failed) {
      if (isAutomatic(next, name)) next = staleNote(next, name, staleText(head, runUrl));
    }
    if (keep) {
      for (const key of blockKeys(next)) {
        if (isAutomatic(next, key) && !keep.includes(key)) next = withoutBlock(next, key);
      }
    }
    return next;
  };
}

/**
 * Whether the file starts as a GIF does.
 *
 * @param {string} file
 */
function isGif(file) {
  const head = Buffer.alloc(6);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, head, 0, 6, 0);
  } finally {
    closeSync(fd);
  }
  return /^GIF8[79]a$/.test(head.toString('latin1'));
}

/**
 * The GIFs in `cwd`/`dir`, one entry a scenario's folder, each GIF as a
 * path relative to `cwd`; folders sorted, any with no GIF of the scenario's
 * names passed over.
 *
 * @param {string} cwd
 * @param {string} [dir]
 * @returns {Published[]}
 */
export function collectGifs(cwd, dir = OUT) {
  const from = path.join(cwd, dir);
  /** @type {Published[]} */
  const found = [];
  for (const name of readdirSync(from).sort()) {
    if (!statSync(path.join(from, name)).isDirectory()) continue;
    // The name goes into the description's markers (where `--` would end
    // the comment) and alt text.
    if (!/^\w[\w.-]*$/.test(name) || name.includes('--')) {
      throw new Error(`pr-gif: "${name}" isn't a scenario name that can go in a description`);
    }
    const names = gifNames(name);
    /** @param {string} file */
    const at = (file) => {
      const local = path.join(from, name, file);
      try {
        if (!statSync(local).isFile()) return null;
      } catch {
        return null;
      }
      if (!isGif(local)) throw new Error(`pr-gif: ${dir}/${name}/${file} isn't a GIF`);
      const { size } = statSync(local);
      if (size > ATTACH_MAX_BYTES) {
        throw new Error(
          `pr-gif: ${dir}/${name}/${file} is ${(size / 1024 / 1024).toFixed(1)} MB, over the 10 MB GitHub attaches: record it narrower (a smaller width) or shorter`,
        );
      }
      return `${dir}/${name}/${file}`;
    };
    const entry = {
      name,
      before: at(names.before),
      after: at(names.after),
      sideBySide: at(names.side),
    };
    if (entry.before || entry.after || entry.sideBySide) found.push(entry);
  }
  return found;
}

/**
 * The attachment links in the scenarios' blocks of the description, the
 * blocks withBlock wrote; throws unless there is one for each GIF attached.
 *
 * @param {string} body
 * @param {readonly Published[]} scenarios
 */
export function attachmentLinks(body, scenarios) {
  const links = scenarios.flatMap(({ name }) => {
    const found = findBlock(body, name);
    if (!found) return [];
    return [
      ...body
        .slice(found.from, found.to)
        .matchAll(/https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/g),
    ].map((m) => m[0]);
  });
  const attached = shownFiles(scenarios).length;
  if (links.length !== attached) {
    throw new Error(
      `pr-gif: the description's blocks link ${links.length} attachment(s), not the ${attached} attached`,
    );
  }
  return links;
}

/**
 * Waits until every link answers 200, signed out, for up to `limitMs` in
 * all; throws naming the ones that never did.
 *
 * @param {readonly string[]} links
 * @param {{ fetch?: typeof globalThis.fetch; wait?: (ms: number) => Promise<unknown>; now?: () => number; limitMs?: number; everyMs?: number }} [options]
 */
export async function waitForLinks(
  links,
  {
    fetch = globalThis.fetch,
    wait = sleep,
    now = Date.now,
    limitMs = 60_000,
    everyMs = 5_000,
  } = {},
) {
  /** @type {string[]} */
  const failed = [];
  // One deadline for all: they were edited in together.
  const until = now() + limitMs;
  for (const link of links) {
    /** @type {string} */
    let last;
    for (;;) {
      try {
        const response = await fetch(link, { redirect: 'follow' });
        await response.body?.cancel();
        if (response.status === 200) break;
        last = String(response.status);
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      if (now() >= until) {
        failed.push(`${link} (${last})`);
        break;
      }
      await wait(everyMs);
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `pr-gif: ${failed.length} attached GIF(s) didn't answer within ${limitMs / 1000} s: ${failed.join(', ')}`,
    );
  }
}

/**
 * Runs a command, returning what it printed; a failure throws.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {string} [cwd]
 */
function output(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(
      `pr-gif: ${command} ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.stdout || '').trim().slice(-500)}`,
    );
  }
  return result.stdout;
}

/**
 * Writes step outputs, each value on one line.
 *
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, string | number | boolean>} values
 */
function setOutputs(env, values) {
  if (!env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([key, value]) => {
    const text = String(value);
    // Every value is a name, number or SHA list, never a line break.
    if (/[\r\n]/.test(text)) throw new Error(`pr-gif: output ${key} holds a line break`);
    return `${key}=${text}\n`;
  });
  appendFileSync(env.GITHUB_OUTPUT, lines.join(''));
}

/**
 * The scenario folders in `dir` that hold a GIF, whatever their names.
 *
 * @param {string} dir
 */
function folders(dir) {
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir).filter((name) => {
      try {
        return statSync(path.join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    }),
  );
}

/**
 * @typedef {object} Context What main is handed, for tests.
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [cwd]
 * @property {(args: string[]) => number} [run] runs cli.mjs with these arguments, returning its exit code
 * @property {(args: string[]) => string} [api] runs `gh api` with these arguments, returning what it printed
 * @property {(args: string[]) => string} [git] runs git in the app's checkout, returning what it printed
 * @property {(line: string) => void} [log]
 * @property {typeof globalThis.fetch} [fetch]
 * @property {(ms: number) => Promise<unknown>} [wait]
 */

/**
 * The changed step: on pull_request, the scenario files the PR's whole diff
 * (from its merge base with the base, to the head) adds or changes, as the
 * outputs `pr`, `scenarios`, `head`, `automatic` ("true") and `record`
 * ("true" when there are any); on a dispatch, its inputs passed through, to
 * record. An app whose CI records videos is never recorded here on
 * pull_request: pr-gif-attach.yml takes its CI run.
 *
 * @param {Record<string, string | undefined>} env EVENT_NAME, PR, SCENARIOS,
 *   SIDE_BY_SIDE, AFTER_ONLY; on pull_request BASE_SHA and HEAD_SHA
 * @param {(args: string[]) => string} git
 * @param {(line: string) => void} log
 */
function changedStep(env, git, log) {
  if (env.EVENT_NAME !== 'pull_request') {
    const inputs = parseInputs(env);
    setOutputs(env, {
      pr: inputs.pr,
      scenarios: inputs.scenarios.join(' '),
      head: '',
      automatic: false,
      record: true,
    });
    log(`pr-gif: run by hand for #${inputs.pr}`);
    return 0;
  }
  const { pr } = parseInputs({ PR: env.PR });
  const base = env.BASE_SHA ?? '';
  const head = env.HEAD_SHA ?? '';
  if (!SHA.test(base) || !SHA.test(head)) {
    throw new Error("pr-gif: BASE_SHA and HEAD_SHA are the PR event's commit SHAs");
  }
  const settings = loadSettings(appRoot());
  let files = /** @type {string[]} */ ([]);
  if (settings.source === 'web' && settings.scenarios) {
    const from = git(['merge-base', base, head]).trim();
    files = changedScenarios(
      parseNameStatus(git(['diff', '--name-status', '--no-renames', '-z', from, head])),
      settings.scenarios,
      settings.source,
    );
  }
  setOutputs(env, {
    pr,
    scenarios: files.join(' '),
    head,
    automatic: true,
    record: files.length > 0,
  });
  log(
    files.length > 0
      ? `pr-gif: #${pr} changes ${files.join(', ')}: recording them`
      : settings.source === 'web'
        ? `pr-gif: #${pr} changes no scenario in ${settings.scenarios ?? '(gif.scenarios unset)'}: nothing to record`
        : `pr-gif: this app's CI records its scenarios: pr-gif-attach.yml takes its run`,
  );
  return 0;
}

/**
 * The check step, on workflow_run: reads the finished run from the event
 * (GITHUB_EVENT_PATH) and its PR through the API with the Actions token,
 * decides (screenRun, checkRun), writes the outputs `go`, `record`, `pr`,
 * `head`, `scenarios` (names, comma-separated), `artifact-run` (the run
 * holding a web app's GIFs; empty for sift's, made in this run),
 * `run-url` (the run a failed recording is linked to) and `report`, and
 * sets the PR GIFs status a fork's PR or a recording gets now. It never
 * reads the PR's code: only main's checkout, for the settings.
 *
 * @param {Record<string, string | undefined>} env
 * @param {(args: string[]) => string} api
 * @param {(line: string) => void} log
 */
function checkStep(env, api, log) {
  const repo = env.GITHUB_REPOSITORY ?? '';
  const event = /** @type {{ workflow_run?: WorkflowRun }} */ (
    JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'))
  );
  const run = event.workflow_run;
  if (!run) throw new Error('pr-gif: check runs on a workflow_run event');
  /** @param {string} why */
  const stop = (why) => {
    log(`pr-gif: nothing to do: ${why}`);
    setOutputs(env, { go: false, record: false, report: false, pr: '', head: run.head_sha });
    return 0;
  };
  const screened = screenRun(run, repo);
  if ('ignore' in screened) return stop(screened.ignore);
  const { fork } = screened;
  /** @type {Pull | undefined} */
  let pull;
  if (fork) {
    // GitHub leaves a fork's run without its PR: find it by its branch.
    const owner = run.head_repository?.owner?.login ?? '';
    const label = encodeURIComponent(`${owner}:${run.head_branch ?? ''}`);
    /** @type {Pull[]} */
    const open = JSON.parse(api([`repos/${repo}/pulls?state=open&head=${label}&per_page=100`]));
    pull = open.find((p) => p.head.sha === run.head_sha);
  } else {
    const number = run.pull_requests?.[0]?.number;
    if (number) pull = JSON.parse(api([`repos/${repo}/pulls/${number}`]));
  }
  if (!pull) return stop(`no open PR has ${run.head_sha.slice(0, 7)} as its head`);
  const settings = loadSettings(appRoot());
  const changes = settings.scenarios
    ? parseApiFiles(
        api([
          '--paginate',
          `repos/${repo}/pulls/${pull.number}/files?per_page=100`,
          '--jq',
          '.[] | {filename, status}',
        ]),
      )
    : [];
  const changed = changedScenarios(changes, settings.scenarios, settings.source);
  // A web app's run says whether it recorded: its record job ran.
  const recorded =
    settings.source === 'web' &&
    /** @type {{ jobs: { name: string; conclusion: string | null }[] }} */ (
      JSON.parse(api([`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`]))
    ).jobs.some((job) => RECORD_JOB.test(job.name) && job.conclusion !== 'skipped');
  const verdict = checkRun({ run, pull, repo, fork, changed, source: settings.source, recorded });
  log(`pr-gif: ${verdict.why}`);
  const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
  const thisRun = `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID ?? ''}`;
  const web = settings.source === 'web';
  setOutputs(env, {
    go: verdict.go,
    record: verdict.record,
    report: verdict.record,
    pr: verdict.go ? pull.number : '',
    head: run.head_sha,
    scenarios: verdict.names.join(','),
    'artifact-run': web ? run.id : '',
    'run-url': web ? run.html_url : thisRun,
  });
  if (verdict.status) {
    api([
      '-X',
      'POST',
      `repos/${repo}/statuses/${run.head_sha}`,
      '-f',
      `state=${verdict.status.state}`,
      '-f',
      `context=${STATUS_CONTEXT}`,
      '-f',
      `description=${verdict.status.description}`,
      '-f',
      `target_url=${fork && web ? run.html_url : thisRun}`,
    ]);
  }
  return 0;
}

/**
 * The record step: records each scenario (recordRuns), then writes the
 * manifest. A web scenario's name is its folder's, the one cli.mjs made
 * (a scenario may name itself), or else its file's.
 *
 * @param {Record<string, string | undefined>} env
 * @param {Context} context
 * @param {(line: string) => void} log
 */
function recordStep(env, context, log) {
  const root = appRoot();
  const { source } = loadSettings(root);
  const inputs = parseInputs(env);
  const runs = recordRuns(source, inputs);
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const run =
    context.run ??
    ((/** @type {string[]} */ args) =>
      spawnSync(process.execPath, [cli, ...args], {
        stdio: 'inherit',
        env: { ...env, APP_ROOT: root },
      }).status ?? 1);
  const out = path.join(root, OUT);
  /** @type {string[]} */
  const recorded = [];
  /** @type {string[]} */
  const failed = [];
  /** @type {string[]} */
  const failedRuns = [];
  for (const args of runs) {
    const before = folders(out);
    const ok = run(args) === 0;
    if (!ok) failedRuns.push(args[0]);
    if (source === 'ci-videos') continue;
    const made = [...folders(out)].filter((name) => !before.has(name));
    const name = made[0] ?? fileScenarioName(args[0]);
    (ok ? recorded : failed).push(name);
  }
  if (source === 'ci-videos') {
    // One run for every scenario: what it left is what recorded.
    const left = existsSync(out) ? collectGifs(root).map((s) => s.name) : [];
    recorded.push(...left);
    if (inputs.automatic) failed.push(...inputs.scenarios.filter((n) => !left.includes(n)));
  }
  const head =
    inputs.head ??
    (context.git ?? ((args) => output('git', args, root)))(['rev-parse', 'HEAD']).trim();
  mkdirSync(out, { recursive: true });
  writeFileSync(
    path.join(out, MANIFEST),
    writeManifest({
      pr: Number(inputs.pr),
      head,
      automatic: inputs.automatic,
      recorded: recorded.filter(isName),
      failed: failed.filter(isName),
    }),
  );
  if (failedRuns.length > 0 || failed.length > 0) {
    // A web run is one scenario's file; sift's one run is the PR's number.
    const which = (
      source === 'web' && failedRuns.length > 0
        ? failedRuns
        : failed.length > 0
          ? failed
          : failedRuns
    ).join(', ');
    log(
      inputs.automatic
        ? `pr-gif: ${which} failed; what recorded will be attached, and the rest marked not updated`
        : `pr-gif: ${which} failed; nothing will be attached`,
    );
    return 1;
  }
  return 0;
}

/**
 * The attach step. A run by hand (pr-gif.yml) attaches every scenario's
 * GIFs, each block saying the commit the manifest names. An automatic one
 * (pr-gif-attach.yml; AUTOMATIC "true", with HEAD_SHA the commit check
 * read, RECORD whether the PR changes a scenario, SCENARIOS those names and
 * RUN_URL the recording's run) checks the manifest is this PR's at that
 * commit, attaches what recorded, marks what failed, drops the automatic
 * blocks the PR no longer changes, and stops before any edit once the PR's
 * head has moved on. It fails when a scenario failed, so the PR GIFs status
 * says so.
 *
 * @param {Record<string, string | undefined>} env
 * @param {Context} context
 * @param {string} cwd
 * @param {(line: string) => void} log
 */
async function attachStep(env, context, cwd, log) {
  const {
    pr,
    automatic,
    head,
    scenarios: named,
  } = parseInputs({
    PR: env.PR,
    AUTOMATIC: env.AUTOMATIC,
    HEAD_SHA: env.HEAD_SHA,
    SCENARIOS: env.SCENARIOS,
  });
  const repo = env.GITHUB_REPOSITORY ?? '';
  if (!env.GH_TOKEN) {
    throw new Error(
      "pr-gif: no token to attach with: pass the app's BOT_PR_TOKEN as the workflow's bot-token secret (the Actions token can't attach)",
    );
  }
  const manifestFile = path.join(cwd, OUT, MANIFEST);
  const manifest = existsSync(manifestFile) ? readManifest(readFileSync(manifestFile)) : null;
  if (manifest && String(manifest.pr) !== pr) {
    throw new Error(`pr-gif: the artifact is #${manifest.pr}'s, not #${pr}'s`);
  }
  /** @type {Published[]} */
  let scenarios;
  /** @type {string[]} */
  let failed = [];
  /** @type {(body: string) => string} */
  let change;
  if (!automatic) {
    scenarios = collectGifs(cwd);
    if (scenarios.length === 0) throw new Error(`pr-gif: no GIFs in ${OUT}/ to attach`);
    const line = manifest ? `${recordedLine(manifest.head)}\n\n` : '';
    change = (body) =>
      scenarios.reduce((b, s) => withBlock(b, s.name, line + attachmentTable(s)), body);
  } else {
    if (!head) throw new Error('pr-gif: an automatic attach needs HEAD_SHA, the commit checked');
    const record = env.RECORD === 'true';
    if (record && manifest) {
      if (manifest.head !== head) {
        throw new Error(
          `pr-gif: the artifact was recorded at ${manifest.head.slice(0, 7)}, not ${head.slice(0, 7)}`,
        );
      }
      if (!manifest.automatic) throw new Error("pr-gif: the artifact is a run by hand's");
    }
    const found = record && manifest && existsSync(path.join(cwd, OUT)) ? collectGifs(cwd) : [];
    scenarios = found.filter((s) => manifest?.recorded.includes(s.name));
    const attached = scenarios.map((s) => s.name);
    failed = manifest
      ? [...manifest.failed, ...manifest.recorded.filter((n) => !attached.includes(n))]
      : record
        ? named.filter(isName)
        : [];
    // Which blocks to keep is known from a manifest, or when nothing is
    // recorded; a recording that left none can't say, so nothing is dropped.
    const keep = manifest ? [...manifest.recorded, ...manifest.failed] : record ? null : [];
    change = automaticChange({ scenarios, failed, keep, head, runUrl: env.RUN_URL ?? '' });
    if (record && !manifest) log(`pr-gif: the recording left no ${MANIFEST}: nothing to attach`);
  }
  /** @type {string} */
  let body;
  try {
    body = attachToPr({ repo, pr, cwd, scenarios, log, headSha: head, change });
  } catch (error) {
    if (!(error instanceof HeadMovedError)) throw error;
    log(error.message);
    return 0;
  }
  if (scenarios.length > 0) {
    await waitForLinks(attachmentLinks(body, scenarios), {
      fetch: context.fetch,
      wait: context.wait,
    });
    log(`pr-gif: every attached GIF answers: https://github.com/${repo}/pull/${pr}`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    const link = `[#${pr}](https://github.com/${repo}/pull/${pr})`;
    const lines = [];
    if (scenarios.length > 0) {
      lines.push(
        `Attached the GIFs of ${scenarios.map((s) => `\`${s.name}\``).join(', ')} to ${link}.`,
      );
    }
    if (failed.length > 0) {
      lines.push(`Not updated, as recording failed: ${failed.map((n) => `\`${n}\``).join(', ')}.`);
    }
    if (lines.length === 0) lines.push(`Brought ${link}'s GIF blocks up to date.`);
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
  if (failed.length > 0) {
    log(`pr-gif: not updated, as recording failed: ${failed.join(', ')}`);
    return 1;
  }
  return 0;
}

/**
 * Runs one step; returns its exit code.
 *
 * @param {readonly string[]} argv
 * @param {Context} [context]
 */
export async function main(argv, context = {}) {
  const { env = process.env, cwd = process.cwd(), log = console.log } = context;
  const [step] = argv;
  if (step === 'source') {
    const { source } = loadSettings(appRoot());
    log(`gif.source: ${source}`);
    setOutputs(env, { source });
    return 0;
  }
  if (step === 'gh') {
    checkGh();
    return 0;
  }
  if (step === 'changed') {
    return changedStep(env, context.git ?? ((args) => output('git', args, appRoot())), log);
  }
  if (step === 'check') {
    return checkStep(env, context.api ?? ((args) => output('gh', ['api', ...args])), log);
  }
  if (step === 'record') return recordStep(env, context, log);
  if (step === 'attach') return attachStep(env, context, cwd, log);
  throw new Error('usage: node gif/workflow.mjs source | changed | record | check | gh | attach');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (/** @type {unknown} */ error) => {
      console.error(error instanceof Error ? error.message : error);
      if (error instanceof Error && error.cause instanceof Error)
        console.error(error.cause.message);
      process.exitCode = 1;
    },
  );
}
