// Lints this repo's composite actions and reusable workflows, and an app's
// calls into them, for mistakes no other check here sees before a merge
// reaches all three apps: actionlint reads workflow files but never an
// action.yml, the unit tests run the scripts but not the YAML that wires
// them, and nothing runs an action until it's on main.
//
//   node lint/actions.mjs              this repo's action.yml files and workflows
//   node lint/actions.mjs --app <dir>  also every call an app's workflows make
//                                      into this repo (CI's "Against <app>")
//
// An action must be composite, every `run` step must say its `shell`, and no
// step may take `timeout-minutes` (composite steps can't). Its descriptions
// (its own and its inputs') may hold no `${{ }}`: the runner evaluates them
// as it loads the action, and one it can't (`cancelled()`) fails every job
// that uses it. Every
// `${{ inputs.x }}` must name a declared input, every `steps.<id>` an earlier
// step's id (an output's value, any step's), and `secrets` is out of reach
// inside an action, so it must come in as an input. A `jbhirsh/ci/<path>`
// reference must name an action or workflow here. A caller may pass only
// inputs (and, to a workflow, secrets) the target declares, and must pass
// every required one that has no default. An app's calls of the PR GIF
// workflows also meet lint/gif-callers.mjs's rules.
//
// Every path into this repo a step names must be here, so a renamed or
// moved script fails the PR that moves it rather than every app's job after
// the merge (ci#155):
//   - in an action.yml, each path built on the action's own folder
//     (`$GITHUB_ACTION_PATH/…`, `${{ github.action_path }}/…`, or an env
//     variable a step sets to one, as review's `CI_DIR`), `..` resolved;
//   - in this repo's workflows, the script each `run:` hands to `node`, and
//     each glob naming scripts (`ci/*/selftest.mjs`, to at least one file),
//     from the step's working directory, and each `uses: ./…`, wherever a
//     checkout of this repo puts it (`path:`). A plain checkout is this
//     repo's except in a reusable workflow, where it is the caller's; a path
//     into another repo's checkout, built from a variable, after a `cd` or
//     from an absolute working directory isn't checked, nor a word in a
//     comment, a heredoc or a quoted message.
// An app's own workflows aren't held to it: what they run is theirs.
//
// Exits 1 listing each problem.

import { existsSync, globSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { lintGifCallers } from './gif-callers.mjs';

/** @typedef {Record<string, unknown>} Doc */
/** @typedef {{ inputs: Map<string, boolean>, secrets: Map<string, boolean> | null }} Target */
/**
 * This repo's files, as the path checks see them: whether a path (relative
 * to the repo's root, `/`-separated) is there, and what a glob matches.
 *
 * @typedef {{ exists: (file: string) => boolean, glob: (pattern: string) => string[] }} Tree
 */

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const OWN = /^jbhirsh\/ci\/(.+?)@.+$/i;

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Every `${{ }}` expression in a value, however deep.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function expressions(value) {
  if (typeof value === 'string') return [...value.matchAll(EXPRESSION)].map((m) => m[1]);
  if (Array.isArray(value)) return value.flatMap(expressions);
  if (isObject(value)) return Object.values(/** @type {Doc} */ (value)).flatMap(expressions);
  return [];
}

/**
 * The names an expression takes from a context (`inputs`, `steps`, …), not
 * counting a property of something else (`github.event.inputs.x`).
 *
 * @param {string} expression
 * @param {string} context
 */
export function names(expression, context) {
  const re = new RegExp(`(?<![\\w.])${context}\\.([\\w-]+)`, 'g');
  return [...expression.matchAll(re)].map((m) => m[1]);
}

/**
 * The path a `uses:` names in this repo, or null for anything else.
 *
 * @param {unknown} uses
 */
export function ownPath(uses) {
  if (typeof uses !== 'string') return null;
  const match = OWN.exec(uses);
  return match ? match[1] : null;
}

/** A shell word that globs: `*`, `?`, `[…]` or `{…}`. */
const GLOB = /[*?[{]/;

/** A script by its extension, or a glob's braces of extensions. */
const SCRIPT = /\.(?:[cm]?[jt]s|\{[\w,]+\})$/;

/**
 * A glob of this repo's scripts: `.mjs`, `.cjs` or TypeScript, not `.js`,
 * which a glob names as a build's output (an app's `dist/assets/*.js`).
 */
const SCRIPT_GLOB = /\.(?:[cm]js|[cm]?ts|\{[\w,]+\})$/;

/** `${{ github.action_path }}`, as the runner writes it into a value. */
const ACTION_PATH_EXPRESSION = /^\$\{\{\s*github\.action_path\s*\}\}((?:\/[^\s"'`]*)?)$/;

/** The characters that end a path in a shell line. */
const PATH_TAIL = String.raw`((?:/(?:[^\s"'\`;|&()<>$\{\}]|\{[\w.,/*-]*\})*)?)`;

/** @param {string} text */
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The paths a value builds on an action's own folder, each with the text
 * that names it and its path from the folder (`''` for the folder itself):
 * `$GITHUB_ACTION_PATH/x`, `${GITHUB_ACTION_PATH}/x`,
 * `${{ github.action_path }}/x`, and `$VAR/x` for each variable `vars` sets
 * to a path from the folder.
 *
 * @param {string} text
 * @param {Map<string, string>} [vars] a variable's name, and its path from the folder
 * @returns {{ token: string, path: string }[]}
 */
export function actionPaths(text, vars = new Map()) {
  const bases = new Map([['GITHUB_ACTION_PATH', ''], ...vars]);
  const names = [...bases.keys()].map(escape).join('|');
  const re = new RegExp(
    String.raw`\$(?:\{(${names})\}|(${names})(?![\w])|\{\{\s*github\.action_path\s*\}\})["']?${PATH_TAIL}`,
    'g',
  );
  return [...text.matchAll(re)].map((m) => {
    const base = m[1] ?? m[2];
    return { token: m[0], path: (base === undefined ? '' : (bases.get(base) ?? '')) + m[3] };
  });
}

/** The node options that take the next word as their value. */
const VALUE_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '-C',
  '--conditions',
  '--input-type',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-name-pattern',
  '--watch-path',
  '--title',
]);

/** The node options whose value is a module it loads, checked as a script is. */
const MODULE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);

/**
 * A run line as the shell reads its words: comments, heredoc bodies and
 * quoted text holding a space (an echo's message) left out.
 *
 * @param {string} run
 */
function shellText(run) {
  /** @type {string[]} */
  const lines = [];
  /** @type {string | null} */
  let heredoc = null;
  for (const line of run.split('\n')) {
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    const kept = line.replace(/"[^"]*\s[^"]*"|'[^']*\s[^']*'/g, ' ').replace(/(^|\s)#.*$/, '$1');
    const opens = /<<-?\s*['"]?(\w+)['"]?/.exec(kept);
    if (opens) heredoc = opens[1];
    lines.push(kept);
  }
  return lines.join('\n');
}

/** The node options after which no script is named. */
const NO_SCRIPT = new Set(['-e', '--eval', '-p', '--print', '-v', '--version', '-h', '--help']);

/**
 * The scripts a shell `run:` line names, as written: each word `node` runs
 * (after its options) that looks like a path (it has a `/` or a script's
 * extension), each module it loads with `-r`, `--import` or `--loader`,
 * and each glob of scripts (`ci/*\/selftest.mjs`, not `*.js`). Comments,
 * heredoc bodies and quoted text holding a space are left out; a word keeps
 * any `$` it holds, for the caller to skip, and `${{ github.workspace }}`
 * is read as `$GITHUB_WORKSPACE`.
 *
 * @param {string} run
 * @returns {string[]}
 */
export function scriptsIn(run) {
  const words = shellText(
    run
      // An expression is one word: the workspace's as the shell names it,
      // any other a variable, which leaves its path unchecked.
      .replace(/\$\{\{\s*github\.workspace\s*\}\}/g, '$GITHUB_WORKSPACE')
      .replace(/\$\{\{[\s\S]*?\}\}/g, '$EXPRESSION'),
  )
    .split(/[\s;|&()<>]+/)
    .map((word) => word.replace(/\\$/, '').replace(/^["']+|["']+$/g, ''))
    .filter(Boolean);
  /** @type {Set<string>} */
  const found = new Set();
  /** @param {string | undefined} word */
  const add = (word) => {
    if (word !== undefined && (word.includes('/') || SCRIPT.test(word))) found.add(word);
  };
  words.forEach((word, i) => {
    if (GLOB.test(word) && SCRIPT_GLOB.test(word)) found.add(word);
    if (word !== 'node') return;
    let j = i + 1;
    while (j < words.length && words[j].startsWith('-')) {
      if (NO_SCRIPT.has(words[j])) return;
      if (MODULE_FLAGS.has(words[j])) add(words[j + 1]);
      j += VALUE_FLAGS.has(words[j]) ? 2 : 1;
    }
    add(words[j]);
  });
  return [...found];
}

/**
 * What's wrong with a path into this repo, or null: one that leaves the
 * repo, a glob matching nothing, a file or folder that isn't there.
 *
 * @param {string} where
 * @param {string} token the text that names it
 * @param {string} file the path from the repo's root
 * @param {Tree} tree
 */
function missing(where, token, file, tree) {
  const normal = path.posix.normalize(file);
  if (normal === '..' || normal.startsWith('../'))
    return `${where}: ${token}: leaves this repo (${normal})`;
  if (GLOB.test(normal)) {
    return tree.glob(normal).length > 0
      ? null
      : `${where}: ${token}: nothing in this repo matches ${normal}`;
  }
  return tree.exists(normal) ? null : `${where}: ${token}: no ${normal} in this repo`;
}

/**
 * Problems in one action.yml.
 *
 * @param {string} file its path from this repo's root
 * @param {unknown} doc
 * @param {(target: string) => boolean} exists
 * @param {Tree} tree
 * @returns {string[]}
 */
export function lintAction(file, doc, exists, tree) {
  if (!isObject(doc)) return [`${file}: not a YAML mapping`];
  const action = /** @type {Doc} */ (doc);
  const errors = [];
  for (const key of ['name', 'description']) {
    if (typeof action[key] !== 'string') errors.push(`${file}: no ${key}`);
  }
  const described = [
    ['description', action.description],
    ...Object.entries(isObject(action.inputs) ? /** @type {Doc} */ (action.inputs) : {}).map(
      ([name, input]) => [
        `input ${name}'s description`,
        isObject(input) ? /** @type {Doc} */ (input).description : undefined,
      ],
    ),
  ];
  for (const [what, text] of described) {
    if (expressions(text).length > 0) {
      errors.push(`${file}: ${what} holds \${{ }}, which the runner evaluates; write it without`);
    }
  }
  const runs = isObject(action.runs) ? /** @type {Doc} */ (action.runs) : {};
  if (runs.using !== 'composite') errors.push(`${file}: runs.using must be composite`);
  const steps = Array.isArray(runs.steps) ? runs.steps : [];
  if (steps.length === 0) errors.push(`${file}: no steps`);
  const inputs = new Set(
    isObject(action.inputs) ? Object.keys(/** @type {Doc} */ (action.inputs)) : [],
  );
  /** @type {string[]} */
  const ids = [];
  steps.forEach((/** @type {unknown} */ raw, /** @type {number} */ i) => {
    const step = isObject(raw) ? /** @type {Doc} */ (raw) : {};
    const where = `${file}: step ${i + 1}${typeof step.name === 'string' ? ` (${step.name})` : ''}`;
    if ('run' in step && typeof step.shell !== 'string') errors.push(`${where}: run without shell`);
    if ('timeout-minutes' in step)
      errors.push(`${where}: timeout-minutes is not allowed in a composite step`);
    for (const expression of expressions(step)) {
      for (const name of names(expression, 'inputs')) {
        if (!inputs.has(name)) errors.push(`${where}: inputs.${name} is not declared`);
      }
      for (const name of names(expression, 'steps')) {
        if (!ids.includes(name)) errors.push(`${where}: steps.${name} is not an earlier step`);
      }
      if (names(expression, 'secrets').length > 0) {
        errors.push(`${where}: secrets are out of reach in an action; take them as inputs`);
      }
    }
    const target = ownPath(step.uses);
    if (target !== null && !exists(target))
      errors.push(`${where}: ${String(step.uses)} names nothing here`);
    errors.push(...lintActionPaths(where, path.posix.dirname(file), step, tree));
    if (typeof step.id === 'string') ids.push(step.id);
  });
  if (isObject(action.outputs)) {
    for (const [name, output] of Object.entries(/** @type {Doc} */ (action.outputs))) {
      for (const expression of expressions(output)) {
        for (const id of names(expression, 'steps')) {
          if (!ids.includes(id))
            errors.push(`${file}: output ${name} reads steps.${id}, which no step has`);
        }
      }
    }
  }
  return errors;
}

/**
 * Problems in the paths one action step builds on its action's folder: in
 * its `run`, its `with` and its `env` (a variable set to one, as review's
 * `CI_DIR`, then counting where `run` uses it).
 *
 * @param {string} where
 * @param {string} dir the action's folder, from this repo's root
 * @param {Doc} step
 * @param {Tree} tree
 */
function lintActionPaths(where, dir, step, tree) {
  const env = isObject(step.env) ? /** @type {Doc} */ (step.env) : {};
  /** @type {Map<string, string>} */
  const vars = new Map();
  for (const [name, value] of Object.entries(env)) {
    const match = ACTION_PATH_EXPRESSION.exec(String(value).trim());
    if (match) vars.set(name, match[1]);
  }
  const texts = [
    step.run,
    ...Object.values(isObject(step.with) ? /** @type {Doc} */ (step.with) : {}),
    ...Object.values(env),
  ];
  /** @type {string[]} */
  const errors = [];
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const { token, path: rel } of actionPaths(text, vars)) {
      const problem = missing(where, token, path.posix.join(dir, rel || '.'), tree);
      if (problem !== null && !errors.includes(problem)) errors.push(problem);
    }
  }
  return errors;
}

/**
 * What a caller may pass an action or reusable workflow: each input, or
 * secret, and whether it's required with no default.
 *
 * @param {unknown} doc
 * @returns {Target | null}
 */
export function targetOf(doc) {
  if (!isObject(doc)) return null;
  const d = /** @type {Doc} */ (doc);
  /** @param {unknown} declared */
  const table = (declared) =>
    new Map(
      Object.entries(isObject(declared) ? /** @type {Doc} */ (declared) : {}).map(
        ([name, spec]) => {
          const s = isObject(spec) ? /** @type {Doc} */ (spec) : {};
          return [name, s.required === true && !('default' in s)];
        },
      ),
    );
  if (isObject(d.runs)) return { inputs: table(d.inputs), secrets: null };
  const on = isObject(d.on) ? /** @type {Doc} */ (d.on) : {};
  // `workflow_call:` with nothing under it (no inputs) parses as null.
  if (!('workflow_call' in on)) return null;
  const call = isObject(on.workflow_call) ? /** @type {Doc} */ (on.workflow_call) : {};
  return { inputs: table(call.inputs), secrets: table(call.secrets) };
}

/**
 * Problems in what one `uses:` passes its target.
 *
 * @param {string} where
 * @param {Target} target
 * @param {unknown} given `with:`
 * @param {unknown} [secrets] `secrets:`, for a reusable workflow
 */
export function lintCall(where, target, given, secrets) {
  /** @type {string[]} */
  const errors = [];
  /**
   * @param {Map<string, boolean>} declared
   * @param {unknown} passed
   * @param {string} kind
   */
  const check = (declared, passed, kind) => {
    const keys = Object.keys(isObject(passed) ? /** @type {Doc} */ (passed) : {});
    for (const key of keys)
      if (!declared.has(key)) errors.push(`${where}: passes undeclared ${kind} ${key}`);
    for (const [name, required] of declared) {
      if (required && !keys.includes(name))
        errors.push(`${where}: misses required ${kind} ${name}`);
    }
  };
  check(target.inputs, given, 'input');
  if (target.secrets && secrets !== 'inherit') check(target.secrets, secrets, 'secret');
  return errors;
}

/**
 * Problems in one workflow: references into this repo that name nothing, and
 * calls that don't fit their target.
 *
 * @param {string} file
 * @param {unknown} doc
 * @param {(target: string) => Target | null} resolve
 * @param {Set<string> | null} [appNames] the names of the app's workflows, to
 *   check what a PR GIF attach caller waits for; null for this repo's own
 * @returns {string[]}
 */
export function lintWorkflow(file, doc, resolve, appNames = null) {
  if (!isObject(doc)) return [`${file}: not a YAML mapping`];
  const jobs = isObject(/** @type {Doc} */ (doc).jobs)
    ? /** @type {Doc} */ (/** @type {Doc} */ (doc).jobs)
    : {};
  /** @type {string[]} */
  const errors = appNames ? lintGifCallers(file, /** @type {Doc} */ (doc), appNames) : [];
  for (const [id, raw] of Object.entries(jobs)) {
    const job = isObject(raw) ? /** @type {Doc} */ (raw) : {};
    /** @type {[string, Doc][]} */
    const calls = [[`${file}: job ${id}`, job]];
    if (Array.isArray(job.steps)) {
      job.steps.forEach((/** @type {unknown} */ step, /** @type {number} */ i) => {
        if (isObject(step))
          calls.push([`${file}: job ${id} step ${i + 1}`, /** @type {Doc} */ (step)]);
      });
    }
    for (const [where, call] of calls) {
      const own = ownPath(call.uses);
      if (own === null) continue;
      const target = resolve(own);
      if (target === null) errors.push(`${where}: ${String(call.uses)} names nothing here`);
      else errors.push(...lintCall(where, target, call.with, call.secrets));
    }
  }
  return errors;
}

/** The workspace's own path in a `run:` line, as a shell or the runner writes it. */
const WORKSPACE = /^(?:\$GITHUB_WORKSPACE|\$\{GITHUB_WORKSPACE\})\//;

/**
 * A path in the job's workspace (`.` for the workspace itself).
 *
 * @param {...string} parts
 */
const inWorkspace = (...parts) => path.posix.normalize(path.posix.join(...parts));

/**
 * Problems in the paths one of this repo's workflows names in it: each
 * script a `run:` hands to node and each glob of scripts, from the step's
 * working directory, and each `uses: ./…`, a job's (a workflow of this repo)
 * or a step's (an action, wherever this repo's checkout put it).
 *
 * @param {string} file the workflow's path from this repo's root
 * @param {unknown} doc
 * @param {Tree} tree
 * @returns {string[]}
 */
export function lintScripts(file, doc, tree) {
  if (!isObject(doc)) return [];
  const workflow = /** @type {Doc} */ (doc);
  const on = workflow.on;
  // A reusable workflow's plain checkout is its caller's repo.
  const reusable =
    on === 'workflow_call' ||
    (Array.isArray(on) && on.includes('workflow_call')) ||
    (isObject(on) && 'workflow_call' in /** @type {Doc} */ (on));
  /** @param {unknown} defaults */
  const workingDirectory = (defaults) => {
    const run = isObject(defaults) ? /** @type {Doc} */ (defaults).run : undefined;
    const dir = isObject(run) ? /** @type {Doc} */ (run)['working-directory'] : undefined;
    return typeof dir === 'string' ? dir : undefined;
  };
  const jobs = isObject(workflow.jobs) ? /** @type {Doc} */ (workflow.jobs) : {};
  /** @type {string[]} */
  const errors = [];
  for (const [id, raw] of Object.entries(jobs)) {
    const job = isObject(raw) ? /** @type {Doc} */ (raw) : {};
    if (typeof job.uses === 'string' && job.uses.startsWith('./')) {
      const problem = missing(`${file}: job ${id}`, `uses ${job.uses}`, job.uses.slice(2), tree);
      if (problem) errors.push(problem);
    }
    const steps = (Array.isArray(job.steps) ? job.steps : []).map((step) =>
      isObject(step) ? /** @type {Doc} */ (step) : {},
    );
    // Where each checkout puts its repo, and whether it's this one.
    const checkouts = steps
      .filter((step) => typeof step.uses === 'string' && /^actions\/checkout@/.test(step.uses))
      .map((step) => {
        const given = isObject(step.with) ? /** @type {Doc} */ (step.with) : {};
        const repository = given.repository;
        return {
          dir: inWorkspace(typeof given.path === 'string' ? given.path : '.'),
          mine: repository === undefined ? !reusable : /^jbhirsh\/ci$/i.test(String(repository)),
        };
      })
      .filter((checkout) => !checkout.dir.includes('$'))
      .sort((a, b) => b.dir.length - a.dir.length);
    /**
     * A workspace path's path in this repo, or null when no checkout of
     * this repo holds it.
     *
     * @param {string} at
     */
    const inRepo = (at) => {
      const holder = checkouts.find(
        ({ dir }) => dir === '.' || at === dir || at.startsWith(`${dir}/`),
      );
      if (!holder?.mine) return null;
      return holder.dir === '.' ? at : at === holder.dir ? '.' : at.slice(holder.dir.length + 1);
    };
    const jobDir = workingDirectory(job.defaults) ?? workingDirectory(workflow.defaults) ?? '.';
    steps.forEach((step, i) => {
      const where = `${file}: job ${id} step ${i + 1}${typeof step.name === 'string' ? ` (${step.name})` : ''}`;
      /** @type {[string, string][]} what the step names, and its workspace path */
      const named = [];
      if (typeof step.uses === 'string' && step.uses.startsWith('./')) {
        named.push([`uses ${step.uses}`, `${inWorkspace(step.uses)}/action.yml`]);
      }
      const stepDir = step['working-directory'];
      const dir = typeof stepDir === 'string' ? stepDir : jobDir;
      if (typeof step.run === 'string') {
        for (const script of scriptsIn(step.run)) {
          const rest = script.replace(WORKSPACE, '');
          if (rest !== script) {
            if (!rest.includes('$')) named.push([`runs ${script}`, inWorkspace(rest)]);
          } else if (
            !script.includes('$') &&
            !script.startsWith('/') &&
            !dir.includes('$') &&
            !dir.startsWith('/') &&
            // After a `cd`, a relative path is from wherever it went.
            !/(^|[\s;&|(])cd\s/.test(step.run)
          ) {
            named.push([`runs ${script}`, inWorkspace(dir, script)]);
          }
        }
      }
      for (const [token, at] of named) {
        const rel = inRepo(at);
        const problem = rel === null ? null : missing(where, token, rel, tree);
        if (problem) errors.push(problem);
      }
    });
  }
  return errors;
}

/**
 * The files of a checkout, as the path checks read them.
 *
 * @param {string} root
 * @returns {Tree}
 */
export function treeAt(root) {
  return {
    exists: (file) => existsSync(path.join(root, file)),
    glob: (pattern) =>
      globSync(pattern, {
        cwd: root,
        exclude: (/** @type {string} */ name) => name === 'node_modules',
      }),
  };
}

/**
 * The YAML files under a folder, skipping node_modules and dot folders other
 * than .github.
 *
 * @param {string} dir
 * @param {(name: string) => boolean} keep
 * @returns {string[]}
 */
function files(dir, keep) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || (entry.name.startsWith('.') && entry.name !== '.github'))
        return [];
      return files(full, keep);
    }
    return keep(entry.name) ? [full] : [];
  });
}

/** @param {string} file */
const read = (file) => parse(readFileSync(file, 'utf8'));

/**
 * What a `jbhirsh/ci/<path>` reference names in a checkout of this repo: an
 * action's folder or a workflow file, or null. The sync lints the workflows
 * it is about to write with it (sync/sync.ts).
 *
 * @param {string} root this repo's checkout
 * @returns {(target: string) => Target | null}
 */
export function targetsIn(root) {
  return (target) => {
    const file = target.endsWith('.yml')
      ? path.join(root, target)
      : path.join(root, target, 'action.yml');
    return existsSync(file) ? targetOf(read(file)) : null;
  };
}

/**
 * Lints this repo, and an app's workflows when given one.
 *
 * @param {string} root this repo's checkout
 * @param {string | null} app an app's checkout
 */
export function main(root, app) {
  const resolve = targetsIn(root);
  const tree = treeAt(root);
  /** @param {string} target */
  const exists = (target) => resolve(target) !== null;
  const rel = (/** @type {string} */ base, /** @type {string} */ file) => path.relative(base, file);
  /** @type {string[]} */
  const errors = [];
  for (const file of files(root, (name) => name === 'action.yml')) {
    errors.push(...lintAction(rel(root, file), read(file), exists, tree));
  }
  const workflows = (/** @type {string} */ base) => {
    const dir = path.join(base, '.github', 'workflows');
    return existsSync(dir) ? files(dir, (name) => /\.ya?ml$/.test(name)) : [];
  };
  for (const file of workflows(root)) {
    const doc = read(file);
    errors.push(
      ...lintWorkflow(rel(root, file), doc, resolve),
      ...lintScripts(rel(root, file), doc, tree),
    );
  }
  if (app) {
    const mine = workflows(app).map((file) => [file, read(file)]);
    // GitHub names a workflow with no `name:` by its path.
    const names = new Set(mine.map(([file, doc]) => String(doc?.name ?? rel(app, file))));
    for (const [file, doc] of mine) {
      errors.push(...lintWorkflow(rel(app, file), doc, resolve, names));
    }
  }
  return errors;
}

/* c8 ignore start: the CLI's lines, run by CI */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv.indexOf('--app');
  const app = flag === -1 ? null : path.resolve(process.argv[flag + 1]);
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const errors = main(root, app);
  for (const error of errors) console.error(error);
  console.log(
    errors.length === 0 ? 'actions: no problems' : `actions: ${errors.length} problem(s)`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
/* c8 ignore stop */
