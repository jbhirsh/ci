// Checks that every validation command an app's `autofix` settings list is
// one that app can run, so the lists can't rot silently when a script is
// renamed or a step removed (selftest.mjs runs it against each app).
//
// Those lists aren't a second CI: they're autofix proving its own fix
// before it pushes, so it never pushes what CI will reject. Each app's list
// mirrors the steps of its CI that can run in the autofix job.
//
// An entry (one Markdown list item) starts with either
//   - a command in backticks, each `&&`-joined part of which must be
//     `npm run <script>` / `npm test` (a script in the app's package.json),
//     `npm ci` or `npm audit …`, `npx <bin>` (a bin some package in the
//     app's lockfile installs) or `npx <package>@<version>` (fetched),
//     `make <target>` (a target in the app's Makefile), or `git …` /
//     `test …`; or
//   - `the "<step>" step of` a workflow file in backticks, for a step with
//     no single command (its `run:` script is copied), which must name a
//     step of that workflow;
// and may go on with a note for the fixer.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * What an app can run, as the checks read it.
 *
 * @typedef {object} AppFacts
 * @property {Set<string>} scripts package.json's scripts
 * @property {Set<string>} bins the bins its locked packages install
 * @property {Set<string>} makeTargets its Makefile's targets
 * @property {(file: string) => string | null} read a repo file's text, or null
 */

/**
 * @param {string} file
 * @returns {string | null}
 */
function readOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Reads an app checkout's scripts, bins and make targets.
 *
 * @param {string} root
 * @returns {AppFacts}
 */
export function appFacts(root) {
  const read = (/** @type {string} */ file) => readOrNull(path.join(root, file));
  /** @type {unknown} */
  const pkg = JSON.parse(read('package.json') ?? '{}');
  const scripts = new Set(
    Object.keys(/** @type {{ scripts?: Record<string, string> }} */ (pkg).scripts ?? {}),
  );
  /** @type {Set<string>} */
  const bins = new Set();
  const lock = read('package-lock.json');
  if (lock !== null) {
    /** @type {{ packages?: Record<string, { bin?: Record<string, string> | string, name?: string }> }} */
    const parsed = JSON.parse(lock);
    for (const [where, entry] of Object.entries(parsed.packages ?? {})) {
      if (typeof entry.bin === 'string')
        bins.add(entry.name ?? where.replace(/^.*node_modules\//, ''));
      else for (const name of Object.keys(entry.bin ?? {})) bins.add(name);
    }
  } else {
    try {
      for (const name of readdirSync(path.join(root, 'node_modules', '.bin'))) bins.add(name);
    } catch {
      // Neither: no bins to know of.
    }
  }
  const makefile = read('Makefile') ?? '';
  const makeTargets = new Set(
    [...makefile.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((match) => match[1]),
  );
  return { scripts, bins, makeTargets, read };
}

/**
 * Why one part of a command can't run in the app, or null when it can.
 *
 * @param {string} part one `&&`-joined part, e.g. `npm run lint`
 * @param {AppFacts} facts
 * @returns {string | null}
 */
export function commandProblem(part, facts) {
  const words = part.trim().split(/\s+/).filter(Boolean);
  const [tool = '', ...rest] = words;
  const args = rest.filter((word) => !word.startsWith('-'));
  if (tool === 'git' || tool === 'test') return null;
  if (tool === 'npm') {
    const [sub = '', script = ''] = args;
    if (sub === 'ci' || sub === 'audit') return null;
    if (sub === 'test')
      return facts.scripts.has('test') ? null : 'package.json has no "test" script';
    if (sub === 'run' || sub === 'run-script') {
      return facts.scripts.has(script) ? null : `package.json has no "${script}" script`;
    }
    return `"npm ${sub}" isn't one of npm run, npm test, npm ci or npm audit`;
  }
  if (tool === 'npx') {
    const [name = ''] = args;
    if (/^(@[^/@\s]+\/)?[^/@\s]+@\S+$/.test(name)) return null;
    return facts.bins.has(name) ? null : `no package in the lockfile installs "${name}" for npx`;
  }
  if (tool === 'make') {
    const [target = ''] = args;
    return facts.makeTargets.has(target) ? null : `the Makefile has no "${target}" target`;
  }
  return `"${tool}" isn't a command autofix knows (npm, npx, make, git, test)`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Why a validation entry names something the app can't run, or null.
 *
 * @param {string} entry one item of `ciFixChecks` / `reviewFixChecks`
 * @param {AppFacts} facts
 * @returns {string | null}
 */
export function entryProblem(entry, facts) {
  const step = /^the "([^"]+)" step of `([^`]+)`/.exec(entry);
  if (step) {
    const [, name, file] = step;
    const text = facts.read(file);
    if (text === null) return `${file} doesn't exist`;
    const line = new RegExp(`^\\s*-?\\s*name:\\s*(["']?)${escape(name)}\\1\\s*(#.*)?$`, 'm');
    return line.test(text) ? null : `${file} has no step named "${name}"`;
  }
  const command = /^`([^`]+)`/.exec(entry);
  if (!command) {
    return 'an entry must start with a command in backticks or the "<step>" step of `<workflow>`';
  }
  for (const part of command[1].split('&&')) {
    const problem = commandProblem(part, facts);
    if (problem) return problem;
  }
  return null;
}
