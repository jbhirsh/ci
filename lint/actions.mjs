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
// step may take `timeout-minutes` (composite steps can't). Every
// `${{ inputs.x }}` must name a declared input, every `steps.<id>` an earlier
// step's id (an output's value, any step's), and `secrets` is out of reach
// inside an action, so it must come in as an input. A `jbhirsh/ci/<path>`
// reference must name an action or workflow here. A caller may pass only
// inputs (and, to a workflow, secrets) the target declares, and must pass
// every required one that has no default. Exits 1 listing each problem.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

/** @typedef {Record<string, unknown>} Doc */
/** @typedef {{ inputs: Map<string, boolean>, secrets: Map<string, boolean> | null }} Target */

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const OWN = /^jbhirsh\/ci\/(.+?)@.+$/;

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

/**
 * Problems in one action.yml.
 *
 * @param {string} file
 * @param {unknown} doc
 * @param {(target: string) => boolean} exists
 * @returns {string[]}
 */
export function lintAction(file, doc, exists) {
  if (!isObject(doc)) return [`${file}: not a YAML mapping`];
  const action = /** @type {Doc} */ (doc);
  const errors = [];
  for (const key of ['name', 'description']) {
    if (typeof action[key] !== 'string') errors.push(`${file}: no ${key}`);
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
 * @returns {string[]}
 */
export function lintWorkflow(file, doc, resolve) {
  if (!isObject(doc)) return [`${file}: not a YAML mapping`];
  const jobs = isObject(/** @type {Doc} */ (doc).jobs)
    ? /** @type {Doc} */ (/** @type {Doc} */ (doc).jobs)
    : {};
  /** @type {string[]} */
  const errors = [];
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

/**
 * Lints this repo, and an app's workflows when given one.
 *
 * @param {string} root this repo's checkout
 * @param {string | null} app an app's checkout
 */
export function main(root, app) {
  /** @param {string} file */
  const read = (file) => parse(readFileSync(file, 'utf8'));
  /** @param {string} target */
  const resolve = (target) => {
    const file = target.endsWith('.yml')
      ? path.join(root, target)
      : path.join(root, target, 'action.yml');
    return existsSync(file) ? targetOf(read(file)) : null;
  };
  /** @param {string} target */
  const exists = (target) => resolve(target) !== null;
  const rel = (/** @type {string} */ base, /** @type {string} */ file) => path.relative(base, file);
  /** @type {string[]} */
  const errors = [];
  for (const file of files(root, (name) => name === 'action.yml')) {
    errors.push(...lintAction(rel(root, file), read(file), exists));
  }
  const workflows = (/** @type {string} */ base) => {
    const dir = path.join(base, '.github', 'workflows');
    return existsSync(dir) ? files(dir, (name) => /\.ya?ml$/.test(name)) : [];
  };
  for (const file of workflows(root))
    errors.push(...lintWorkflow(rel(root, file), read(file), resolve));
  if (app) {
    for (const file of workflows(app))
      errors.push(...lintWorkflow(rel(app, file), read(file), resolve));
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
