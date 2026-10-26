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
// per line (`review.skip` in `.github/ci.json`, read by settings.mjs). A
// missing or unreadable execution file counts as a review that read nothing.
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
// The command may start with `cd <dir> &&` and is otherwise one plain
// command: no pipe, redirect, chain, substitution or second line, so a
// grep pattern or a heredoc that mentions `git diff` reads nothing.

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
const NO_DIFF_PREFIXES = ['--stat=', '--dirstat=', '--output=', '--format=', '--pretty=', '-U0'];
/** Shell syntax that makes a command more than one plain command. */
const COMPOUND = /[|;&<>`\n]/;
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
 * over a whole repo-relative path.
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
 * A plain command's words, quotes honoured, or null when it is more than
 * one plain command. A leading `cd <dir> &&` is allowed and dropped.
 *
 * @param {string} command
 * @returns {string[] | null}
 */
export function plainWords(command) {
  const body = command.trim().replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, '');
  /** @type {string[]} */
  const words = [];
  let word = '';
  /** @type {'"' | "'" | null} */
  let quote = null;
  let inWord = false;
  for (const ch of body) {
    if (quote) {
      // A variable or substitution, even in double quotes: can't judge it.
      if (quote === '"' && (ch === '$' || ch === '`')) return null;
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch) && ch !== '\n') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else if (COMPOUND.test(ch) || ch === '$') {
      return null;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) words.push(word);
  return words;
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
 * @param {{ repoDir: string, base?: string, skip?: string[] }} options
 * @returns {string[]}
 */
export function unreadFiles(changed, calls, { repoDir, base = 'main', skip = [] }) {
  const needed = filesToRead(changed, skip);
  /** @param {boolean} part */
  const paths = (part) =>
    calls.map((c) => readPath(c, part)).filter(/** @returns {p is string} */ (p) => p !== null);
  // A saved full output too long for one Read is read in parts.
  const opened = new Set(paths(true));
  const read = new Set(paths(false).map((p) => relative(p, repoDir)));
  for (const call of calls) {
    if (call.name !== 'Bash' || call.failed || typeof call.input.command !== 'string') continue;
    const result = call.result ?? '';
    if (CUT_OFF.test(result)) {
      // The saved path is in the header, not anywhere in the diff.
      const saved = SAVED_TO.exec(result.slice(0, 400))?.[1];
      if (!saved || !opened.has(saved)) continue;
    }
    const words = plainWords(call.input.command);
    if (words) for (const file of filesReadBy(words, needed, base)) read.add(file);
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
  const skip = (env.SKIP ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return unreadFiles(changed, calls, {
    repoDir: env.REPO_DIR || process.cwd(),
    base: env.BASE_REF || 'main',
    skip,
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
