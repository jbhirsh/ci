import { describe, expect, it } from 'vitest';
import { testApp } from '../review/testApp.mjs';
import {
  latestRuns,
  main,
  notGreen,
  pendingWorkflows,
  runsFromApi,
  workflowPath,
} from './gate.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';

/**
 * @param {Partial<import('./gate.mjs').Run>} over
 * @returns {import('./gate.mjs').Run}
 */
function run(over) {
  return {
    id: 1,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    ...over,
  };
}

const SELF = '.github/workflows/claude-autofix.yml';

describe('workflowPath', () => {
  it('takes the path out of github.workflow_ref', () => {
    expect(workflowPath('jbhirsh/sift/.github/workflows/claude-autofix.yml@refs/heads/main')).toBe(
      '.github/workflows/claude-autofix.yml',
    );
  });
  it('fails anything else', () => {
    expect(() => workflowPath('claude-autofix.yml')).toThrow('not a workflow ref');
  });
});

describe('runsFromApi', () => {
  it('reads a page, or the pages --slurp prints', () => {
    const page = { total_count: 1, workflow_runs: [{ ...run({}), extra: 1 }] };
    expect(runsFromApi(page)).toEqual([run({})]);
    expect(runsFromApi([page, { workflow_runs: [run({ id: 2, conclusion: null })] }])).toEqual([
      run({}),
      run({ id: 2, conclusion: null }),
    ]);
  });
  it('fails what is not a page of runs', () => {
    expect(() => runsFromApi(null)).toThrow('page of workflow runs');
    expect(() => runsFromApi({ workflow_runs: [null] })).toThrow('must be an object');
    expect(() => runsFromApi({ workflow_runs: [{ ...run({}), status: 1 }] })).toThrow(
      'missing a field',
    );
  });
});

describe('latestRuns', () => {
  it('keeps the newest pull_request run of each workflow', () => {
    const latest = latestRuns(
      [
        run({ id: 3, status: 'in_progress' }),
        run({ id: 1 }),
        run({ id: 9, event: 'push' }),
        run({ id: 2, name: 'E2E' }),
      ],
      (r) => r.name,
    );
    expect(latest.get('CI')?.id).toBe(3);
    expect(latest.get('E2E')?.id).toBe(2);
  });
});

describe('pendingWorkflows', () => {
  const skip = { self: SELF, exempt: ['PR visuals'] };
  it('names every pull-request workflow still running, by name', () => {
    const runs = [
      run({ id: 1, name: 'CI', status: 'completed', conclusion: 'failure' }),
      run({
        id: 2,
        name: 'Smoke gate',
        path: '.github/workflows/smoke.yml',
        status: 'in_progress',
        conclusion: null,
      }),
      run({
        id: 3,
        name: 'E2E',
        path: '.github/workflows/e2e.yml',
        status: 'queued',
        conclusion: null,
      }),
    ];
    expect(pendingWorkflows(runs, skip)).toEqual(['E2E', 'Smoke gate']);
  });
  it("leaves out autofix's own runs, exempt workflows and other events", () => {
    const runs = [
      run({ id: 1, name: 'Claude autofix', path: SELF, status: 'in_progress', conclusion: null }),
      run({
        id: 2,
        name: 'PR visuals',
        path: '.github/workflows/pr-visuals.yml',
        status: 'queued',
        conclusion: null,
      }),
      run({
        id: 3,
        event: 'push',
        path: '.github/workflows/push.yml',
        status: 'queued',
        conclusion: null,
      }),
    ];
    expect(pendingWorkflows(runs, skip)).toEqual([]);
  });
  it('waits for a re-run of a finished workflow', () => {
    const runs = [run({ id: 1 }), run({ id: 5, status: 'queued', conclusion: null })];
    expect(pendingWorkflows(runs, skip)).toEqual(['CI']);
    expect(pendingWorkflows([], skip)).toEqual([]);
  });
});

describe('notGreen', () => {
  it('names each file not completed/success, no run included', () => {
    const runs = [
      run({ id: 1 }),
      run({
        id: 2,
        name: 'Claude Review',
        path: '.github/workflows/claude-review.yml',
        status: 'in_progress',
        conclusion: null,
      }),
    ];
    expect(notGreen(runs, ['ci.yml', 'claude-review.yml', 'e2e.yml'])).toEqual([
      'claude-review.yml (in_progress/none)',
      'e2e.yml (no run)',
    ]);
    expect(notGreen([run({})], ['ci.yml'])).toEqual([]);
  });
});

describe('main', () => {
  const env = {
    GITHUB_REPOSITORY: 'jbhirsh/app',
    HEAD_SHA: SHA,
    WORKFLOW_REF: 'jbhirsh/app/.github/workflows/claude-autofix.yml@refs/heads/main',
    BASE_REF: 'main',
  };

  it("answers pending from the head's runs, less the exemptions on the default branch", () => {
    const root = testApp({
      '.github/ci.json': JSON.stringify({ autofix: { exempt: { 'PR visuals': 'pictures' } } }),
    });
    /** @type {string[]} */
    const asked = [];
    const out = main(['pending'], env, {
      root,
      fetchRuns: (repo, sha) => {
        asked.push(repo, sha);
        return [
          {
            workflow_runs: [
              run({ name: 'Smoke gate', status: 'queued', conclusion: null }),
              run({ id: 2, name: 'PR visuals', path: 'v.yml', status: 'queued', conclusion: null }),
            ],
          },
        ];
      },
    });
    expect(out).toBe('Smoke gate');
    expect(asked).toEqual(['jbhirsh/app', SHA]);
  });

  it('answers green for the files named', () => {
    const out = main(['green', 'ci.yml', 'claude-review.yml'], env, {
      root: '.',
      fetchRuns: () => ({ workflow_runs: [run({})] }),
    });
    expect(out).toBe('claude-review.yml (no run)');
  });

  it('fails bad usage and bad input', () => {
    const io = { root: '.', fetchRuns: () => ({ workflow_runs: [] }) };
    expect(() => main([], env, io)).toThrow('usage');
    expect(() => main(['green'], env, io)).toThrow('needs workflow files');
    expect(() => main(['green', 'ci.yml'], { ...env, HEAD_SHA: 'main' }, io)).toThrow('commit SHA');
    expect(() => main(['green', 'ci.yml'], { ...env, GITHUB_REPOSITORY: 'x' }, io)).toThrow(
      'owner/name',
    );
    expect(() => main(['pending'], { ...env, WORKFLOW_REF: '' }, io)).toThrow('is not set');
    const bad = testApp({ '.github/ci.json': '{"autofix": {"exempt": ["PR visuals"]}}' });
    expect(() => main(['pending'], env, { ...io, root: bad })).toThrow('"autofix.exempt" must map');
  });
});
