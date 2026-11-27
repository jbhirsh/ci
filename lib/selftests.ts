// The tools' self-tests, which CI's "Against <app>" jobs run against each
// app's `main` (.github/workflows/ci.yml): each `<tool>/selftest.mjs` or
// `<tool>/selftest.ts`, for every tool in TOOLS.
//
// The list is written down so that a self-test can't stop running unseen: a
// glob over `*/selftest.mjs` runs nothing for a tool whose self-test was
// renamed (to `.ts` while the repo moves to TypeScript, ci#155) or deleted,
// and the job still passes. Here a listed tool with no self-test, one with
// both extensions, and a self-test the list doesn't name (or of another
// extension, which CI wouldn't run) each fail the job, naming the fix.
//
//   node lib/selftests.ts   prints the self-tests to run, one a line,
//                            relative to this repo; exits 1 on a problem
//
// Node's built-ins only: the Against jobs install no devDependency.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The tools with a self-test, by directory. */
export const TOOLS = [
  'audit',
  'autofix',
  'commits',
  'gif',
  'mutation',
  'pins',
  'pr-changes',
  'pr-template',
  'probe',
  'readme-screenshots',
  'review',
  'semgrep',
  'sync',
  'unmeasured',
  'visual-review',
];

/** The extensions CI runs a self-test with. */
export const EXTENSIONS = ['.mjs', '.ts'];

const LIST = 'lib/selftests.ts';

/**
 * Every `selftest.<ext>` under a folder (node_modules and dot folders
 * aside), relative to it.
 *
 * @param {string} root
 * @param {string} [dir]
 * @returns {string[]}
 */
function selftestsUnder(root, dir = '') {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name.startsWith('.')
        ? []
        : selftestsUnder(root, rel);
    }
    return dir && /^selftest\.[^.]+$/.test(entry.name) ? [rel] : [];
  });
}

/**
 * The self-tests in a checkout of this repo, and what's wrong with them.
 *
 * @param {string} root this repo's checkout
 * @param {readonly string[]} [tools]
 * @returns {{ files: string[], problems: string[] }} `files` relative to root
 */
export function findSelftests(root, tools = TOOLS) {
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const problems = [];
  for (const tool of tools) {
    const found = EXTENSIONS.map((extension) => `${tool}/selftest${extension}`).filter((file) =>
      existsSync(path.join(root, file)),
    );
    if (found.length === 0) {
      problems.push(
        `${tool}: no selftest.mjs or selftest.ts, so CI would run no self-test for it: restore it, or take ${tool} out of TOOLS in ${LIST}`,
      );
    } else if (found.length > 1) {
      problems.push(`${tool}: both ${found.join(' and ')}: keep one`);
    }
    files.push(...found);
  }
  for (const file of selftestsUnder(root).sort()) {
    const [tool, ...rest] = file.split('/');
    if (!EXTENSIONS.includes(path.extname(file))) {
      problems.push(`${file}: CI runs only selftest.mjs or selftest.ts: rename it`);
    } else if (rest.length > 1) {
      problems.push(`${file}: CI runs only a tool's own <tool>/selftest.mjs or .ts: move it there`);
    } else if (!tools.includes(tool)) {
      problems.push(`${file}: ${tool} is not in TOOLS in ${LIST}: add it, so CI runs it`);
    }
  }
  return { files, problems };
}

/* c8 ignore start: the CLI's lines, run by CI */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { files, problems } = findSelftests(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  );
  for (const problem of problems) console.error(`selftests: ${problem}`);
  if (problems.length === 0) console.log(files.join('\n'));
  process.exitCode = problems.length === 0 ? 0 : 1;
}
/* c8 ignore stop */
