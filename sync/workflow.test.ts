// The sync's workflow and actions, read as YAML: when it runs, that each app
// waits in a group of its own, and that the token is never in a job that
// runs an app's code.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { APPS, CI_ROOT } from './manifest.ts';

/** @param {string} file */
const yaml = (file) => parse(readFileSync(path.join(CI_ROOT, file), 'utf8'));
const workflow = yaml('.github/workflows/sync-files.yml');
const { prepare, publish } = workflow.jobs;
/** @typedef {Record<string, any>} Step */
/**
 * The steps of the action a job's step uses from this checkout (`./ci/<path>`).
 *
 * @param {Step} step
 * @returns {Step[]}
 */
const actionSteps = (step) => yaml(`${step.uses.replace(/^\.\/ci\//, '')}/action.yml`).runs.steps;
/** @param {unknown} value */
const text = (value) => JSON.stringify(value);
const SHA = '${{ github.event.workflow_run.head_sha || github.sha }}';
const TRIGGER = [
  "github.event_name == 'workflow_dispatch'",
  "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.event == 'push'",
  'github.event.workflow_run.head_repository.full_name == github.repository',
];

/**
 * Whether a step runs code of the app's: checks an app out, or runs prepare
 * (which runs the app's Prettier).
 *
 * @param {Step} step
 */
const runsAppCode = (step) =>
  String(step.with?.repository ?? '').includes('inputs.app') ||
  /sync\.ts" prepare/.test(String(step.run));

describe('sync-files.yml', () => {
  it('runs after CI on main, or by hand for one app or all, with no paths filter', () => {
    expect(workflow.on.workflow_run).toEqual({
      workflows: ['CI'],
      types: ['completed'],
      branches: ['main'],
    });
    expect(workflow.on.workflow_dispatch.inputs.app.options).toEqual(['all', ...APPS]);
    expect(workflow.on.workflow_dispatch.inputs['auto-merge']).toMatchObject({
      type: 'boolean',
      default: true,
    });
    for (const trigger of Object.values(workflow.on)) {
      expect(trigger).not.toHaveProperty('paths');
      expect(trigger).not.toHaveProperty('paths-ignore');
    }
  });

  it('runs both jobs only from a push to main whose CI passed, or a dispatch', () => {
    for (const job of [prepare, publish]) {
      const condition = job.if.replace(/\s+/g, ' ');
      for (const part of TRIGGER) expect(condition).toContain(part);
    }
    // One app's failed Prepare doesn't skip another app's Publish.
    expect(publish.needs).toBe('prepare');
    expect(publish.if).toMatch(/^!cancelled\(\)/);
  });

  it('runs one leg per app, the manifest’s apps, each Publish in its own group', () => {
    for (const job of [prepare, publish]) {
      expect(job.strategy['fail-fast']).toBe(false);
      expect(job.strategy.matrix.app).toContain(`'${JSON.stringify(APPS)}'`);
      expect(job.strategy.matrix.app).toContain('format(\'["{0}"]\', inputs.app)');
    }
    // A pending run for one app is never replaced by another app's.
    expect(publish.concurrency).toEqual({
      group: 'sync-files-${{ matrix.app }}',
      'cancel-in-progress': false,
    });
  });

  it('runs each job from the commit CI passed on, with that commit’s own actions', () => {
    expect(workflow.permissions).toEqual({});
    for (const job of [prepare, publish]) {
      expect(job.permissions).toEqual({ contents: 'read', actions: 'read' });
      expect(job.steps[0]).toEqual({
        uses: 'actions/checkout@v7',
        with: { ref: 'main', path: 'ci', 'persist-credentials': false },
      });
    }
    expect(prepare.steps[1]).toEqual({
      uses: './ci/sync/prepare',
      with: {
        app: '${{ matrix.app }}',
        'token-set': "${{ secrets.BOT_PR_TOKEN != '' }}",
        'ci-sha': SHA,
      },
    });
    expect(publish.steps[1]).toEqual({
      uses: './ci/sync',
      with: {
        app: '${{ matrix.app }}',
        token: '${{ secrets.BOT_PR_TOKEN }}',
        'ci-sha': SHA,
        'auto-merge': "${{ github.event_name != 'workflow_dispatch' || inputs.auto-merge }}",
      },
    });
  });

  it('runs no code from a ref an event names, and keeps no cache that main could restore', () => {
    for (const job of Object.values(workflow.jobs)) {
      const steps = /** @type {Step[]} */ (job.steps).flatMap((step) =>
        String(step.uses).startsWith('./ci/') ? [step, ...actionSteps(step)] : [step],
      );
      for (const step of steps) {
        if (String(step.uses).startsWith('actions/checkout') && !step.with?.repository) {
          expect(step.with?.ref).toBe('main');
        }
        expect(String(step.uses)).not.toMatch(/^actions\/cache/);
        if (String(step.uses).startsWith('actions/setup-node'))
          expect(step.with).not.toHaveProperty('cache');
      }
    }
  });

  it("never puts the token in a job that runs an app's code", () => {
    const holding = Object.entries(workflow.jobs).filter(([, job]) =>
      text(job).includes('secrets.BOT_PR_TOKEN }}'),
    );
    expect(holding.map(([id]) => id)).toEqual(['publish']);
    for (const [, job] of holding) {
      for (const step of /** @type {Step[]} */ (job.steps)) {
        expect(runsAppCode(step)).toBe(false);
        if (String(step.uses).startsWith('./ci/')) {
          expect(actionSteps(step).filter(runsAppCode)).toEqual([]);
        }
      }
    }
    // And the job that does run it is given only whether the token is set.
    expect(text(prepare)).not.toContain('secrets.BOT_PR_TOKEN }}');
    expect(actionSteps(prepare.steps[1]).filter(runsAppCode)).toHaveLength(2);
  });
});

describe('the actions', () => {
  const prepareSteps = actionSteps(prepare.steps[1]);
  const publishSteps = actionSteps(publish.steps[1]);

  it('install nothing: the sync imports no package', () => {
    for (const step of [...prepareSteps, ...publishSteps])
      expect(String(step.run)).not.toMatch(/\bnpm\b/);
  });

  it('check first, and run nothing more when the check says to skip', () => {
    for (const [steps, script] of [
      [prepareSteps, '$GITHUB_ACTION_PATH/../sync.ts'],
      [publishSteps, '$GITHUB_ACTION_PATH/sync.ts'],
    ]) {
      const list = /** @type {Step[]} */ (steps);
      expect(list[1].id).toBe('check');
      expect(list[1].run).toBe(`node "${script}" check`);
      for (const step of list.slice(2)) expect(step.if).toBe("steps.check.outputs.go == 'true'");
    }
    expect(prepareSteps[1].env.TOKEN_SET).toBe('${{ inputs.token-set }}');
    expect(publishSteps[1].env.TOKEN_SET).toBe("${{ inputs.token != '' }}");
  });

  it('hand prepared.json from Prepare to Publish as this app’s artifact', () => {
    const upload = prepareSteps.find((step) =>
      String(step.uses).startsWith('actions/upload-artifact'),
    );
    const download = publishSteps.find((step) =>
      String(step.uses).startsWith('actions/download-artifact'),
    );
    expect(upload?.with.name).toBe('sync-files-${{ inputs.app }}');
    expect(download?.with.name).toBe('sync-files-${{ inputs.app }}');
    expect(upload?.with.path).toBe('${{ runner.temp }}/sync-files/prepared.json');
    expect(download?.with.path).toBe('${{ runner.temp }}/sync-files');
  });

  it('give the bot token only to the publish step, with the auto-merge setting', () => {
    const holding = publishSteps.filter((step) => text(step).includes('inputs.token }}'));
    expect(holding.map((step) => step.run)).toEqual([
      'node "$GITHUB_ACTION_PATH/sync.ts" publish',
    ]);
    expect(holding[0].env.GH_TOKEN).toBe('${{ inputs.token }}');
    expect(holding[0].env.AUTO_MERGE).toBe('${{ inputs.auto-merge }}');
    expect(yaml('sync/action.yml').inputs['auto-merge'].default).toBe('true');
  });

  it('check the app out in Prepare with no credentials kept', () => {
    const checkout = /** @type {Step} */ (
      prepareSteps.find((step) => step.uses === 'actions/checkout@v7')
    );
    expect(checkout.with).toMatchObject({
      repository: 'jbhirsh/${{ inputs.app }}',
      token: '${{ inputs.ci-token }}',
      'persist-credentials': false,
    });
  });
});
