import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { jobsOf, runsAsJob } from './verify-check.mjs';

// A workflow's text is the app's, anything at all; lines like a
// workflow's make the generator reach the job-reading paths.
const line = fc.oneof(
  fc.string(),
  fc.constantFrom(
    'jobs:',
    '  e2e:',
    '    name: E2E',
    '    steps:',
    '      - run: npm test',
    '      - run: |',
    '          echo a',
    '      - uses: x@main',
    '    - run: y',
    '',
    '# note',
  ),
);
const workflow = fc.array(line, { maxLength: 30 }).map((lines) => lines.join('\n'));

describe('jobsOf, for any text', () => {
  it('never throws, and each job it reads has an id and only the steps it found', () => {
    fc.assert(
      fc.property(workflow, fc.string(), (text, command) => {
        const jobs = jobsOf(text);
        for (const job of jobs) {
          expect(job.id).toMatch(/^[\w-]+$/);
          for (const run of job.runs) expect(text).toContain(run.split('\n')[0]);
          expect(typeof runsAsJob(job, command)).toBe('boolean');
          // A job runs its own one-line steps, all of them, and not fewer.
          const steps = job.runs.filter((run) => !run.includes('\n'));
          if (
            steps.length > 0 &&
            steps.every((r) => r !== '' && !r.includes('&&') && r.trim() === r) &&
            new Set(steps).size === steps.length &&
            !job.uses.some((u) => u.startsWith('jbhirsh/ci/visual-baselines/compare@'))
          ) {
            expect(runsAsJob(job, steps.join(' && '))).toBe(true);
            if (steps.length > 1) {
              expect(runsAsJob(job, steps.slice(0, -1).join(' && '))).toBe(false);
            }
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});
