import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  artifactName,
  current,
  downloadRecord,
  history,
  parseRecord,
  pastJob,
  pastRuns,
} from './history.mjs';

const env = { GITHUB_REPOSITORY: 'jbhirsh/sift', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '' };

/**
 * A run as the Actions API gives it.
 *
 * @param {number} id
 * @param {string | null} branch
 * @param {string} created
 * @returns {import('./history.mjs').Run}
 */
const run = (id, branch, created) => ({
  id,
  run_number: id,
  html_url: `https://github.com/jbhirsh/sift/actions/runs/${id}`,
  head_branch: branch,
  head_sha: 'abc',
  created_at: created,
  workflow_id: 7,
});

/**
 * A fake gh answering API paths from a table, throwing for any other.
 *
 * @param {Record<string, unknown>} answers
 * @param {string[][]} [calls]
 * @returns {import('./history.mjs').Gh}
 */
const fakeGh =
  (answers, calls = []) =>
  (args) => {
    calls.push(args);
    const key = args[0] === 'api' ? args[1] : args.join(' ');
    if (!(key in answers)) throw new Error(`HTTP 404: ${key}`);
    return JSON.stringify(answers[key]);
  };

describe('artifactName', () => {
  it("is the job's name made safe for an artifact", () => {
    expect(artifactName('E2E Tests (Maestro)')).toBe('job-summary-e2e-tests-maestro');
    expect(artifactName('Against sift')).toBe('job-summary-against-sift');
    expect(artifactName('!!!')).toBe('job-summary-job');
  });
});

describe('current', () => {
  it("reads this attempt's jobs, the run and the default branch, attempt 1 by default", () => {
    /** @type {string[][]} */
    const calls = [];
    const gh = fakeGh(
      {
        'repos/jbhirsh/sift/actions/runs/42/attempts/1/jobs?per_page=100': {
          jobs: [{ name: 'Build' }],
        },
        'repos/jbhirsh/sift/actions/runs/42': run(42, 'pr', '2026-10-29T10:00:00Z'),
        'repos/jbhirsh/sift': { default_branch: 'main' },
      },
      calls,
    );
    expect(current(env, gh)).toEqual({
      run: run(42, 'pr', '2026-10-29T10:00:00Z'),
      defaultBranch: 'main',
      jobs: [{ name: 'Build' }],
    });
    expect(calls[0][1]).toContain('/attempts/1/');
  });

  it("names the API's error when it refuses, and says when the run can't be read", () => {
    expect(
      current(env, () => {
        throw new Error('gh: Resource not accessible by integration (HTTP 403)\nmore');
      }),
    ).toEqual({
      problem:
        "the run's jobs couldn't be read (gh: Resource not accessible by integration (HTTP 403)); the job needs actions: read.",
    });
    expect(
      current(env, () => {
        throw 'odd';
      }),
    ).toEqual({ problem: "the run's jobs couldn't be read (odd); the job needs actions: read." });
    const noRun = fakeGh({
      'repos/jbhirsh/sift/actions/runs/42/attempts/2/jobs?per_page=100': { jobs: [] },
    });
    expect(current(env, () => '{}')).toEqual({
      problem:
        "the run's jobs couldn't be read (no jobs in the answer); the job needs actions: read.",
    });
    expect(current({ ...env, GITHUB_RUN_ATTEMPT: '2' }, noRun)).toEqual({
      problem: "this run couldn't be read.",
    });
  });

  it("leaves the default branch empty when the repository can't be read", () => {
    const gh = fakeGh({
      'repos/jbhirsh/sift/actions/runs/42/attempts/1/jobs?per_page=100': { jobs: [] },
      'repos/jbhirsh/sift/actions/runs/42': run(42, 'pr', '2026-10-29T10:00:00Z'),
    });
    expect(current(env, gh)).toMatchObject({ defaultBranch: '' });
  });
});

describe('pastRuns', () => {
  const runs = (/** @type {string} */ branch) =>
    `repos/o/r/actions/workflows/7/runs?branch=${branch}&status=completed&created=%3C2026-10-29T10%3A00%3A00Z&per_page=2`;

  it("merges this branch's earlier runs and the default branch's, newest first", () => {
    const gh = fakeGh({
      [runs('feat%2Fx')]: {
        workflow_runs: [
          run(43, 'feat/x', '2026-10-29T11:00:00Z'),
          {
            ...run(39, 'feat/x', '2026-10-29T07:00:00Z'),
            head_repository: { full_name: 'fork/r' },
          },
          { ...run(38, 'feat/x', '2026-10-29T06:00:00Z'), head_repository: { full_name: 'o/r' } },
          run(42, 'feat/x', '2026-10-29T10:00:00Z'),
          run(40, 'feat/x', '2026-10-29T08:00:00Z'),
        ],
      },
      [runs('main')]: {
        workflow_runs: [
          run(41, 'main', '2026-10-29T09:00:00Z'),
          run(30, 'main', '2026-10-28T09:00:00Z'),
        ],
      },
    });
    expect(
      pastRuns('o/r', run(42, 'feat/x', '2026-10-29T10:00:00Z'), 'main', 2, gh).map((r) => r.id),
    ).toEqual([41, 40]);
  });

  it('asks once when the run is on the default branch, and skips a page that fails', () => {
    /** @type {string[][]} */
    const calls = [];
    expect(
      pastRuns('o/r', run(42, null, ''), 'main', 2, fakeGh({}, calls)).concat(
        pastRuns('o/r', run(42, 'main', ''), 'main', 2, fakeGh({}, calls)),
      ),
    ).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});

describe('pastJob', () => {
  it('finds the job by name, finished, in the run', () => {
    const gh = fakeGh({
      'repos/o/r/actions/runs/9/jobs?per_page=100': {
        jobs: [
          { name: 'E2E', completed_at: null },
          { name: 'E2E', completed_at: '2026-10-29T10:00:00Z' },
        ],
      },
    });
    expect(pastJob('o/r', run(9, 'main', ''), 'E2E', gh)).toEqual({
      name: 'E2E',
      completed_at: '2026-10-29T10:00:00Z',
    });
    expect(pastJob('o/r', run(9, 'main', ''), 'Other', gh)).toBeNull();
    expect(pastJob('o/r', run(8, 'main', ''), 'E2E', gh)).toBeNull();
  });
});

describe('parseRecord', () => {
  it("reads a record's tests, leaving out any it can't trust", () => {
    expect(
      parseRecord(
        JSON.stringify({
          version: 1,
          tests: [
            { name: 'A', seconds: 3, result: 'passed', extra: 1 },
            { name: 'B', seconds: '3', result: 'passed' },
            { name: 'C', seconds: 3, result: 'exploded' },
            null,
            { name: 'D', seconds: 0, result: 'passed on re-run' },
          ],
        }),
      ),
    ).toEqual({
      tests: [
        { name: 'A', seconds: 3, result: 'passed' },
        { name: 'D', seconds: 0, result: 'passed on re-run' },
      ],
      seconds: null,
    });
  });

  it("reads the job's time, with or without tests", () => {
    expect(parseRecord('{"seconds": 90, "tests": null}')).toEqual({ tests: null, seconds: 90 });
    expect(parseRecord('{"seconds": 90, "tests": []}')).toEqual({ tests: [], seconds: 90 });
    expect(parseRecord('{"seconds": -1, "tests": []}')).toEqual({ tests: [], seconds: null });
  });

  it("is null for what isn't a record", () => {
    expect(parseRecord('not json')).toBeNull();
    expect(parseRecord('null')).toBeNull();
    expect(parseRecord('{"tests": "no"}')).toBeNull();
  });
});

describe('downloadRecord', () => {
  it('downloads the artifact with gh and reads its JSON', () => {
    /** @type {string[][]} */
    const calls = [];
    const text = downloadRecord(
      (args) => {
        calls.push(args);
        const dir = args[args.indexOf('--dir') + 1];
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'job-summary-e2e.json'), '{"tests":[]}');
        return '';
      },
      'o/r',
      9,
      'job-summary-e2e',
    );
    expect(text).toBe('{"tests":[]}');
    expect(calls[0].slice(0, 7)).toEqual([
      'run',
      'download',
      '9',
      '--repo',
      'o/r',
      '--name',
      'job-summary-e2e',
    ]);
  });

  it('is null when the download fails or holds no JSON', () => {
    const fail = () => {
      throw new Error('no artifact');
    };
    expect(downloadRecord(fail, 'o/r', 9, 'x')).toBeNull();
    expect(downloadRecord(() => '', 'o/r', 9, 'x')).toBeNull();
  });
});

describe('history', () => {
  const now = run(4, 'main', '2026-10-29T10:00:00Z');
  const gh = fakeGh({
    'repos/o/r/actions/workflows/7/runs?branch=main&status=completed&created=%3C2026-10-29T10%3A00%3A00Z&per_page=3':
      {
        workflow_runs: [
          run(3, 'main', '2026-10-29T09:00:00Z'),
          run(2, 'main', '2026-10-29T08:00:00Z'),
          run(1, 'main', '2026-10-29T07:00:00Z'),
        ],
      },
    'repos/o/r/actions/runs/3/jobs?per_page=100': {
      jobs: [{ name: 'E2E', completed_at: '2026-10-29T09:20:00Z' }],
    },
    'repos/o/r/actions/runs/2/jobs?per_page=100': { jobs: [{ name: 'Lint', completed_at: 'x' }] },
    'repos/o/r/actions/runs/1/jobs?per_page=100': {
      jobs: [{ name: 'E2E', completed_at: '2026-10-29T07:20:00Z' }],
    },
  });

  it("gives each earlier run with the job its job and record's tests, skipping runs without it", () => {
    /** @type {[number, string][]} */
    const asked = [];
    const past = history('o/r', now, 'main', 'E2E', 3, gh, (id, artifact) => {
      asked.push([id, artifact]);
      return id === 3
        ? '{"seconds":70,"tests":[{"name":"T","seconds":1,"result":"passed"}]}'
        : null;
    });
    expect(past.map((p) => [p.run.id, p.tests, p.seconds])).toEqual([
      [3, [{ name: 'T', seconds: 1, result: 'passed' }], 70],
      [1, null, null],
    ]);
    expect(asked).toEqual([
      [3, 'job-summary-e2e'],
      [1, 'job-summary-e2e'],
    ]);
  });

  it('downloads the records with gh by default', () => {
    const past = history('o/r', now, 'main', 'E2E', 3, gh);
    expect(past.map((p) => p.tests)).toEqual([null, null]);
  });

  it('stops looking once its time is up, keeping what it read', () => {
    let t = 0;
    const clock = () => (t += 1000);
    const past = history('o/r', now, 'main', 'E2E', 3, gh, () => null, 1500, clock);
    expect(past.map((p) => p.run.id)).toEqual([3]);
  });
});
