// The pictures route's split (ci#133), read from its YAML: the person's
// token only in Attach, no checkout anywhere, every input to a script only
// through env:, the branch deleted whatever fails once its name was
// accepted, and one concurrency group, pr-gif's attach group, for the run.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ARTIFACT } from './branch.mjs';

/**
 * @typedef {object} Step
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [uses]
 * @property {string} [run]
 * @property {string} [shell]
 * @property {string} [if]
 * @property {Record<string, string>} [with]
 * @property {Record<string, string>} [env]
 */

/**
 * @typedef {object} Job
 * @property {string} [needs]
 * @property {Record<string, string>} [permissions]
 * @property {Step[]} steps
 */

/**
 * @typedef {object} Workflow
 * @property {{ workflow_dispatch: { inputs: Record<string, { default?: string }> } }} on
 * @property {Record<string, string>} permissions
 * @property {string} run-name
 * @property {{ group: string; 'cancel-in-progress': boolean }} concurrency
 * @property {Record<string, Job & { concurrency?: { group: string } }>} jobs
 */

/**
 * @typedef {object} Action
 * @property {Record<string, { default?: string }>} inputs
 * @property {{ steps: Step[] }} runs
 */

/**
 * A file's text and parsed YAML.
 *
 * @template T
 * @param {string} file relative to the repo's root
 * @returns {{ text: string; doc: T }}
 */
function read(file) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  return { text, doc: parse(text) };
}

/** @type {{ text: string; doc: Workflow }} */
const workflow = read('.github/workflows/pictures.yml');
/** @type {{ text: string; doc: Action }} */
const action = read('pictures/from-branch/action.yml');
/** @type {{ text: string; doc: Workflow }} */
const gifAttach = read('.github/workflows/pr-gif-attach.yml');
const jobs = workflow.doc.jobs;
const steps = action.doc.runs.steps;
const HOST = '${{ inputs.host-pr || vars.PICTURES_HOST_PR }}';

describe('pictures.yml', () => {
  it('runs only when dispatched, with no permission of its own', () => {
    expect(Object.keys(workflow.doc.on)).toEqual(['workflow_dispatch']);
    expect(workflow.doc.permissions).toEqual({});
    expect(workflow.doc['run-name']).toBe('Pictures from ${{ inputs.branch }}');
  });

  it('defaults host-pr to empty, resolved in the jobs from PICTURES_HOST_PR', () => {
    expect(workflow.doc.on.workflow_dispatch.inputs['host-pr'].default).toBe('');
    expect(jobs.files.steps[0].with?.['host-pr']).toBe(HOST);
    expect(jobs.attach.steps[0].with?.['host-pr']).toBe(HOST);
  });

  it("takes pr-gif's attach group for the host, for the whole run, never cancelling", () => {
    const attachGroup = gifAttach.doc.jobs.attach.concurrency?.group;
    expect(attachGroup).toBe(
      'pr-gif-attach-${{ github.repository }}-${{ needs.check.outputs.pr }}',
    );
    expect(workflow.doc.concurrency).toEqual({
      group: `pr-gif-attach-\${{ github.repository }}-${HOST}`,
      'cancel-in-progress': false,
    });
    for (const job of Object.values(jobs)) expect(job).not.toHaveProperty('concurrency');
  });

  it('gives the token to Attach alone, and checks nothing out anywhere', () => {
    expect(Object.keys(jobs)).toEqual(['files', 'attach']);
    expect(JSON.stringify(jobs.files)).not.toContain('secrets.');
    expect(jobs.attach.steps).toEqual([
      expect.objectContaining({ uses: 'jbhirsh/ci/pictures/attach@main' }),
    ]);
    expect(jobs.attach.steps[0].with?.token).toBe('${{ secrets.BOT_PR_TOKEN }}');
    expect(workflow.text.match(/secrets\./g)).toHaveLength(1);
    expect(workflow.text).not.toContain('actions/checkout');
    expect(action.text).not.toContain('actions/checkout');
  });

  it('asks each job only for what it uses', () => {
    expect(jobs.files.permissions).toEqual({ contents: 'write' });
    expect(jobs.attach.permissions).toEqual({ actions: 'read' });
    expect(jobs.attach.needs).toBe('files');
  });

  it("attaches this run's artifact, the one Files uploads", () => {
    expect(jobs.files.steps).toEqual([
      expect.objectContaining({ uses: 'jbhirsh/ci/pictures/from-branch@main' }),
    ]);
    expect(jobs.attach.steps[0].with).toMatchObject({
      'run-id': '${{ github.run_id }}',
      artifact: ARTIFACT,
    });
    const upload = steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.name).toBe(ARTIFACT);
  });

  it('has no fixed-time wait', () => {
    for (const { text } of [workflow, action]) expect(text).not.toMatch(/\bsleep\b/);
  });
});

describe('pictures/from-branch', () => {
  it('passes every input to its scripts through env:, never into a run line', () => {
    for (const step of steps.filter((s) => s.run)) {
      expect(step.run, step.name).not.toContain('${{');
      expect(step.shell ?? 'bash', step.name).toBe('bash');
    }
  });

  it("checks the branch's name alone, first, and deletes the branch whatever fails after", () => {
    const named = steps.findIndex((s) => s.id === 'name');
    const fetch = steps.findIndex((s) => s.run?.includes('branch.mjs" fetch'));
    const upload = steps.findIndex((s) => s.uses?.startsWith('actions/upload-artifact@'));
    const del = steps.findIndex((s) => s.run?.includes('branch.mjs" delete'));
    expect(steps[named].run).toContain('branch.mjs" name');
    expect(steps[named].env).toEqual({ BRANCH: '${{ inputs.branch }}' });
    expect([named < fetch, fetch < upload, upload < del]).toEqual([true, true, true]);
    expect(del).toBe(steps.length - 1);
    expect(steps[del].if).toBe("always() && steps.name.outputs.branch != ''");
    // Later steps read the accepted name, never the raw input.
    expect(steps[fetch].env?.BRANCH).toBe('${{ steps.name.outputs.branch }}');
    expect(steps[del].env?.BRANCH).toBe('${{ steps.name.outputs.branch }}');
  });

  it('uploads only the folder fetch wrote, failing when it is empty', () => {
    const upload = steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.path).toBe('${{ runner.temp }}/pictures');
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    expect(steps.find((s) => s.run?.includes(' fetch '))?.run).toContain('"$RUNNER_TEMP/pictures"');
  });

  it('uses the Actions token, never a person token', () => {
    expect(action.doc.inputs['github-token'].default).toBe('${{ github.token }}');
    expect(action.doc.inputs).not.toHaveProperty('token');
  });
});
