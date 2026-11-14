// The GitHub CLI a tool needs to upload a PR's attachments: `gh pr edit
// --attach` came in gh 2.99.0 (1 September 2026), and an older gh doesn't
// know the flag. A floor, not a pin: any newer gh is fine, so the pins rule
// doesn't apply, and nothing is downloaded here. Its callers are the attach
// jobs (gif/attach/action.yml, pictures/attach/action.yml), on the runner,
// whose image's gh may lag: each action upgrades it from the runner's own
// apt source when this says it's too old:
//
//   node lib/gh.mjs check   exits 1, saying what to install, unless gh can attach
//
// Also commandIn and ghIn, which run gh (or git) in a folder for the tools
// that edit a description with it (lib/attach.mjs).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The first gh with `--attach` on `gh pr create`, `gh pr edit` and `gh pr comment`. */
export const MIN_GH = '2.99.0';

/**
 * A version's numbers from `gh --version`'s first line, or null.
 *
 * @param {string} text
 * @returns {[number, number, number] | null}
 */
export function ghVersion(text) {
  const m = /gh version (\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Whether `have` is at least `want`.
 *
 * @param {readonly number[]} have
 * @param {readonly number[]} want
 */
function atLeast(have, want) {
  for (let i = 0; i < want.length; i++) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return true;
}

/**
 * Throws, saying what to install, unless gh is MIN_GH or newer.
 *
 * @param {() => string} [version] what `gh --version` prints
 */
export function checkGh(version = ghVersionText) {
  let text = '';
  try {
    text = version();
  } catch {
    // No gh at all: the message below covers it.
  }
  const have = ghVersion(text);
  const want = /** @type {[number, number, number]} */ (ghVersion(`gh version ${MIN_GH}`));
  if (!have || !atLeast(have, want)) {
    const shows = have ? `yours is ${have.join('.')}` : 'none found';
    throw new Error(
      `install gh ≥ 2.99, which can attach files to a PR (\`gh --version\` shows yours; ${shows})`,
    );
  }
}

/** What the installed gh's `--version` prints. */
function ghVersionText() {
  const result = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result.stdout ?? '';
}

/**
 * @typedef {(args: string[], options?: { env?: Record<string, string | undefined>; allowFail?: boolean }) => { status: number | null; stdout: string; stderr: string }} Command
 *   Runs a command in a folder with these arguments.
 */

/**
 * A command run in `cwd`, returning what it printed; a failure throws
 * unless `allowFail`.
 *
 * @param {string} command
 * @param {string} cwd
 * @returns {Command}
 */
export function commandIn(command, cwd) {
  return (args, { env, allowFail = false } = {}) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
    const out = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    if (out.status !== 0 && !allowFail) {
      throw new Error(
        `${command} ${args[0]} failed: ${(out.stderr || out.stdout).trim().slice(-800)}`,
      );
    }
    return out;
  };
}

/**
 * gh in `cwd`, returning what it printed; a failure throws unless
 * `allowFail`.
 *
 * @param {string} cwd
 * @returns {Command}
 */
export function ghIn(cwd) {
  return commandIn('gh', cwd);
}

/**
 * The command line; returns its exit code.
 *
 * @param {readonly string[]} argv
 * @param {{ version?: () => string; error?: (line: string) => void }} [context]
 */
export function main(argv, { version, error = console.error } = {}) {
  if (argv[0] !== 'check' || argv.length !== 1) {
    error('usage: node lib/gh.mjs check');
    return 2;
  }
  try {
    checkGh(version);
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
