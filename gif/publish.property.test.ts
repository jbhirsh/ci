import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blocksFor } from '../lib/blocks.ts';
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
} from './publish.ts';

// A PR description is whatever its author and earlier runs wrote: build it
// from the pieces withBlock treats specially, and any text.
const key = fc.stringMatching(/^[\w.]{1,12}$/);
const piece = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.constantFrom(
    '<!-- pr-gif:a -->',
    '<!-- /pr-gif:a -->',
    '<!--',
    '-->',
    '\n',
    '\n\n',
    '<!-- pr-gif:a -->\n<!-- /pr-gif:a -->',
    '<!-- pr-gif:a -->\nRecorded automatically at `abc1234`.\nx\n<!-- /pr-gif:a -->',
  ),
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

  it('finds the block it wrote, last, whatever the description held', () => {
    fc.assert(
      fc.property(body, key, block, (text, k, b) => {
        const once = withBlock(text, k, b);
        const found = findBlock(once, k);
        const { start, end } = blockMarkers(k);
        expect(found).not.toBeNull();
        expect(once.slice(found?.from, found?.to)).toBe(`${start}\n${b}\n${end}`);
      }),
    );
  });

  it('keeps every other word of a description when it moves a block, and ends with one block of the new text', () => {
    const { start, end } = blockMarkers('a');
    const pairs = new RegExp(`${start}[\\s\\S]*?${end}`, 'g');
    const empty = `${start}\n${end}`;
    const auto = `${start}\nRecorded automatically at \`abcdef1\`.\nold\n${end}`;
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(empty, auto, 'text', 'more words', '\n\n', '\r\n'), {
          maxLength: 10,
        }),
        // A table, never a block with nothing in it (that reads as an empty pair).
        block.filter((b) => b.trim() !== ''),
        (parts, b) => {
          const held = parts.join('\n');
          const once = withBlock(held, 'a', b);
          const words = (t: string) => t.replace(pairs, '').replace(/\s+/g, '');
          expect(words(once)).toBe(words(held));
          const found = findBlock(once, 'a');
          expect(once.slice(found?.from, found?.to)).toBe(`${start}\n${b}\n${end}`);
          expect(withBlock(once, 'a', b)).toBe(once);
        },
      ),
    );
  });

  it('writes as it always did when the description has at most one pair of the scenario', () => {
    const plain = blocksFor('pr-gif');
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 12 }), { maxLength: 4 }),
        key,
        block,
        fc.constantFrom('', '\n', '\r\n\r\n', 'Recorded automatically at `abc1234`.\nx', 'mine'),
        (parts, k, b, inner) => {
          const { start, end } = blockMarkers(k);
          const text = parts.join('\n').replaceAll('pr-gif', 'x');
          for (const held of [text, `${text}\n\n${start}\n${inner}\n${end}\n\n${text}`]) {
            expect(withBlock(held, k, b)).toBe(plain.write(held, k, b));
          }
        },
      ),
    );
  });

  it("leaves the text outside the scenario's block as it was", () => {
    fc.assert(
      fc.property(body, key, block, block, (text, k, b1, b2) => {
        const { start, end } = blockMarkers(k);
        const once = withBlock(text, k, b1);
        const twice = withBlock(once, k, b2);
        const marked = (b: string) => `${start}\n${b}\n${end}`;
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
        const found = findBlock(once, k) as { from: number; to: number };
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
