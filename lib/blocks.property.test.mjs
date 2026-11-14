import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blocksFor } from './blocks.mjs';

const ours = blocksFor('pictures');
const theirs = blocksFor('pr-gif');

// A description is whatever its author and earlier runs wrote: built from
// the pieces blocks treat specially (ours and another tool's markers), and
// any text.
const key = fc.stringMatching(/^[\w.]{1,12}$/);
const piece = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.constantFrom(
    '<!-- pictures:a -->',
    '<!-- /pictures:a -->',
    '<!-- pr-gif:a -->',
    '<!-- /pr-gif:a -->',
    '<!--',
    '-->',
    '\n',
    '\n\n',
  ),
);
const body = fc.array(piece, { maxLength: 20 }).map((parts) => parts.join(''));
// A block's content never holds its own markers.
const block = fc.string({ maxLength: 40 }).filter((b) => !b.includes('pictures:'));

describe('blocks, for any description', () => {
  it('reads back the block it wrote, once, and writing it again changes nothing', () => {
    fc.assert(
      fc.property(body, key, block, (text, k, b) => {
        const once = ours.write(text, k, b);
        const found = ours.find(once, k);
        const { start, end } = ours.markers(k);
        expect(found && once.slice(found.from, found.to)).toBe(`${start}\n${b}\n${end}`);
        expect(ours.write(once, k, b)).toBe(once);
        expect(ours.keys(once)).toContain(k);
      }),
    );
  });

  it('leaves the text outside the block as it was when it replaces it', () => {
    fc.assert(
      fc.property(body, key, block, block, (text, k, b1, b2) => {
        const once = ours.write(text, k, b1);
        const twice = ours.write(once, k, b2);
        const at = /** @type {{ from: number; to: number }} */ (ours.find(once, k));
        expect(twice.slice(0, at.from)).toBe(once.slice(0, at.from));
        const after = /** @type {{ from: number; to: number }} */ (ours.find(twice, k));
        expect(twice.slice(after.to)).toBe(once.slice(at.to));
      }),
    );
  });

  it("never touches another prefix's blocks when it adds its own", () => {
    fc.assert(
      fc.property(body, key, block, (text, k, b) => {
        // A block of ours around one of theirs would take it along when replaced.
        fc.pre(ours.find(text, k) === null);
        const before = theirs.keys(text).map((t) => {
          const f = /** @type {{ from: number; to: number }} */ (theirs.find(text, t));
          return text.slice(f.from, f.to);
        });
        const after = ours.write(text, k, b);
        for (const span of before) expect(after).toContain(span);
      }),
    );
  });

  it('takes back what it put into a description that had no such block', () => {
    fc.assert(
      fc.property(body, key, block, (text, k, b) => {
        fc.pre(!text.includes(`pictures:${k} `));
        expect(ours.remove(ours.write(text, k, b), k)).toBe(text.trimEnd());
      }),
    );
  });

  it('refuses any key that could end the marker comment, and nothing else throws', () => {
    fc.assert(
      fc.property(fc.string(), body, (k, text) => {
        let markers;
        try {
          markers = ours.markers(k);
        } catch (error) {
          expect(String(error)).toContain("can't mark its block");
          return;
        }
        expect(k.includes('--') || /[\s<>]/.test(k) || k === '').toBe(false);
        expect(markers.start.indexOf('-->')).toBe(markers.start.length - 3);
        expect(() => ours.keys(text)).not.toThrow();
      }),
    );
  });
});
