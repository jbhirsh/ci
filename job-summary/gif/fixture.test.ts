import { describe, expect, it } from 'vitest';
import { buildModel } from '../model.ts';
import { fixture } from './fixture.ts';

describe('fixture', () => {
  const model = buildModel(fixture());

  it('is a run of Check with its steps, tests and five earlier runs', () => {
    expect(model).toMatchObject({ repo: 'jbhirsh/ci', job: 'Check', problem: '' });
    expect(model.steps).toHaveLength(11);
    expect(model.tests).toHaveLength(11);
    expect(model.runs).toHaveLength(5);
    expect(model.runs.map((r) => r.number)).toEqual([395, 396, 397, 398, 399]);
  });

  it('gives every step and test a usual time, and lines their earlier runs up', () => {
    for (const s of model.steps) {
      expect(s.usual).not.toBeNull();
      expect(s.past).toHaveLength(5);
      expect(s.past.every((v) => v !== null)).toBe(true);
    }
    for (const t of model.tests ?? []) {
      expect(t.usual).not.toBeNull();
      expect(t.hist).toEqual(['passed', 'passed', 'passed', 'passed', 'passed']);
    }
  });

  it('runs one step and one test slower than usual, and fails none', () => {
    expect(model.steps.filter((s) => s.slower).map((s) => s.name)).toEqual([
      'Run npm run test:coverage',
    ]);
    expect((model.tests ?? []).filter((t) => t.slower).map((t) => t.title)).toEqual([
      'plays the scenario against the routed page',
    ]);
    expect((model.tests ?? []).every((t) => t.result === 'passed' && !t.flaky)).toBe(true);
  });

  it('places each step after the one before it, from the job start', () => {
    expect(model.steps[0].start).toBe(0);
    for (let k = 1; k < model.steps.length; k++) {
      const before = model.steps[k - 1];
      expect(model.steps[k].start).toBe(before.start + before.seconds);
    }
    expect(model.seconds).toBe(model.steps.reduce((sum, s) => sum + s.seconds, 0) + 5);
  });

  it('is the same run every time, whatever the clock says', () => {
    expect(buildModel(fixture())).toEqual(model);
  });

  it("measures three requests against main's eight probe runs, games carrying the cold start", () => {
    const m = model.measurements;
    expect(m?.ops.map((op) => op.name)).toEqual(['games', 'session', 'wishlistVotes']);
    expect(m?.runs).toHaveLength(8);
    expect(m).toMatchObject({ environment: 'preview', usualEnvironment: 'production' });
    const cold = m?.rows.filter((r) => r.start === 'cold').map((r) => `${r.op} ${r.key}`);
    expect(cold).toEqual(expect.arrayContaining(['games loaded', 'games deps', 'games db-open']));
    expect(cold?.every((r) => r.startsWith('games '))).toBe(true);
  });

  it('measures only Games.bgg slower than usual, warm', () => {
    expect(model.measurements?.rows.filter((r) => r.slower).map((r) => [r.label, r.start])).toEqual(
      [['Games.bgg', 'warm']],
    );
  });

  it('links each earlier run to its report', () => {
    expect(model.runs[4].url).toBe('https://jbhirsh.github.io/ci/runs/8999/check/');
  });
});
