// The security split of the PR GIFs workflows (ci#49), read from their YAML:
// the jobs that hold the PR's code never get BOT_PR_TOKEN, the jobs that
// hold it check out nothing, the workflow_run side checks out only the
// default branch, and the run by hand still works on its own inputs.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * @typedef {object} Step
 * @property {string} [uses]
 * @property {Record<string, unknown>} [with]
 * @property {string} [if]
 */

/**
 * @typedef {object} Job
 * @property {string} [if]
 * @property {string | string[]} [needs]
 * @property {Record<string, string> | Record<string, never>} [permissions]
 * @property {{ group: string; 'cancel-in-progress': unknown }} [concurrency]
 * @property {Step[]} steps
 */

/** @param {string} name */
function workflow(name) {
  const text = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
  return {
    text,
    jobs: /** @type {Record<string, Job>} */ (
      /** @type {{ jobs: Record<string, Job> }} */ (parse(text)).jobs
    ),
  };
}

const record = workflow('pr-gif.yml');
const attach = workflow('pr-gif-attach.yml');

/** @param {Job} job */
const checkouts = (job) => job.steps.filter((s) => s.uses?.startsWith('actions/checkout@'));
/** @param {Job} job */
const holdsToken = (job) => JSON.stringify(job).includes('secrets.bot-token');

describe('pr-gif.yml', () => {
  it('never gives the token to a job that checks out the PR', () => {
    for (const [name, job] of Object.entries(record.jobs)) {
      if (checkouts(job).length > 0) expect(holdsToken(job), name).toBe(false);
    }
    expect(holdsToken(record.jobs.attach)).toBe(true);
    expect(checkouts(record.jobs.attach)).toEqual([]);
  });

  it('attaches with the token only on a run by hand', () => {
    expect(record.jobs.attach.if).toBe("github.event_name != 'pull_request'");
    expect(record.jobs.attach.permissions).toEqual({});
  });

  it('keeps the run by hand off pull_request-only outputs', () => {
    // changed runs on both events, its checkout only on pull_request; record
    // waits on its record output, which a dispatch sets too.
    expect(record.jobs.changed.if).toBeUndefined();
    expect(checkouts(record.jobs.changed)[0].if).toBe("github.event_name == 'pull_request'");
    expect(record.jobs.record.if).toBe("needs.changed.outputs.record == 'true'");
    expect(record.jobs.record.needs).toBe('changed');
  });

  it("cancels an older push's recording, never a run by hand", () => {
    const { concurrency } = record.jobs.record;
    expect(concurrency?.group).toMatch(/^\$\{\{ github\.event_name == 'pull_request' && /);
    expect(concurrency?.group).toContain("format('pr-gif-record-{0}', github.run_id)");
    expect(concurrency?.['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  });
});

describe('pr-gif-attach.yml', () => {
  it('checks out only the default branch, never the PR, and never where the token is', () => {
    for (const [name, job] of Object.entries(attach.jobs)) {
      for (const step of checkouts(job)) {
        expect(step.with?.ref, name).toBe('${{ github.event.repository.default_branch }}');
        expect(step.with?.['persist-credentials'], name).toBe(false);
      }
      if (holdsToken(job)) expect(checkouts(job), name).toEqual([]);
    }
    expect(attach.text).not.toMatch(/ref: .*(head_sha|head_branch|pull_request|refs\/pull)/);
    expect(Object.keys(attach.jobs).filter((name) => holdsToken(attach.jobs[name]))).toEqual([
      'attach',
    ]);
  });

  it("goes past check only on its go, so never for a fork's PR", () => {
    expect(attach.jobs.make.if).toMatch(/^needs\.check\.outputs\.go == 'true' && /);
    expect(attach.jobs.attach.if).toMatch(/^always\(\) && needs\.check\.outputs\.go == 'true'/);
    expect(attach.jobs.report.if).toBe("always() && needs.check.outputs.report == 'true'");
  });

  it('asks each job for only what it uses', () => {
    expect(attach.jobs.check.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      'pull-requests': 'read',
      statuses: 'write',
    });
    // The caller's: sift grants actions write; a web app, whose make never
    // runs, only read, and a job asking for more fails every run.
    expect(attach.jobs.make.permissions).toBeUndefined();
    expect(attach.jobs.attach.permissions).toEqual({ actions: 'read' });
    expect(attach.jobs.report.permissions).toEqual({ statuses: 'write' });
  });

  it('takes turns with the run by hand to edit a PR', () => {
    const group = (/** @type {Job} */ job) =>
      job.concurrency?.group.replace(/needs\.\w+\.outputs\.pr/, 'PR');
    expect(group(attach.jobs.attach)).toBe('pr-gif-attach-${{ github.repository }}-${{ PR }}');
    expect(group(record.jobs.attach)).toBe(group(attach.jobs.attach));
    expect(attach.jobs.attach.concurrency?.['cancel-in-progress']).toBe(false);
  });
});
