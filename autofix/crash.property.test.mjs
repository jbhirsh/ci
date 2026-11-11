import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { crashed, markerFor, releasedBody } from './crash.mjs';

// The execution file is whatever claude-code-action left, and the comment
// body whatever the API returns: anything at all, as far as these know.
const sha = fc.stringMatching(/^[0-9a-f]{40}$/);
const fixer = fc.constantFrom(/** @type {const} */ ('ci'), /** @type {const} */ ('review'));

describe('crashed', () => {
  it('never throws, on any text or any JSON', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json(), fc.constant(null)), (text) => {
        expect(typeof crashed(text)).toBe('boolean');
      }),
    );
  });
  it('counts a run as having run once it holds an assistant message, wherever', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue()), fc.array(fc.jsonValue()), (before, after) => {
        const text = JSON.stringify([...before, { type: 'assistant' }, ...after]);
        expect(crashed(text)).toBe(false);
      }),
    );
  });
});

describe('releasedBody', () => {
  it('leaves no live marker for the head, whatever the body around it', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fixer, sha, (before, after, kind, head) => {
        const body = `${before}${markerFor(kind, head)}${after}`;
        const out = releasedBody(body, kind, head, 'https://example.com/run');
        expect(out).not.toContain(markerFor(kind, head));
        expect(out).toContain(`<!-- autofix-${kind}-crashed:${head} -->`);
      }),
    );
  });
});
