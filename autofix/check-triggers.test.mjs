import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { testApp } from '../review/testApp.mjs';
import { checkTriggers, describeWorkflow, STUB, triggerProblems } from './check-triggers.mjs';

/**
 * @param {string} file
 * @param {string} name
 * @param {string[]} events
 * @param {string[]} [workflowRun]
 * @returns {import('./check-triggers.mjs').Workflow}
 */
const wf = (file, name, events, workflowRun) => ({ file, name, events, workflowRun });

const APP = [
  wf(STUB, 'Claude Auto-Fix PR Comments', ['workflow_run'], ['CI', 'Claude Review', 'E2E']),
  wf('ci.yml', 'CI', ['pull_request', 'push']),
  wf('claude-review.yml', 'Claude Review', ['pull_request']),
  wf('e2e.yml', 'E2E', ['pull_request']),
  wf('pr-visuals.yml', 'PR visuals', ['pull_request']),
  wf('weekly.yml', 'Weekly', ['schedule']),
];
const EXEMPT = { 'PR visuals': 'wants pictures' };

describe('describeWorkflow', () => {
  it('reads each form `on:` takes', () => {
    expect(describeWorkflow('a.yml', { name: 'A', on: 'pull_request' }).events).toEqual([
      'pull_request',
    ]);
    expect(describeWorkflow('a.yml', { on: ['push', 'pull_request', 1] }).events).toEqual([
      'push',
      'pull_request',
    ]);
    expect(describeWorkflow('a.yml', { true: { pull_request: null } }).events).toEqual([
      'pull_request',
    ]);
    expect(
      describeWorkflow('s.yml', {
        on: { workflow_run: { workflows: 'CI', types: ['completed'] } },
      }),
    ).toEqual({
      file: 's.yml',
      name: '.github/workflows/s.yml',
      events: ['workflow_run'],
      workflowRun: ['CI'],
    });
  });
  it('reads nothing from what is not a workflow', () => {
    expect(describeWorkflow('x.yml', null)).toEqual({
      file: 'x.yml',
      name: '.github/workflows/x.yml',
      events: [],
      workflowRun: undefined,
    });
  });
});

describe('triggerProblems', () => {
  it('passes a list holding every pull-request workflow not exempt', () => {
    expect(triggerProblems(APP, EXEMPT)).toEqual([]);
  });
  it('fails a pull-request workflow neither listed nor exempt', () => {
    expect(triggerProblems(APP, {})).toEqual([
      expect.stringContaining('pr-visuals.yml ("PR visuals") runs on pull requests'),
    ]);
  });
  it('fails a listed or exempt name no workflow has, or one both listed and exempt', () => {
    const typo = APP.map((w) =>
      w.file === STUB ? { ...w, workflowRun: ['CI', 'Claude Review', 'E2E', 'Ci'] } : w,
    );
    expect(triggerProblems(typo, EXEMPT)).toEqual([
      `${STUB} lists "Ci", which no workflow is named`,
    ]);
    expect(triggerProblems(APP, { ...EXEMPT, Gone: 'x', E2E: 'y' })).toEqual([
      'autofix.exempt names "Gone", which no workflow is named',
      `"E2E" is both in ${STUB}'s list and exempt`,
    ]);
  });
  it('fails a pull_request_target workflow not exempt', () => {
    const app = [...APP, wf('label.yml', 'Label', ['pull_request_target'])];
    expect(triggerProblems(app, EXEMPT)).toEqual([
      expect.stringContaining('runs on pull_request_target'),
    ]);
    expect(triggerProblems(app, { ...EXEMPT, Label: 'labels PRs' })).toEqual([]);
  });
  it('fails a list without CI or Claude Review, or no list at all', () => {
    const noReview = APP.map((w) => (w.file === STUB ? { ...w, workflowRun: ['CI', 'E2E'] } : w));
    expect(triggerProblems(noReview, { ...EXEMPT, 'Claude Review': 'x' })).toEqual([
      `${STUB} must list "Claude Review" (claude-review.yml): the review fixer waits for it`,
    ]);
    expect(triggerProblems(APP.slice(1), EXEMPT)).toEqual([
      expect.stringContaining('must list the workflows that wake it'),
    ]);
  });
  it('never throws, and fails every unlisted, unexempt pull-request workflow', () => {
    const name = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 _-]{0,11}$/);
    const workflow = fc.record({
      name,
      events: fc.subarray(['pull_request', 'pull_request_target', 'push', 'schedule']),
    });
    fc.assert(
      fc.property(
        fc.array(workflow, { maxLength: 6 }),
        fc.array(name, { minLength: 1, maxLength: 4 }),
        fc.dictionary(name, fc.string({ minLength: 1 }), { maxKeys: 3 }),
        (rest, listed, exempt) => {
          const workflows = [
            wf(STUB, 'Autofix', ['workflow_run'], listed),
            ...rest.map((w, i) => wf(`w${i}.yml`, w.name, w.events)),
          ];
          const problems = triggerProblems(workflows, exempt);
          for (const w of workflows.slice(1)) {
            if (
              w.events.includes('pull_request') &&
              !listed.includes(w.name) &&
              !(w.name in exempt)
            ) {
              expect(problems.some((p) => p.includes(`("${w.name}")`))).toBe(true);
            }
          }
        },
      ),
    );
  });
});

describe('checkTriggers', () => {
  it("reads the app's workflows and exemptions", async () => {
    const yaml = (/** @type {unknown} */ doc) => JSON.stringify(doc);
    const root = testApp({
      [`.github/workflows/${STUB}`]: yaml({
        name: 'Autofix',
        on: { workflow_run: { workflows: ['CI'] } },
      }),
      '.github/workflows/ci.yml': yaml({ name: 'CI', on: 'pull_request' }),
      '.github/workflows/pr-visuals.yaml': yaml({ name: 'PR visuals', on: 'pull_request' }),
      '.github/workflows/README.md': '# not a workflow',
      '.github/ci.json': JSON.stringify({ autofix: { exempt: EXEMPT } }),
    });
    const { workflows, problems } = await checkTriggers(root, { parse: JSON.parse });
    expect(workflows.map((w) => w.file)).toEqual(['ci.yml', STUB, 'pr-visuals.yaml']);
    expect(problems).toEqual([]);
  });
  it("uses the app's own yaml package by default", async () => {
    const root = testApp({
      'node_modules/yaml/package.json': JSON.stringify({ name: 'yaml', main: 'index.js' }),
      'node_modules/yaml/index.js': 'exports.parse = (text) => JSON.parse(text);',
      [`.github/workflows/${STUB}`]: JSON.stringify({ on: { workflow_run: { workflows: [] } } }),
    });
    const { problems } = await checkTriggers(root);
    expect(problems).toEqual([expect.stringContaining('must list the workflows that wake it')]);
  });
});
