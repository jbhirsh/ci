// Checks that every validation command an app's `autofix` settings list is
// one that app can run, so the lists can't rot silently when a script is
// renamed or a step removed (selftest.ts runs it against each app).
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

/** What an app can run, as the checks read it. */
export type AppFacts = {
  /** package.json's scripts */
  scripts: Set<string>;
  /** the bins its locked packages install */
  bins: Set<string>;
  /** its Makefile's targets */
  makeTargets: Set<string>;
  /** a repo file's text, or null */
  read: (file: string) => string | null;
};

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Reads an app checkout's scripts, bins and make targets.
 */
export function appFacts(root: string): AppFacts {
  const read = (file: string) => readOrNull(path.join(root, file));
  const pkg: unknown = JSON.parse(read('package.json') ?? '{}');
  const scripts = new Set(Object.keys((pkg as { scripts?: Record<string, string> }).scripts ?? {}));
  const bins: Set<string> = new Set();
  const lock = read('package-lock.json');
  if (lock !== null) {
    const parsed: {
      packages?: Record<string, { bin?: Record<string, string> | string; name?: string }>;
    } = JSON.parse(lock);
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
 * @param part one `&&`-joined part, e.g. `npm run lint`
 * @param facts
 */
export function commandProblem(part: string, facts: AppFacts): string | null {
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

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Why a validation entry names something the app can't run, or null.
 *
 * @param entry one item of `ciFixChecks` / `reviewFixChecks`
 * @param facts
 */
export function entryProblem(entry: string, facts: AppFacts): string | null {
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
