import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ACTIONS_APP, PASSED, checkRunsFromApi, decide, statusesFromApi } from './carry.mjs';

const RUN_ID = '900';
const NAMES = ['Unit', 'Lint', 'E2E', 'smoke', 'Vercel'];
const CONCLUSIONS = [
  'success',
  'skipped',
  'neutral',
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
];

// Any mix of A's check runs (by any app, this run's own among them, in any
// state) and statuses, as the API hands them over.
const apiRuns = fc.uniqueArray(
  fc.record({
    id: fc.integer({ min: 1, max: 10_000 }),
    name: fc.constantFrom(...NAMES),
    conclusion: fc.option(fc.constantFrom(...CONCLUSIONS)),
    app: fc.constantFrom(ACTIONS_APP, 7),
    own: fc.boolean(),
  }),
  { selector: (r) => r.id, maxLength: 20 },
);
const apiStatuses = fc.uniqueArray(
  fc.record({
    context: fc.constantFrom(...NAMES),
    state: fc.constantFrom('pending', 'success', 'failure', 'error'),
  }),
  { selector: (s) => s.context },
);
const required = fc.uniqueArray(
  fc.record({
    context: fc.constantFrom(...NAMES),
    app: fc.constantFrom(ACTIONS_APP, null),
  }),
  { selector: (r) => `${r.context}|${r.app}` },
);

describe('decide, for any mix of results', () => {
  it('carries over only when every kept check but the visual one passed, and never a failure', () => {
    fc.assert(
      fc.property(apiRuns, apiStatuses, required, (raw, rawStatuses, req) => {
        const runs = checkRunsFromApi({
          check_runs: raw.map((r) => {
            const url = `https://github.com/o/r/actions/runs/${r.own ? RUN_ID : r.id + 1000}/job/${r.id}`;
            return {
              id: r.id,
              name: r.name,
              status: r.conclusion ? 'completed' : 'queued',
              conclusion: r.conclusion,
              html_url: url,
              app: { id: r.app },
            };
          }),
        });
        const statuses = statusesFromApi({ statuses: rawStatuses });
        const d = decide({ required: req, runs, statuses, verifyCheck: 'E2E', runId: RUN_ID });

        // What each kept check's newest result is, read independently.
        const verdicts = req
          .filter((r) => r.context !== 'E2E')
          .map(({ context, app }) => {
            const newest = raw
              .filter((r) => !r.own && r.name === context && (app === null || r.app === app))
              .sort((x, y) => y.id - x.id)[0];
            if (newest) {
              if (!newest.conclusion) return 'running';
              return PASSED.includes(newest.conclusion) ? 'passed' : 'failed';
            }
            const status =
              app === null ? rawStatuses.find((s) => s.context === context) : undefined;
            if (!status) return 'missing';
            if (status.state === 'pending') return 'running';
            // Only Vercel's status reports on the new commit itself.
            return status.state === 'success' && status.context === 'Vercel' ? 'passed' : 'failed';
          });

        if (d.kind === 'ready') {
          expect(verdicts.every((v) => v === 'passed')).toBe(true);
          for (const run of d.carry) {
            expect(PASSED).toContain(run.conclusion);
            expect(run.name).not.toBe('E2E');
            expect(run.links.some((l) => l.includes(`/runs/${RUN_ID}/`))).toBe(false);
            expect(req.some((r) => r.context === run.name)).toBe(true);
          }
        } else if (d.kind === 'wait') {
          expect(verdicts).not.toContain('failed');
          expect(verdicts.some((v) => v === 'running' || v === 'missing')).toBe(true);
        } else if (d.kind === 'missing') {
          expect(verdicts).toContain('missing');
          expect(verdicts.some((v) => v === 'failed' || v === 'running')).toBe(false);
        } else {
          expect(verdicts).toContain('failed');
          expect(d.reasons.length).toBeGreaterThan(0);
        }
        if (verdicts.includes('failed')) expect(d.kind).toBe('refuse');
      }),
      { numRuns: 500 },
    );
  });
});
