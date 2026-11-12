import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isReason } from './reason.mjs';

// A reason is whatever someone wrote beside a setting.
describe('isReason, for any text', () => {
  it('never throws', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        isReason(text);
      }),
    );
  });

  it('never take a version label alone for a reason', () => {
    const label = fc
      .tuple(fc.constantFrom('', 'v'), fc.nat(99), fc.nat(99), fc.nat(99))
      .map(([v, a, b, c]) => `${v}${a}.${b}.${c}`);
    fc.assert(
      fc.property(label, (l) => {
        expect(isReason(` ${l}`)).toBe(false);
      }),
    );
  });
});
