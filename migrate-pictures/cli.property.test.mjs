import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.mjs';

const word = fc.oneof(
  fc.constantFrom(
    'inventory',
    'plan',
    'upload',
    '--repo',
    '--state',
    '--host',
    '--repos',
    '--include-others',
    '--minutes',
    '--branch',
    'o/app',
    '12',
    '-1',
    'a b',
    '../x',
    '',
  ),
  fc.string({ maxLength: 12 }),
);

describe('parseArgs, for any command line', () => {
  it('returns checked arguments or throws an Error saying why', () => {
    fc.assert(
      fc.property(fc.array(word, { maxLength: 10 }), (argv) => {
        let args;
        try {
          args = parseArgs(argv);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          return;
        }
        expect(args.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
        expect(args.repos.map((r) => r.toLowerCase())).toContain(args.repo.toLowerCase());
        for (const r of args.repos) expect(r).toMatch(/^[\w.-]+\/[\w.-]+$/);
        expect(args.state).not.toBe('');
        expect(args.host === null || (Number.isInteger(args.host) && args.host > 0)).toBe(true);
        expect(args.minutes).toBeGreaterThan(0);
        if (args.step === 'upload') expect(args.host).not.toBeNull();
      }),
    );
  });
});
