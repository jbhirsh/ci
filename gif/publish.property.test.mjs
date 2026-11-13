import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  blockKeys,
  blockMarkers,
  findBlock,
  isAutomatic,
  recordedLine,
  staleNote,
  staleText,
  withBlock,
  withoutBlock,
} from './publish.mjs';

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

describe('withoutBlock and staleNote, for any description', () => {
  it('takes back what withBlock put into a description that had no such block', () => {
    fc.assert(
      fc.property(body, key, block, (text, k, b) => {
        fc.pre(!text.includes(`pr-gif:${k} `));
        expect(withoutBlock(withBlock(text, k, b), k)).toBe(text.trimEnd());
      }),
    );
  });

  it('marks idempotently, only inside the block, and unmarks back', () => {
    const sha = fc.stringMatching(/^[0-9a-f]{40}$/);
    fc.assert(
      fc.property(body, key, block, sha, (text, k, b, s) => {
        const once = withBlock(text, k, b);
        const note = staleText(s, 'https://github.com/o/r/actions/runs/1');
        const marked = staleNote(once, k, note);
        expect(staleNote(marked, k, note)).toBe(marked);
        const found = /** @type {{ from: number; to: number }} */ (findBlock(once, k));
        expect(marked.slice(0, found.from)).toBe(once.slice(0, found.from));
        const tail = once.length - found.to;
        expect(marked.slice(marked.length - tail)).toBe(once.slice(found.to));
        if (!b.startsWith('**Not updated for ')) expect(staleNote(marked, k, null)).toBe(once);
      }),
    );
  });
});

describe('blockKeys and isAutomatic, for any description', () => {
  const sha = fc.stringMatching(/^[0-9a-f]{40}$/);

  it('never throw, and name only whole blocks', () => {
    fc.assert(
      fc.property(body, key, (text, k) => {
        for (const found of blockKeys(text)) expect(findBlock(text, found)).not.toBeNull();
        if (isAutomatic(text, k)) expect(blockKeys(text)).toContain(k);
      }),
    );
  });

  it('tell a block an automatic run wrote from one written by hand, whatever surrounds it', () => {
    fc.assert(
      fc.property(body, key, block, sha, fc.boolean(), (text, k, b, s, automatic) => {
        const once = withBlock(text, k, `${recordedLine(s, { automatic })}\n\n${b}`);
        expect(blockKeys(once)).toContain(k);
        expect(isAutomatic(once, k)).toBe(automatic);
        const marked = staleNote(once, k, staleText(s, 'u'));
        expect(isAutomatic(marked, k)).toBe(automatic);
      }),
    );
  });
});
