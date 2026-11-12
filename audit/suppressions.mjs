// What hides a finding from knip, so the weekly audit can refuse it as lint
// refuses an eslint-disable (jbhirsh/ci#34; the shared rules' "Fix
// weekly-audit findings rather than suppressing them"). knip has no option to
// show or switch off its ignores, so this reads where they live: the app's
// knip config, and the JSDoc tags in its code.
//
//   node suppressions.mjs [--annotate]
//
// prints what it found and exits 1 when anything is, from the app's checkout
// (audit/suppressions/action.yml runs it as a step of each app's CI job, with
// --annotate for `::error` lines on the PR's diff); audit/run.mjs's knip
// check lists the same at the top of the Dead code issue and fails the
// weekly run on it.
//
// Refused in the config, at the root and under each `workspaces.<name>`:
//   - every key starting `ignore` (ignore, ignoreFiles, ignoreDependencies,
//     ignoreBinaries, ignoreIssues, …, and any later knip adds);
//   - `rules` setting any issue type to other than "error";
//   - `include`, `exclude` and `tags`, which narrow what knip reports;
//   - `cycles.allow`;
//   - a `!` glob in `project`, a plugin's included, which takes files out
//     as `ignore` does;
//   - a plugin set to false, or whose `config` names no tracked file, either
//     of which stops the plugin reading what tells knip a package is used.
// Refused in the code: the tags knip skips an export for, `@public`, `@beta`
// and `@alias` (knip's isAlwaysIgnored), found by knip's own rule
// (buildJSDocTagLookup, knip 6.43): in any block comment, and in a `//`
// comment that starts its own line, a tag running from `@` to the first
// character outside [A-Za-z0-9_]. The comments come from parsing each file
// with the app's typescript, so the app must be installed. Unlike knip, it
// flags such a tag above no export too, so a prose mention goes as well.
// `@internal` hides an export only under --production, which the audit never
// passes.
//
// Allowed, as they say where code starts or how to read it: entry, project
// (without `!`), paths, compilers, preprocessors, includeEntryExports, the
// treat…AsErrors options, workspaces as structure, and a plugin's entry,
// project, true, or a config naming real files. `entry` stays a broad escape
// hatch on purpose (knip reports no export of an entry file, and an entry
// glob of everything would report no unused file); review polices it, not
// this. A knip.ts or knip.js config can't be read without running it, so it
// is refused with a pointer to knip.jsonc.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appRoot, requireFromApp } from '../lib/app.mjs';
import { parseJsonc } from './jsonc.mjs';

/** The config files knip reads, in the order it looks (knip's KNIP_CONFIG_LOCATIONS). */
export const KNIP_CONFIG_LOCATIONS = [
  'knip.json',
  'knip.jsonc',
  '.knip.json',
  '.knip.jsonc',
  'knip.ts',
  'knip.js',
  'knip.config.ts',
  'knip.config.js',
];

/** The files knip reads tags in (knip's DEFAULT_EXTENSIONS). */
const SOURCE = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/;

/** The tags knip skips an export for. */
const TAGS = new Set(['@public', '@beta', '@alias']);

/** knip's options that are no plugin's name. */
const OPTIONS = new Set([
  '$schema',
  'entry',
  'project',
  'paths',
  'include',
  'exclude',
  'rules',
  'tags',
  'cycles',
  'workspaces',
  'compilers',
  'syncCompilers',
  'asyncCompilers',
  'preprocessor',
  'preprocessorOptions',
  'includeEntryExports',
  'treatConfigHintsAsErrors',
  'treatTagHintsAsErrors',
]);

const DELETE_EXPORT =
  'delete each unused export or member, or drop `export` where only its own file uses it.';

/**
 * How to fix each refused option.
 *
 * @param {string} key
 */
function fixFor(key) {
  switch (key) {
    case 'ignoreDependencies':
      return "delete it. A package knip calls unused is either used where knip can't see it (load it a way knip reads: an import, or a package script) or really unused (uninstall it). One it calls unlisted goes in package.json.";
    case 'ignore':
    case 'ignoreFiles':
      return 'delete it: delete each file it names, or reach it from an `entry`.';
    case 'ignoreBinaries':
    case 'ignoreGlobalBinaries':
      return "delete it, and list each binary's package in devDependencies.";
    case 'ignoreUnresolved':
      return 'delete it, and fix each import path, or the `paths` alias it needs.';
    case 'ignoreMembers':
    case 'ignoreExportsUsedInFile':
    case 'ignoreIssues':
    case 'tags':
      return `delete it, and ${DELETE_EXPORT}`;
    case 'ignoreWorkspaces':
      return 'delete it, and give each workspace its `entry`.';
    case 'rules':
    case 'include':
    case 'exclude':
      return 'delete it, so knip reports every issue type at full weight.';
    case 'cycles.allow':
      return 'delete it, and break each cycle.';
    case 'project':
      return 'delete the negation, so knip reads every file.';
    default:
      return key.startsWith('ignore')
        ? 'delete it, and fix what it hides.'
        : 'delete it, so the plugin reads its config.';
  }
}

/**
 * @typedef {object} Suppression
 * @property {string} file the config or source file
 * @property {number[]} lines where (1-based; empty when unknown)
 * @property {string} option the option's path, or the tag
 * @property {string[]} values what it names, when that says more
 * @property {string} fix
 */

/** @param {unknown} value */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value */
const strings = (value) =>
  (Array.isArray(value) ? value : [value]).filter((v) => typeof v === 'string');

/**
 * A value as a short list for the message.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function shown(value) {
  if (Array.isArray(value))
    return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
  if (isRecord(value)) return Object.keys(/** @type {object} */ (value));
  return [JSON.stringify(value)];
}

/**
 * Every suppression in a knip config, as `{ path, values, fix }`, `path`
 * naming the option's keys from the root. `tracked` is the repository's
 * files, to tell a plugin config that names a real file from one that names
 * nothing.
 *
 * @param {unknown} config the parsed config, untrusted in shape
 * @param {string[]} [tracked]
 * @returns {{ path: string[], values: string[], fix: string }[]}
 */
export function knipSuppressions(config, tracked = []) {
  /** @type {{ path: string[], values: string[], fix: string }[]} */
  const found = [];
  /**
   * @param {unknown} scope
   * @param {string[]} at
   * @param {string} dir the workspace's folder, for plugin configs
   */
  const scan = (scope, at, dir) => {
    if (!isRecord(scope)) return;
    const fields = /** @type {Record<string, unknown>} */ (scope);
    for (const [key, value] of Object.entries(fields)) {
      const where = [...at, key];
      if (key.startsWith('ignore') || key === 'include' || key === 'exclude' || key === 'tags') {
        found.push({ path: where, values: shown(value), fix: fixFor(key) });
      } else if (key === 'rules') {
        const loose = isRecord(value)
          ? Object.entries(/** @type {Record<string, unknown>} */ (value))
              .filter(([, v]) => v !== 'error')
              .map(([type, v]) => `${type}: ${JSON.stringify(v)}`)
          : shown(value);
        if (loose.length > 0) found.push({ path: where, values: loose, fix: fixFor('rules') });
      } else if (key === 'cycles') {
        if (isRecord(value) && 'allow' in /** @type {object} */ (value)) {
          const allow = /** @type {Record<string, unknown>} */ (value).allow;
          found.push({
            path: [...where, 'allow'],
            values: shown(allow),
            fix: fixFor('cycles.allow'),
          });
        }
      } else if (key === 'project') {
        const negated = strings(value).filter((glob) => glob.startsWith('!'));
        if (negated.length > 0)
          found.push({ path: where, values: negated, fix: fixFor('project') });
      } else if (key === 'workspaces') {
        if (isRecord(value)) {
          for (const [name, workspace] of Object.entries(/** @type {object} */ (value))) {
            scan(workspace, [...where, name], path.posix.join(dir, name));
          }
        }
      } else if (!OPTIONS.has(key)) {
        const plugin = pluginSuppression(value, dir, tracked);
        if (plugin) {
          const negation = plugin[0].startsWith('project: ');
          found.push({ path: where, values: plugin, fix: fixFor(negation ? 'project' : key) });
        }
      }
    }
  };
  scan(config, [], '.');
  return found;
}

/**
 * What a plugin's setting hides, or null when it hides nothing: false, a `!`
 * glob in its `project`, or a `config` (the setting itself, when it's globs)
 * that names no tracked file.
 *
 * @param {unknown} value
 * @param {string} dir
 * @param {string[]} tracked
 * @returns {string[] | null}
 */
function pluginSuppression(value, dir, tracked) {
  if (value === false) return ['false'];
  if (isRecord(value)) {
    const negated = strings(/** @type {Record<string, unknown>} */ (value).project).filter((glob) =>
      glob.startsWith('!'),
    );
    if (negated.length > 0) return negated.map((glob) => `project: ${glob}`);
  }
  const config =
    typeof value === 'string' || Array.isArray(value)
      ? value
      : isRecord(value)
        ? /** @type {Record<string, unknown>} */ (value).config
        : undefined;
  if (config === undefined) return null;
  const globs = strings(config).map((glob) => path.posix.normalize(path.posix.join(dir, glob)));
  const real = tracked.some((file) => globs.some((glob) => path.posix.matchesGlob(file, glob)));
  return real ? null : [`config: ${JSON.stringify(config)}, which names no tracked file`];
}

/** @typedef {typeof import('@typescript/typescript6')} TypeScript */

/**
 * Each tag knip skips an export for, in the comments of one source file,
 * with its line. The file is parsed with TypeScript (the app's), so a quote
 * in a regex, JSX text or a template's `${}` never puts a comment out of
 * step, as it would for a hand-rolled scan.
 *
 * @param {string} text
 * @param {TypeScript} ts
 * @param {string} [fileName] for its extension: JSX and plain JS parse as such
 * @returns {{ tag: string, line: number }[]}
 */
export function suppressionTags(text, ts, fileName = 'file.ts') {
  const kind = fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : fileName.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : /\.[mc]?js$/.test(fileName)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  /** @type {Map<number, import('@typescript/typescript6').CommentRange>} */
  const comments = new Map();
  /** @type {[number, number][]} JSX text, which the comment scan would misread */
  const jsxText = [];
  const add = (
    /** @type {import('@typescript/typescript6').CommentRange[] | undefined} */ ranges,
  ) => {
    for (const range of ranges ?? []) comments.set(range.pos, range);
  };
  const visit = (/** @type {import('@typescript/typescript6').Node} */ node) => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push([node.pos, node.end]);
    add(ts.getLeadingCommentRanges(text, node.pos));
    add(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);

  /** @type {{ tag: string, line: number }[]} */
  const found = [];
  const ranges = [...comments.values()]
    .filter(({ pos }) => !jsxText.some(([start, end]) => pos >= start && pos < end))
    .sort((a, b) => a.pos - b.pos);
  for (const { pos, end, kind: type } of ranges) {
    if (type === ts.SyntaxKind.SingleLineCommentTrivia) {
      const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
      if (!/^[ \t]*$/.test(text.slice(lineStart, pos))) continue;
    }
    let at = text.indexOf('@', pos);
    while (at !== -1 && at < end) {
      let stop = at + 1;
      while (stop < end && /[A-Za-z0-9_]/.test(text[stop])) stop++;
      const tag = text.slice(at, stop);
      if (TAGS.has(tag))
        found.push({ tag, line: source.getLineAndCharacterOfPosition(at).line + 1 });
      at = text.indexOf('@', stop);
    }
  }
  return found;
}

/**
 * The line of each object key in a JSON(C) text, by its path of keys (joined
 * with NUL), comments and strings read as such: the first place each path
 * appears.
 *
 * @param {string} text
 * @returns {Map<string, number>}
 */
export function keyLines(text) {
  /** @type {Map<string, number>} */
  const lines = new Map();
  /** @type {{ array: boolean, key: string, index: number }[]} */
  const stack = [];
  let line = 1;
  let i = 0;
  const skipTrivia = () => {
    for (;;) {
      if (text[i] === '\n') line++;
      if (/\s/.test(text[i] ?? '')) i++;
      else if (text.startsWith('//', i)) while (i < text.length && text[i] !== '\n') i++;
      else if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        const stop = end === -1 ? text.length : end + 2;
        for (let k = i; k < stop; k++) if (text[k] === '\n') line++;
        i = stop;
      } else return;
    }
  };
  while (i < text.length) {
    skipTrivia();
    const c = text[i];
    if (c === undefined) break;
    if (c === '"') {
      const start = i;
      const at = line;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      const raw = text.slice(start, i);
      const top = stack.at(-1);
      skipTrivia();
      if (top && !top.array && text[i] === ':') {
        /** @type {unknown} */
        const key = JSON.parse(raw);
        top.key = String(key);
        const keys = stack.map((frame) => (frame.array ? String(frame.index) : frame.key));
        const id = keys.join('\0');
        if (!lines.has(id)) lines.set(id, at);
      }
      continue;
    }
    if (c === '{' || c === '[') stack.push({ array: c === '[', key: '', index: 0 });
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ',') {
      const top = stack.at(-1);
      if (top?.array) top.index++;
    }
    i++;
  }
  return lines;
}

/**
 * The app's knip config: the first of knip's locations that exists, else
 * package.json's `knip` key, else none.
 *
 * @param {string} root
 * @returns {{ file: string, keys: string[], text: string, config: unknown } | null}
 */
export function readKnipConfig(root) {
  const file = KNIP_CONFIG_LOCATIONS.find((name) => existsSync(path.join(root, name)));
  if (file && /\.(ts|js)$/.test(file)) {
    throw new Error(
      `${file} can't be read without running it, so the audit can't check what it hides: move the config to knip.jsonc.`,
    );
  }
  const read = (/** @type {string} */ name) => readFileSync(path.join(root, name), 'utf8');
  const parse = (/** @type {string} */ name, /** @type {string} */ text) => {
    try {
      return parseJsonc(text);
    } catch (error) {
      throw new Error(`${name} doesn't parse: ${/** @type {Error} */ (error).message}`, {
        cause: error,
      });
    }
  };
  if (file) {
    const text = read(file);
    return { file, keys: [], text, config: parse(file, text) };
  }
  if (!existsSync(path.join(root, 'package.json'))) return null;
  const text = read('package.json');
  const pkg = parse('package.json', text);
  if (!isRecord(pkg) || !('knip' in /** @type {object} */ (pkg))) return null;
  return {
    file: 'package.json',
    keys: ['knip'],
    text,
    config: /** @type {Record<string, unknown>} */ (pkg).knip,
  };
}

/**
 * The app's own TypeScript, which every app here installs (its JavaScript
 * API: the `typescript` package, TypeScript 6's where the app aliases it).
 *
 * @param {string} root
 * @returns {TypeScript}
 */
function appTypeScript(root) {
  try {
    return /** @type {TypeScript} */ (requireFromApp('typescript', root));
  } catch (error) {
    throw new Error(
      "the app's typescript isn't installed: the scan reads comments with it, so it runs after the app's npm ci",
      { cause: error },
    );
  }
}

/**
 * Every suppression in the app at `root`: its knip config's, then its code's.
 *
 * @param {string} root
 * @param {{ listFiles?: (root: string) => string[], typescript?: () => TypeScript }} [using]
 *   the repository's tracked files, and the TypeScript that reads its code
 * @returns {{ config: string, list: Suppression[] }}
 */
export function suppressions(
  root,
  { listFiles = gitFiles, typescript = () => appTypeScript(root) } = {},
) {
  const tracked = listFiles(root);
  const knip = readKnipConfig(root);
  /** @type {Suppression[]} */
  const list = [];
  if (knip) {
    const lines = keyLines(knip.text);
    for (const s of knipSuppressions(knip.config, tracked)) {
      const line = lines.get([...knip.keys, ...s.path].join('\0'));
      list.push({
        file: knip.file,
        lines: line ? [line] : [],
        option: s.path.join('.'),
        values: s.values,
        fix: s.fix,
      });
    }
  }
  const sources = tracked.filter((name) => SOURCE.test(name) && existsSync(path.join(root, name)));
  const ts = sources.length > 0 ? typescript() : undefined;
  for (const file of sources) {
    /** @type {Map<string, number[]>} */
    const byTag = new Map();
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const { tag, line } of suppressionTags(text, /** @type {TypeScript} */ (ts), file)) {
      byTag.set(tag, [...(byTag.get(tag) ?? []), line]);
    }
    for (const [tag, lines] of byTag) {
      list.push({
        file,
        lines,
        option: tag,
        values: [],
        fix: `delete the tag. Export only what something in the repo imports (drop \`export\` where only its own file uses it), or make the file that imports it an \`entry\`.`,
      });
    }
  }
  return { config: knip?.file ?? 'knip’s config', list };
}

/**
 * The repository's tracked files.
 *
 * @param {string} root
 */
function gitFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/**
 * Text as a Markdown code span, so a glob's `**` isn't emphasis and a tag's
 * `@public` mentions no GitHub account in the issue.
 *
 * @param {string} text
 */
const code = (text) => {
  // A run of backticks inside needs a longer fence, and spaces inside it.
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return longest > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
};

/**
 * What the suppressions are and how to fix each: the PR step's failure, the
 * weekly run's error and the top of its Dead code issue.
 *
 * @param {{ config: string, list: Suppression[] }} found
 */
export function suppressionsMessage({ config, list }) {
  const inConfig = list.some((s) => s.file === config);
  const inCode = list.some((s) => s.file !== config);
  const subject = [inConfig && config, inCode && 'the code'].filter(Boolean).join(' and ');
  return [
    `${subject} ${inConfig && inCode ? 'hide' : 'hides'} what the weekly audit should find. Fix each finding instead of suppressing it (shared rules, "Fix weekly-audit findings rather than suppressing them"):`,
    ...list.map((s) => {
      const where = s.lines.length > 0 ? `${s.file}:${s.lines.join(', ')}` : s.file;
      const values = s.values.length > 0 ? ` (${s.values.map(code).join(', ')})` : '';
      return `- ${code(where)} ${code(s.option)}${values}: ${s.fix}`;
    }),
    '`entry`, `project` and `paths` stay allowed: they tell knip where code starts.',
  ].join('\n');
}

/**
 * GitHub's `::error` lines, one per place, for the PR's diff.
 *
 * @param {Suppression[]} list
 */
export function annotations(list) {
  // GitHub's workflow-command escaping: the message's, and a property's,
  // which also escapes the `,` and `:` that would end it.
  const escape = (/** @type {string} */ text) =>
    text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const property = (/** @type {string} */ text) =>
    escape(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return list.flatMap((s) =>
    (s.lines.length > 0 ? s.lines : [1]).map(
      (line) =>
        `::error file=${property(s.file)},line=${line}::${escape(`${s.option} hides knip findings: ${s.fix}`)}`,
    ),
  );
}

/**
 * Runs the scan on the app and returns the exit code.
 *
 * @param {string[]} argv
 * @param {string} [root]
 * @param {(line: string) => void} [log]
 */
export function cli(argv, root = appRoot(), log = console.log) {
  const found = suppressions(root);
  if (found.list.length === 0) {
    log(`No knip suppressions in ${found.config} or the code.`);
    return 0;
  }
  if (argv.includes('--annotate')) for (const line of annotations(found.list)) log(line);
  log(suppressionsMessage(found));
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cli(process.argv.slice(2));
}
