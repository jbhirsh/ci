// The GitHub CLI a tool needs to upload attachments: `gh pr edit --attach`
// came in gh 2.99.0 (1 September 2026), and an older gh doesn't know the
// flag. `gh issue edit --attach` came later: ci#144's V10 found it on the
// runner's gh 2.104.0, so that is the floor for an issue, and the check also
// asks `gh issue edit --help` for the flag rather than trust a version alone.
// A floor, not a pin: any newer gh is fine, so the pins rule doesn't apply,
// and nothing is downloaded here. Its callers are the attach jobs
// (gif/attach/action.yml, pictures/attach/action.yml,
// visual-review/attach/action.yml), on the runner, whose image's gh may lag:
// each action upgrades it from the runner's own apt source when this says
// it's too old:
//
//   node lib/gh.ts check           exits 1, saying what to install, unless gh can attach to a PR
//   node lib/gh.ts check --issue   the same for an issue (visual review's mockups only)
//
// Also commandIn and ghIn, which run gh (or git) in a folder for the tools
// that edit a description with it (lib/attach.ts).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The first gh with `--attach` on `gh pr create`, `gh pr edit` and `gh pr comment`. */
export const MIN_GH = '2.99.0';

/** The gh ci#144's V10 found `gh issue edit --attach` working on. */
export const MIN_GH_ISSUE = '2.104.0';

/**
 * A version's numbers from `gh --version`'s first line, or null.
 */
export function ghVersion(text: string): [number, number, number] | null {
  const m = /gh version (\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Whether `have` is at least `want`.
 */
function atLeast(have: readonly number[], want: readonly number[]) {
  for (let i = 0; i < want.length; i++) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return true;
}

/**
 * Throws, saying what to install, unless gh is MIN_GH or newer; with
 * `issue`, unless it is MIN_GH_ISSUE or newer and `gh issue edit --help`
 * lists `--attach`.
 *
 * @param version what `gh --version` prints
 * @param options help: what
 *   `gh issue edit --help` prints
 */
export function checkGh(
  version: () => string = ghVersionText,
  { issue = false, help = issueEditHelp }: { issue?: boolean; help?: () => string } = {},
) {
  let text = '';
  try {
    text = version();
  } catch {
    // No gh at all: the message below covers it.
  }
  const have = ghVersion(text);
  const floor = issue ? MIN_GH_ISSUE : MIN_GH;
  const want = ghVersion(`gh version ${floor}`) as [number, number, number];
  const shows = have ? `yours is ${have.join('.')}` : 'none found';
  const install = issue
    ? `install gh ≥ ${floor.replace(/\.0$/, '')}, which can attach files to an issue`
    : 'install gh ≥ 2.99, which can attach files to a PR';
  if (!have || !atLeast(have, want)) {
    throw new Error(`${install} (\`gh --version\` shows yours; ${shows})`);
  }
  if (issue && !/(^|\s)--attach\b/m.test(help())) {
    throw new Error(`${install} (yours, ${have.join('.')}, has no \`gh issue edit --attach\`)`);
  }
}

/** What the installed gh's `gh issue edit --help` prints. */
function issueEditHelp() {
  const result = spawnSync('gh', ['issue', 'edit', '--help'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/** What the installed gh's `--version` prints. */
function ghVersionText() {
  const result = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result.stdout ?? '';
}

/** Runs a command in a folder with these arguments. */
export type Command = (
  args: string[],
  options?: { env?: Record<string, string | undefined>; allowFail?: boolean },
) => { status: number | null; stdout: string; stderr: string };

/**
 * A command run in `cwd`, returning what it printed; a failure throws
 * unless `allowFail`.
 */
export function commandIn(command: string, cwd: string): Command {
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
 */
export function ghIn(cwd: string): Command {
  return commandIn('gh', cwd);
}

/**
 * The command line; returns its exit code.
 */
export function main(
  argv: readonly string[],
  {
    version,
    help,
    error = console.error,
  }: { version?: () => string; help?: () => string; error?: (line: string) => void } = {},
) {
  const issue = argv[1] === '--issue';
  if (argv[0] !== 'check' || argv.length !== (issue ? 2 : 1)) {
    error('usage: node lib/gh.ts check [--issue]');
    return 2;
  }
  try {
    checkGh(version, { issue, help });
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
