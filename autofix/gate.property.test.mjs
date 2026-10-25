import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { notGreen, pendingWorkflows } from './gate.mjs';

// The runs come from the API and the exemptions from the app: anything at
// all, as far as these functions know.
const name = fc.stringMatching(/^[A-Za-z0-9 ()._-]{1,20}$/).filter((n) => n.trim() !== '');
const status = fc.constantFrom('queued', 'in_progress', 'waiting', 'completed');
const run = fc.record({
  id: fc.nat(),
  name,
  path: name.map((n) => `.github/workflows/${n.replace(/\W/g, '')}.yml`),
  event: fc.constantFrom('pull_request', 'push', 'workflow_dispatch'),
  status,
  conclusion: fc.constantFrom(null, 'success', 'failure', 'cancelled'),
});

describe('pendingWorkflows', () => {
  it('names only unfinished newest pull_request runs, never autofix or an exempt one', () => {
    fc.assert(
      fc.property(fc.array(run), fc.array(name), (runs, exempt) => {
        const self = runs[0]?.path ?? '';
        const pending = pendingWorkflows(runs, { self, exempt });
        for (const n of pending) {
          expect(exempt).not.toContain(n);
          const mine = runs.filter(
            (r) => r.event === 'pull_request' && r.name === n && r.path !== self,
          );
          expect(mine.length).toBeGreaterThan(0);
          expect(mine.some((r) => r.status !== 'completed')).toBe(true);
        }
      }),
    );
  });

  it('is empty once every run has completed', () => {
    fc.assert(
      fc.property(fc.array(run), fc.array(name), (runs, exempt) => {
        const done = runs.map((r) => ({ ...r, status: 'completed' }));
        expect(pendingWorkflows(done, { self: '', exempt })).toEqual([]);
      }),
    );
  });
});

describe('notGreen', () => {
  it('gives one entry per file not green, never more than asked', () => {
    fc.assert(
      fc.property(fc.array(run), fc.array(name, { maxLength: 4 }), (runs, files) => {
        expect(notGreen(runs, files).length).toBeLessThanOrEqual(files.length);
      }),
    );
  });
});
