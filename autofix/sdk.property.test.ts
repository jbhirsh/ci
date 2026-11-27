import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allowedCommand } from './sdk.ts';

const PROGRAMS = ['git', 'npm', 'npx', 'gh', 'make'];

describe('allowedCommand, for any command', () => {
  it('allows one only when its first word is one of the programs', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.constantFrom(...PROGRAMS).map((p) => `${p} x`),
        ),
        fc.string(),
        (head, rest) => {
          const command = `${head} ${rest}`;
          const first = command.trim().split(/\s+/)[0] ?? '';
          expect(allowedCommand(command)).toBe(PROGRAMS.includes(first));
        },
      ),
    );
  });
});
