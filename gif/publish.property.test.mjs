import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blockMarkers, withBlock } from './publish.mjs';

// A PR description is whatever its author and earlier runs wrote: build it
// from the pieces withBlock treats specially, and any text.
const key = fc.stringMatching(/^[\w.]{1,12}$/);
const piece = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.constantFrom('<!-- pr-gif:a -->', '<!-- /pr-gif:a -->', '<!--', '-->', '\n', '\n\n'),
);
const body = fc.array(piece, { maxLength: 20 }).map((parts) => parts.join(''));
// A table never holds its own markers (attachmentTable writes Markdown).
const block = fc.string({ maxLength: 40 }).filter((b) => !b.includes('pr-gif:'));

describe('withBlock, for any description', () => {
  it('never throws, holds the block once between its markers, and is idempotent', () => {
    fc.assert(
      fc.property(body, key, block, (text, k, b) => {
        const once = withBlock(text, k, b);
        const { start, end } = blockMarkers(k);
        expect(once).toContain(`${start}\n${b}\n${end}`);
        expect(withBlock(once, k, b)).toBe(once);
      }),
    );
  });

  it("leaves the text outside the scenario's block as it was", () => {
    fc.assert(
      fc.property(body, key, block, block, (text, k, b1, b2) => {
        const { start, end } = blockMarkers(k);
        const once = withBlock(text, k, b1);
        const twice = withBlock(once, k, b2);
        const marked = (/** @type {string} */ b) => `${start}\n${b}\n${end}`;
        const at = once.indexOf(marked(b1));
        expect(twice.slice(0, at)).toBe(once.slice(0, at));
        expect(twice.slice(at + marked(b2).length)).toBe(once.slice(at + marked(b1).length));
        // Nothing of the description is lost: it's all still there, in order, around the block.
        if (!text.includes(end)) expect(once.startsWith(text.trimEnd())).toBe(true);
      }),
    );
  });

  it('refuses any name that could end the marker comment', () => {
    fc.assert(
      fc.property(fc.string(), (k) => {
        let markers;
        try {
          markers = blockMarkers(k);
        } catch {
          return;
        }
        expect(k.includes('--') || k.includes('>') || /\s/.test(k)).toBe(false);
        expect(markers.start.indexOf('-->')).toBe(markers.start.length - 3);
        expect(markers.end.indexOf('-->')).toBe(markers.end.length - 3);
      }),
    );
  });
});
