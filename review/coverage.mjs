// Claude Review's coverage check: which changed files the review never read.
// The prompt (prompt.md) says to read every changed file's diff, tests
// included, yet a review once passed a PR having opened only its source
// files and seen the tests in `--stat` (sift #188, twice). This reads the
// review's own tool calls from claude-code-action's execution file, so the
// action can send it back for what it missed (followup.md) and fail the
// check on a file still unread after that.
//
// CLI: `node coverage.mjs <execution file>...`, the PR's changed files on
// stdin, one per line; prints each changed file no pass read, one per line.
// BASE_REF names the PR's base branch (default `main`), REPO_DIR the checkout
// (default the working directory), SKIP the app's extra skippable globs, one
// per line (`review.skip` in `.github/ci.json`, read by settings.mjs),
// CARRIED the files an earlier review read whose part of the diff hasn't
// changed since, one per line (carry.mjs): those needn't be read again;
// REMOVED the files the PR deletes, one per line (below). A missing or
// unreadable execution file counts as a review that read nothing.
//
// Strict on purpose: a call it can't be sure of reads nothing. The cost of
// a wrong "unread" is a second pass that reads the file again; the cost of
// a wrong "read" is a skipped test passing review. A file counts as read
// only through a call that succeeded and came back whole (or whose saved
// full output was then opened), and that was one of:
//   - one `git diff` with a range from origin/<base>, naming the file or a
//     folder holding it after `--` (no path: every file);
//   - `git show HEAD:<path>`, the file as the PR leaves it;
//   - `gh pr diff` (every file);
//   - Read of the file itself, whole (no offset or limit).
// A cut-off output's saved file counts once a Read opened it, in parts or
// whole: a diff too long for one Read must be read in parts.
// A file the PR deletes is covered by any of those, or by a listing of the
// PR's diff that shows it deleted, by its whole path: `git diff` with the
// same range and `--name-status` or `--summary` (no path, or one holding the
// file), run in the checkout itself. Its old contents are gone from what the
// PR leaves, so reading them whole only spent turns (four of the six files
// BoardGames #307's check failed on were deleted ones); the prompt still has
// the review look at why a test was deleted. A `--stat` or `--numstat` of
// the same kind covers it too, but only as the line's one command and where
// its output holds the file's stat line by its whole path: a stat line shows
// the deletion's size, yet `--stat` shortens a long path (`.../x.ts`), which
// could be any file, and another command's output could hold such a line.
// A stat cut to a preview counts for nothing, its saved file opened or not.
// Other flags are allowed only from a short list that can't leave a deleted
// file out: renames, `-z`, colour, a `--diff-filter` holding `D` (and no
// `d`). Not `--name-only`, which doesn't say the file went, `--shortstat`,
// which names no file, nor `-S`, `-G`, `--relative` or `-R`, which drop or
// flip files.
// A command line is plain commands joined by `&&`, after an optional
// leading `cd <dir>` to the checkout (a `cd` elsewhere reads nothing); each
// command is judged alone, as if run by itself.
// Nothing else: no `;`, `||`, redirect, substitution, subshell, comment or
// second line, so a grep pattern or a heredoc that mentions `git diff`
// reads nothing. A pipe is allowed only into a reader such as `tail`, and
// a piped command counts for nothing, since `| tail -60` can cut a file
// out. Once a line holds more than one command, every command in it must
// be one that changes nothing a later one prints (`git diff`, `git log`,
// `cat`, `tail` and the like: READ_ONLY): a `git checkout` or second `cd`
// would make the next `git diff` another diff, so that line reads nothing.
// BoardGames #307 failed on a deleted file whose `--name-status` line came
// after `git diff --stat ... | tail -60 &&`, when any chain read nothing.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readAll } from '../lib/actions.mjs';

/** Lockfiles and binaries may always be skipped, as the prompt allows. */
const SKIPPABLE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Podfile\.lock)$|\.(png|jpe?g|gif|webp|ico|pdf|svg|ttf|otf|woff2?|mp4|mov)$/i;
/** Flags that leave the diff out of the output, or cut it down. */
const NO_DIFF_FLAGS = new Set([
  '-s',
  '--no-patch',
  '--quiet',
  '--stat',
  '--numstat',
  '--shortstat',
  '--name-only',
  '--name-status',
  '--summary',
  '--raw',
  '--check',
  '--dirstat',
  '--compact-summary',
  '--exit-code',
]);
/** Prefixes of such flags: `--stat-count=1` and `--dirstat-by-file` too. */
const NO_DIFF_PREFIXES = ['--stat', '--dirstat', '--output=', '--format=', '--pretty=', '-U0'];
/** Flags that print a deleted file as deleted, by its whole path. */
const LISTING_FLAGS = new Set(['--name-status', '--summary']);
/**
 * Flags that print a file's size of change, a deletion's included: they
 * cover it only where the output shows its whole path (`--stat` shortens).
 */
const STAT_FLAGS = new Set(['--stat', '--numstat']);
/** The only other flags a listing may have: none leaves a deleted file out. */
const LISTING_ALLOWED =
  /^(-M\d*%?|-C\d*%?|--find-renames(=\d+%?)?|--find-copies(=\d+%?)?|--no-renames|-z|--no-color|--color=never|--no-ext-diff|--diff-filter=[^d]*D[^d]*)$/;
/** Shell syntax no command line here may hold, outside quotes. */
const COMPOUND = /[;<>`\n()]/;
/**
 * Commands that change nothing a later command in the line prints, so a
 * line of several may hold them: `git <sub>` by its subcommand, `gh pr
 * <sub>`, or the tool alone. Not `sort` or `uniq`, which can write a file.
 */
const READ_ONLY = {
  git: new Set(['diff', 'show', 'log', 'status', 'ls-files', 'merge-base', 'rev-parse', 'blame']),
  gh: new Set(['pr diff', 'pr view']),
  tools: new Set(['cat', 'head', 'tail', 'wc', 'grep', 'ls', 'echo', 'nl', 'cut', 'true']),
};
/** The header Claude Code puts on output it cut to a preview. */
const CUT_OFF = /^\s*(<persisted-output>|Output too large)/i;
const SAVED_TO = /saved to:?\s*(\S+)/i;

/**
 * @typedef {object} ToolCall
 * @property {string} name
 * @property {Record<string, unknown>} input
 * @property {string} [result] The call's result as text, when the execution file had one.
 * @property {boolean} [failed] The call failed (denied, cancelled, an error).
 */

/**
 * A glob (`*` within a folder, `**` across folders) as a regular expression
 * over a whole repo-relative path. It matches inside dot folders (`**` covers
 * `.github/`), which lib/match.mjs doesn't, so an app's review `skip` globs
 * keep their meaning: that's why review has its own.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      // `**/` matches no folder or any number of them; a trailing `**` anything.
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/**
 * The files a review must read: the changed ones less the skippable (and
 * less what matches one of the app's `skip` globs: its generated files).
 *
 * @param {string[]} changed
 * @param {string[]} [skip]
 * @returns {string[]}
 */
export function filesToRead(changed, skip = []) {
  const extra = skip.map(globToRegExp);
  return changed.filter((f) => f && !SKIPPABLE.test(f) && !extra.some((re) => re.test(f)));
}

/**
 * @typedef {object} CommandLine
 * @property {string | null} cd The leading `cd`'s directory, if any.
 * @property {string[][]} commands The words of each command the line runs
 *   alone (not in a pipe), in order: the ones that may count as reads.
 * @property {boolean} alone The line runs one command (after its `cd`).
 */

/**
 * A command line's commands, quotes honoured: plain commands joined by `&&`,
 * after an optional leading `cd <dir>`, a command possibly piped into
 * another. Null for anything else, or for a line of several commands of
 * which one could change what a later one prints (READ_ONLY).
 *
 * @param {string} command
 * @returns {CommandLine | null}
 */
export function commandLine(command) {
  const line = parseLine(command);
  if (!line) return null;
  const all = line.parts.flat();
  if (all.length > 1 && !all.every(readOnly)) return null;
  const commands = line.parts.filter((stages) => stages.length === 1).map((stages) => stages[0]);
  return { cd: line.cd, commands, alone: all.length === 1 };
}

/**
 * A command line's `&&` parts, each a list of pipe stages, each a list of
 * words, after its leading `cd <dir>` (its directory apart): null for any
 * other shell syntax, or a `cd` anywhere else.
 *
 * @param {string} command
 * @returns {{ cd: string | null, parts: string[][][] } | null}
 */
function parseLine(command) {
  /** @type {string[][][]} */
  const parts = [[[]]];
  let word = '';
  /** @type {'"' | "'" | null} */
  let quote = null;
  let inWord = false;
  const chars = [...command.trim()];
  const stage = () => {
    const stages = parts[parts.length - 1];
    return stages[stages.length - 1];
  };
  const endWord = () => {
    if (inWord) stage().push(word);
    word = '';
    inWord = false;
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (quote) {
      // A variable or substitution, even in double quotes: can't judge it.
      if (quote === '"' && (ch === '$' || ch === '`')) return null;
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch) && ch !== '\n') {
      endWord();
    } else if (ch === '&') {
      // `&&` only: a lone `&` runs something in the background.
      if (chars[i + 1] !== '&') return null;
      i++;
      endWord();
      parts.push([[]]);
    } else if (ch === '|') {
      // A pipe, not `||`, which runs its right side only when the left failed.
      if (chars[i + 1] === '|') return null;
      endWord();
      parts[parts.length - 1].push([]);
    } else if (COMPOUND.test(ch) || ch === '$' || (ch === '#' && !inWord)) {
      // `#` starting a word starts a comment: the shell drops the rest.
      return null;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) return null;
  endWord();
  if (parts.some((stages) => stages.some((words) => words.length === 0))) return null;
  // A leading `cd <dir>` alone; a `cd` anywhere else moves later commands.
  const first = parts[0];
  const cd =
    first.length === 1 && first[0][0] === 'cd' && first[0].length === 2 ? first[0][1] : null;
  const rest = cd === null ? parts : parts.slice(1);
  if (rest.length === 0 || rest.flat().some((words) => words[0] === 'cd')) return null;
  return { cd, parts: rest };
}

/**
 * Whether a command changes nothing a later command in its line prints.
 *
 * @param {string[]} words
 * @returns {boolean}
 */
function readOnly([tool, sub, next, ...rest]) {
  if (tool === 'git') {
    // `--output=<file>` writes a file, which could be one of git's own.
    return READ_ONLY.git.has(sub) && ![next, ...rest].some((w) => w?.startsWith('--output'));
  }
  if (tool === 'gh') return READ_ONLY.gh.has(`${sub} ${next}`);
  return READ_ONLY.tools.has(tool);
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which of the files one call read (none: an empty list).
 *
 * @param {string[]} words
 * @param {string[]} files
 * @param {string} base
 * @returns {string[]}
 */
function filesReadBy(words, files, base) {
  const [tool, sub, ...rest] = words;
  if (tool === 'gh' && sub === 'pr' && rest[0] === 'diff') {
    return rest.some((w) => w.startsWith('--name') || w === '--stat') ? [] : files;
  }
  if (tool !== 'git' || (sub !== 'diff' && sub !== 'show')) return [];
  if (rest.some((w) => NO_DIFF_FLAGS.has(w) || NO_DIFF_PREFIXES.some((p) => w.startsWith(p))))
    return [];
  const dashes = rest.indexOf('--');
  const args = dashes === -1 ? rest : rest.slice(0, dashes);
  const paths = dashes === -1 ? [] : rest.slice(dashes + 1);
  const revisions = args.filter((w) => !w.startsWith('-'));
  if (sub === 'show') {
    // Only `git show HEAD:<path>`: plain `git show HEAD` on a pull
    // request's merge commit prints no diff at all.
    const shown = revisions
      .filter((w) => w.startsWith('HEAD:'))
      .map((w) => w.slice('HEAD:'.length));
    return files.filter((f) => shown.includes(f));
  }
  return inPrDiff(revisions, paths, files, base);
}

/**
 * Which of the files a `git diff` with these revisions and paths covers:
 * none unless the range is the PR's own.
 *
 * @param {string[]} revisions
 * @param {string[]} paths
 * @param {string[]} files
 * @param {string} base
 * @returns {string[]}
 */
function inPrDiff(revisions, paths, files, base) {
  // The PR's diff and nothing else: origin/<base> to HEAD, three dots or
  // two, or the two ends given apart.
  const range = revisions.join(' ');
  const ours = new RegExp(`^origin/${escapeRegExp(base)}(\\.\\.\\.?(HEAD)?| HEAD)$`);
  if (!ours.test(range)) return [];
  if (paths.length === 0) return files;
  // A magic pathspec (`:!x`, an exclude) names no file, so reads nothing.
  const named = paths.map((p) => p.replace(/^\.\//, '').replace(/\/+$/, ''));
  return files.filter((f) =>
    named.some((p) => p === '' || p === '.' || f === p || f.startsWith(`${p}/`)),
  );
}

/**
 * Which of the deleted files one command listed with their status or size
 * (a `git diff --name-status` of the PR and the like): none for any other
 * command. A `--stat` or `--numstat` lists only the files whose stat line
 * the call's output holds by their whole path.
 *
 * @param {string[]} words
 * @param {string[]} removed
 * @param {string} base
 * @param {string | null} output The call's output, when this command is
 *   all it ran: null when other commands' output is mixed in.
 * @returns {string[]}
 */
function filesListedBy(words, removed, base, output) {
  const [tool, sub, ...rest] = words;
  if (tool !== 'git' || sub !== 'diff') return [];
  const dashes = rest.indexOf('--');
  const args = dashes === -1 ? rest : rest.slice(0, dashes);
  const paths = dashes === -1 ? [] : rest.slice(dashes + 1);
  const flags = args.filter((w) => w.startsWith('-'));
  const listed = (/** @type {string} */ w) => LISTING_FLAGS.has(w) || STAT_FLAGS.has(w);
  if (!flags.some(listed)) return [];
  if (!flags.every((w) => listed(w) || LISTING_ALLOWED.test(w))) return [];
  const revisions = args.filter((w) => !w.startsWith('-'));
  const files = inPrDiff(revisions, paths, removed, base);
  if (flags.some((w) => LISTING_FLAGS.has(w))) return files;
  return output === null ? [] : files.filter((f) => statLine(f, flags).test(output));
}

/**
 * A file's line in `--stat` (`<path> | <n> ---`) or `--numstat`
 * (`<added>\t<deleted>\t<path>`) output, by its whole path.
 *
 * @param {string} file
 * @param {string[]} flags
 * @returns {RegExp}
 */
function statLine(file, flags) {
  const path = escapeRegExp(file);
  // The leading space may be trimmed off the output's first line.
  const stat = `^ ?${path} +\\| `;
  const numstat = `^(\\d+|-)\\t(\\d+|-)\\t${path}$`;
  const shapes = [flags.includes('--stat') && stat, flags.includes('--numstat') && numstat];
  return new RegExp(shapes.filter(Boolean).join('|'), 'm');
}

/**
 * Whether a command line runs in the checkout: no leading `cd`, or one to
 * the checkout's own path. A `cd` elsewhere would read its paths from
 * there, or another repository's diff, so its line reads nothing.
 *
 * @param {string | null} cd The line's leading `cd` directory, quotes gone.
 * @param {string} repoDir
 * @returns {boolean}
 */
function inCheckout(cd, repoDir) {
  return cd === null || cd.replace(/\/+$/, '') === repoDir.replace(/\/+$/, '');
}

/**
 * Path relative to the repo, for a Read of an absolute path inside it.
 *
 * @param {string} path
 * @param {string} repoDir
 * @returns {string}
 */
function relative(path, repoDir) {
  const root = repoDir.replace(/\/+$/, '');
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path.replace(/^\.\//, '');
}

/**
 * The path a Read that worked opened, whole or (with `part`) in part.
 *
 * @param {ToolCall} call
 * @param {boolean} part
 * @returns {string | null}
 */
function readPath(call, part) {
  if (call.name !== 'Read' || call.failed || typeof call.input.file_path !== 'string') return null;
  if (!part && (call.input.offset !== undefined || call.input.limit !== undefined)) return null;
  return call.input.file_path;
}

/**
 * The changed files the review never read, in the order given.
 *
 * @param {string[]} changed
 * @param {ToolCall[]} calls
 * @param {{ repoDir: string, base?: string, skip?: string[], carried?: string[], removed?: string[] }} options
 *   removed: the changed files the PR deletes, which a listing covers
 * @returns {string[]}
 */
export function unreadFiles(
  changed,
  calls,
  { repoDir, base = 'main', skip = [], carried = [], removed = [] },
) {
  const done = new Set(carried);
  const needed = filesToRead(changed, skip).filter((f) => !done.has(f));
  const gone = new Set(removed);
  const deleted = needed.filter((f) => gone.has(f));
  /** @param {boolean} part */
  const paths = (part) =>
    calls.map((c) => readPath(c, part)).filter(/** @returns {p is string} */ (p) => p !== null);
  // A saved full output too long for one Read is read in parts.
  const opened = new Set(paths(true));
  const read = new Set(paths(false).map((p) => relative(p, repoDir)));
  for (const call of calls) {
    if (call.name !== 'Bash' || call.failed || typeof call.input.command !== 'string') continue;
    const result = call.result ?? '';
    const cut = CUT_OFF.test(result);
    if (cut) {
      // The saved path is in the header, not anywhere in the diff.
      const saved = SAVED_TO.exec(result.slice(0, 400))?.[1];
      if (!saved || !opened.has(saved)) continue;
    }
    const line = commandLine(call.input.command);
    if (!line || !inCheckout(line.cd, repoDir)) continue;
    // A stat line counts only from a whole output that is one command's.
    const output = !cut && line.alone ? result : null;
    for (const words of line.commands) {
      for (const file of filesReadBy(words, needed, base)) read.add(file);
      for (const file of filesListedBy(words, deleted, base, output)) read.add(file);
    }
  }
  return needed.filter((f) => !read.has(f));
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    /** @type {unknown[]} */
    const parts = content;
    return parts
      .map((part) => {
        const text =
          part && typeof part === 'object' ? /** @type {{ text?: unknown }} */ (part).text : '';
        return typeof text === 'string' ? text : '';
      })
      .join('\n');
  }
  return '';
}

/**
 * The tool calls in claude-code-action's execution file (the SDK's message
 * list), each with its result. Unknown shapes are skipped, not fatal.
 *
 * @param {unknown} execution
 * @returns {ToolCall[]}
 */
export function toolCalls(execution) {
  /** @type {{ id: string, call: ToolCall }[]} */
  const uses = [];
  /** @type {Map<string, { text: string, failed: boolean }>} */
  const results = new Map();
  /** @param {unknown} node */
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = /** @type {Record<string, unknown>} */ (node);
    if (
      o.type === 'tool_use' &&
      typeof o.name === 'string' &&
      o.input &&
      typeof o.input === 'object'
    ) {
      uses.push({
        id: String(o.id ?? ''),
        call: { name: o.name, input: /** @type {Record<string, unknown>} */ (o.input) },
      });
    } else if (o.type === 'tool_result' && typeof o.tool_use_id === 'string') {
      results.set(o.tool_use_id, { text: resultText(o.content), failed: o.is_error === true });
    }
    Object.values(o).forEach(visit);
  };
  visit(execution);
  return uses.map(({ id, call }) => {
    const result = results.get(id);
    // No result at all: cancelled before it ran.
    return result
      ? { ...call, result: result.text, failed: result.failed }
      : { ...call, failed: true };
  });
}

/**
 * The CLI: the unread files, given the changed ones (stdin's text), the
 * execution files and the environment.
 *
 * @param {string[]} executionFiles
 * @param {string} stdin
 * @param {Record<string, string | undefined>} env
 * @param {(message: string) => void} warn
 * @returns {string[]}
 */
export function main(executionFiles, stdin, env, warn) {
  const changed = stdin
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const calls = executionFiles.flatMap((file) => {
    try {
      /** @type {unknown} */
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return toolCalls(parsed);
    } catch {
      warn(`Could not read the execution file ${file}.\n`);
      return [];
    }
  });
  /** @param {string | undefined} value */
  const lines = (value) =>
    (value ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  return unreadFiles(changed, calls, {
    repoDir: env.REPO_DIR || process.cwd(),
    base: env.BASE_REF || 'main',
    skip: lines(env.SKIP),
    carried: lines(env.CARRIED),
    removed: lines(env.REMOVED),
  });
}

/* c8 ignore start: the CLI's three lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const unread = main(process.argv.slice(2), await readAll(), process.env, (m) =>
    process.stderr.write(m),
  );
  if (unread.length > 0) process.stdout.write(`${unread.join('\n')}\n`);
}
/* c8 ignore stop */
