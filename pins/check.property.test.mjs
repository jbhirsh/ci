import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { caretFor, isPinnedRange, isReason, pinOnLine, rangeOf } from './check.mjs';

// A package.json, a workflow or a comment is whatever someone wrote.
describe('the parsers, for any text', () => {
  it('never throw', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        isReason(text);
        pinOnLine(text);
        caretFor(text);
        const range = rangeOf(text);
        if (range !== null) isPinnedRange(range);
      }),
    );
  });

  it('never call a caret a pin, and always offer one in place of a pinned version', () => {
    const version = fc
      .tuple(fc.nat(99), fc.nat(99), fc.nat(99))
      .map(([a, b, c]) => `${a}.${b}.${c}`);
    fc.assert(
      fc.property(version, fc.constantFrom('', '~', '='), (v, op) => {
        expect(isPinnedRange(`^${v}`)).toBe(false);
        expect(isPinnedRange(`${op}${v}`)).toBe(true);
        expect(caretFor(`${op}${v}`)).toBe(`^${v}`);
        expect(isPinnedRange(caretFor(`${op}${v}`) ?? '')).toBe(false);
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
