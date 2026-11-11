import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseInputs, recordRuns } from './workflow.mjs';

// What a person types into the dispatch form, or a Claude session sends
// through the API: any text, with the pieces paths and options are made of.
const word = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom('a.ts', 'scripts/gif-scenarios/x.ts', '..', '-', '--dir', '/', ';', '$(x)', ' '),
);
const text = fc.array(word, { maxLength: 6 }).map((parts) => parts.join(''));
const flag = fc.oneof(fc.constantFrom('true', 'false', undefined), fc.string({ maxLength: 5 }));

describe('parseInputs, for any inputs', () => {
  it('only ever accepts a PR number and scenario paths inside the app, never an option', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.nat().map(String), text),
        text,
        flag,
        flag,
        (PR, SCENARIOS, SIDE_BY_SIDE, AFTER_ONLY) => {
          let inputs;
          try {
            inputs = parseInputs({ PR, SCENARIOS, SIDE_BY_SIDE, AFTER_ONLY });
          } catch (error) {
            expect(String(error)).toMatch(/^Error: pr-gif: /);
            return;
          }
          expect(inputs.pr).toMatch(/^[1-9]\d*$/);
          for (const file of inputs.scenarios) {
            expect(file).not.toMatch(/^[-/.]/);
            expect(file.split('/')).not.toContain('..');
            expect(file).toMatch(/^[\w./-]+$/);
          }
          expect(inputs.sideBySide && inputs.afterOnly).toBe(false);
          // Each run's first argument is the scenario (or the PR): no option.
          for (const source of /** @type {const} */ (['web', 'ci-videos'])) {
            try {
              for (const args of recordRuns(source, inputs)) expect(args[0]).not.toMatch(/^-/);
            } catch (error) {
              expect(String(error)).toMatch(/^Error: pr-gif: /);
            }
          }
        },
      ),
    );
  });
});
