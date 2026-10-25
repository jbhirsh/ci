// Keeps Claude autofix's trigger list honest, as a step of each app's CI on
// pull requests (check-triggers/action.yml) and in autofix's self-test.
//
// Autofix runs on each `completed` of the workflows its stub lists
// (`on.workflow_run.workflows` in `.github/workflows/claude-autofix.yml`),
// and the CI fixer acts once no pull-request run on the head is still going
// (gate.mjs). A pull-request workflow left off the list would never wake
// autofix: finishing last, it would leave the fix waiting for a run that
// never comes, and its failures would never start one. So this fails when:
//   - a workflow triggered by `pull_request` isn't in the list and isn't
//     exempt (`autofix.exempt` in `.github/ci.json`, each with its reason);
//     the gate skips an exempt workflow's runs, as their completion wakes
//     nothing;
//   - the list or the exemptions name a workflow that doesn't exist, or a
//     workflow is both listed and exempt;
//   - a workflow triggered by `pull_request_target` (and not
//     `pull_request`) isn't exempt: autofix acts only on `pull_request`
//     runs, so its completion couldn't start the fix either;
//   - ci.yml's or claude-review.yml's workflow isn't listed (the review
//     fixer waits for both to be green).
// Autofix's own workflow is exempt by nature.
//
// A workflow's name is its `name:`, or its path when it has none, as
// GitHub matches it. YAML is read with the `yaml` package from the app's
// node_modules (importFromApp; all three apps have it through knip), so
// any form a workflow writes its triggers in is read as GitHub reads it.
//
// CLI: `node check-triggers.mjs`, from the app's checkout (APP_ROOT to point
// elsewhere), after `npm ci`. Exits 1 with each problem as an error
// annotation.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appRoot, importFromApp } from '../lib/app.mjs';
import { autofixSettings } from './settings.mjs';

export const STUB = 'claude-autofix.yml';

/**
 * A workflow as this check reads it.
 *
 * @typedef {object} Workflow
 * @property {string} file its file name in `.github/workflows/`
 * @property {string} name its `name:`, or its path when it has none
 * @property {string[]} events what triggers it
 * @property {string[] | undefined} workflowRun the workflows its
 *   `workflow_run` trigger lists, if it has one
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value a string or a list of strings
 * @returns {string[]}
 */
function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  return [];
}

/**
 * Reads one parsed workflow. A YAML 1.1 parser turns the `on` key into
 * `true`; both are read.
 *
 * @param {string} file
 * @param {unknown} doc the parsed YAML
 * @returns {Workflow}
 */
export function describeWorkflow(file, doc) {
  const workflow = isObject(doc) ? doc : {};
  const name =
    typeof workflow.name === 'string' && workflow.name.trim() !== ''
      ? workflow.name
      : `.github/workflows/${file}`;
  const on = workflow.on ?? workflow.true;
  const events = isObject(on) ? Object.keys(on) : strings(on);
  const run = isObject(on) && isObject(on.workflow_run) ? on.workflow_run : undefined;
  return { file, name, events, workflowRun: run ? strings(run.workflows) : undefined };
}

/**
 * Everything wrong with the trigger list, given the app's workflows and its
 * exemptions; empty when it's right.
 *
 * @param {Workflow[]} workflows
 * @param {Record<string, string>} exempt workflow name → why
 * @returns {string[]}
 */
export function triggerProblems(workflows, exempt) {
  const stub = workflows.find((w) => w.file === STUB);
  if (!stub || !stub.workflowRun || stub.workflowRun.length === 0) {
    return [
      `.github/workflows/${STUB} must list the workflows that wake it under on.workflow_run.workflows`,
    ];
  }
  const listed = new Set(stub.workflowRun);
  const names = new Set(workflows.map((w) => w.name));
  /** @type {string[]} */
  const problems = [];
  for (const name of listed) {
    if (!names.has(name)) problems.push(`${STUB} lists "${name}", which no workflow is named`);
  }
  for (const name of Object.keys(exempt)) {
    if (!names.has(name))
      problems.push(`autofix.exempt names "${name}", which no workflow is named`);
    if (listed.has(name)) problems.push(`"${name}" is both in ${STUB}'s list and exempt`);
  }
  for (const w of workflows) {
    if (w === stub || w.name in exempt) continue;
    const pr = w.events.includes('pull_request');
    if (!pr && w.events.includes('pull_request_target')) {
      problems.push(
        `${w.file} ("${w.name}") runs on pull_request_target, whose runs can't start autofix: exempt it in .github/ci.json (autofix.exempt) with the reason`,
      );
    } else if (pr && !listed.has(w.name)) {
      problems.push(
        `${w.file} ("${w.name}") runs on pull requests but isn't in ${STUB}'s workflow_run list: add it, or exempt it in .github/ci.json (autofix.exempt) with the reason`,
      );
    }
  }
  for (const file of ['ci.yml', 'claude-review.yml']) {
    const w = workflows.find((x) => x.file === file);
    if (w && !listed.has(w.name)) {
      problems.push(`${STUB} must list "${w.name}" (${file}): the review fixer waits for it`);
    }
  }
  return [...new Set(problems)];
}

/**
 * Reads an app's workflows and exemptions and checks them.
 *
 * @param {string} root the app's checkout
 * @param {{ parse?: (text: string) => unknown, ref?: string }} [options]
 *   `parse` instead of the app's `yaml` package; `ref` to read the
 *   exemptions from (default: the working tree)
 * @returns {Promise<{ workflows: Workflow[], problems: string[] }>}
 */
export async function checkTriggers(root, { parse, ref } = {}) {
  const read =
    parse ??
    /** @type {{ parse: (text: string) => unknown }} */ (await importFromApp('yaml', root)).parse;
  const dir = path.join(root, '.github', 'workflows');
  const workflows = readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => describeWorkflow(file, read(readFileSync(path.join(dir, file), 'utf8'))));
  const { exempt } = autofixSettings({ root, ref });
  return { workflows, problems: triggerProblems(workflows, exempt) };
}

/* c8 ignore start: the CLI's lines, run by check-triggers/action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { workflows, problems } = await checkTriggers(appRoot());
  for (const problem of problems) console.log(`::error::${problem}`);
  if (problems.length > 0) process.exit(1);
  const stub = workflows.find((w) => w.file === STUB);
  console.log(
    `autofix triggers: ${stub?.workflowRun?.join(', ')} (every pull-request workflow listed or exempt)`,
  );
}
/* c8 ignore stop */
