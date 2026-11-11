// The steps of the pr-gif.yml workflow (.github/workflows/pr-gif.yml), which
// records a PR's before/after GIFs in Actions and attaches them to the PR,
// so nothing goes in git. Its two actions run these:
//
//   node gif/workflow.mjs source   the app's `gif.source` ("web" or
//                                  "ci-videos"), as the step output `source`
//   node gif/workflow.mjs record   records the GIFs into pr-gif/<scenario>/
//   node gif/workflow.mjs gh       fails unless gh can attach (lib/gh.mjs)
//   node gif/workflow.mjs attach   attaches pr-gif/'s GIFs to the PR
//
// from the app's checkout (record) or the artifact's folder (attach), with
// the workflow's inputs in the environment: PR (its number), SCENARIOS (the
// scenario files, separated by spaces, commas or lines), SIDE_BY_SIDE and
// AFTER_ONLY ("true" or "false").
//
// record runs cli.mjs once a scenario, without --dir, so each one's GIFs are
// left in pr-gif/<scenario name>/ as a run on the owner's machine leaves
// them; for an app whose CI records videos (sift), it runs videos.mjs once
// with --out pr-gif, which takes every scenario the PR's run recorded, so
// SCENARIOS must be empty. Every scenario is recorded even after one fails;
// the step fails if any did, and nothing is attached, but what did record
// is still uploaded to look through.
//
// attach is its own job, the only one holding the token that may attach
// (BOT_PR_TOKEN: GitHub refuses the Actions token), and it runs none of the
// PR's code: it reads only the artifact's folder names and GIFs, refusing a
// name that isn't a plain scenario name, a file that isn't a GIF, and one
// over the 10 MB GitHub attaches.
// publish.mjs's attachToPr writes the tables into the description and
// uploads; then each new link is fetched, signed out, until it answers 200,
// for up to a minute, since an edited-in attachment goes live a moment after
// the edit (ci#33's trial T1).

import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { appRoot } from '../lib/app.mjs';
import { checkGh } from '../lib/gh.mjs';
import { attachToPr, findBlock, gifNames, shownFiles } from './publish.mjs';
import { loadSettings } from './settings.mjs';

/** @typedef {import('./publish.mjs').Published} Published */

/** Where record leaves the GIFs and attach reads them, from the step's folder. */
export const OUT = 'pr-gif';

/** The largest image GitHub takes as an attachment (its docs: 10 MB). */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;

/**
 * @typedef {object} Inputs The workflow's inputs.
 * @property {string} pr
 * @property {string[]} scenarios
 * @property {boolean} sideBySide
 * @property {boolean} afterOnly
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
  if (sideBySide && afterOnly)
    throw new Error('pr-gif: side-by-side needs a before: drop after-only');
  return { pr, scenarios, sideBySide, afterOnly };
}

/**
 * The command lines cli.mjs is run with, one a run.
 *
 * @param {'web' | 'ci-videos'} source the app's `gif.source`
 * @param {Inputs} inputs
 * @returns {string[][]}
 */
export function recordRuns(source, { pr, scenarios, sideBySide, afterOnly }) {
  const both = sideBySide ? ['--side-by-side'] : [];
  if (source === 'ci-videos') {
    if (scenarios.length > 0) {
      throw new Error(
        "pr-gif: this app's CI records every scenario on the PR's run, so leave scenarios empty",
      );
    }
    return [[pr, '--out', OUT, ...both, ...(afterOnly ? ['--no-before'] : [])]];
  }
  if (scenarios.length === 0) throw new Error('pr-gif: name the scenario files to record');
  return scenarios.map((file) => [file, ...both, ...(afterOnly ? ['--after-only'] : [])]);
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
 * Runs one step; returns its exit code.
 *
 * @param {readonly string[]} argv
 * @param {{ env?: Record<string, string | undefined>; cwd?: string; run?: (args: string[]) => number; log?: (line: string) => void; fetch?: typeof globalThis.fetch; wait?: (ms: number) => Promise<unknown> }} [context]
 *   run: runs cli.mjs with these arguments, returning its exit code (for tests)
 */
export async function main(argv, context = {}) {
  const { env = process.env, cwd = process.cwd(), log = console.log } = context;
  const [step] = argv;
  if (step === 'source') {
    const { source } = loadSettings(appRoot());
    log(`gif.source: ${source}`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `source=${source}\n`);
    return 0;
  }
  if (step === 'gh') {
    checkGh();
    return 0;
  }
  if (step === 'record') {
    const root = appRoot();
    const runs = recordRuns(loadSettings(root).source, parseInputs(env));
    const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
    const run =
      context.run ??
      ((/** @type {string[]} */ args) =>
        spawnSync(process.execPath, [cli, ...args], {
          stdio: 'inherit',
          env: { ...env, APP_ROOT: root },
        }).status ?? 1);
    const failed = runs.filter((args) => run(args) !== 0).map((args) => args[0]);
    if (failed.length > 0) {
      log(`pr-gif: ${failed.join(', ')} failed; nothing will be attached`);
      return 1;
    }
    return 0;
  }
  if (step === 'attach') {
    const { pr } = parseInputs({ PR: env.PR });
    const repo = env.GITHUB_REPOSITORY ?? '';
    if (!env.GH_TOKEN) {
      throw new Error(
        "pr-gif: no token to attach with: pass the app's BOT_PR_TOKEN as the workflow's bot-token secret (the Actions token can't attach)",
      );
    }
    const scenarios = collectGifs(cwd);
    if (scenarios.length === 0) throw new Error(`pr-gif: no GIFs in ${OUT}/ to attach`);
    const body = attachToPr({ repo, pr, cwd, scenarios, log });
    await waitForLinks(attachmentLinks(body, scenarios), {
      fetch: context.fetch,
      wait: context.wait,
    });
    log(`pr-gif: every attached GIF answers: https://github.com/${repo}/pull/${pr}`);
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `Attached the GIFs of ${scenarios.map((s) => `\`${s.name}\``).join(', ')} to [#${pr}](https://github.com/${repo}/pull/${pr}).\n`,
      );
    }
    return 0;
  }
  throw new Error('usage: node gif/workflow.mjs source | record | gh | attach');
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
