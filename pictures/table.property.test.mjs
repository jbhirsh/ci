import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { imageCell, pictureTable } from './table.mjs';

// A caption is whatever the dispatcher typed: any text, and text built from
// what could end a cell, a tag, an attribute, a line or the bold around it.
const caption = fc.oneof(
  fc.string(),
  fc
    .array(
      fc.oneof(
        fc.string({ maxLength: 6 }),
        fc.constantFrom(
          '|',
          '<',
          '>',
          '"',
          '&',
          '\\',
          '*',
          '**',
          '`',
          '[',
          ']',
          '(',
          ')',
          '\n',
          '\r',
        ),
      ),
      { maxLength: 12 },
    )
    .map((parts) => parts.join('')),
);
const url = 'https://github.com/user-attachments/assets/x';

/**
 * The line's cells, split at each `|` no backslash escapes, without the
 * empty ends outside the first and last pipes.
 *
 * @param {string} line
 */
const cells = (line) => line.split(/(?<!\\)\|/).slice(1, -1);

describe('a table cell, for any caption', () => {
  it('escapes it: the cell is one <img> tag, with no | to end the cell', () => {
    fc.assert(
      fc.property(caption, fc.integer({ min: 1, max: 10_000 }), (text, width) => {
        const cell = imageCell(url, text, width);
        expect(cell).not.toMatch(/[|\r\n]/);
        expect(cell.match(/</g)).toHaveLength(1);
        expect(cell.match(/>/g)).toHaveLength(1);
        // src, width and alt: three attributes, each quoted once.
        expect(cell.match(/"/g)).toHaveLength(6);
        expect(cell.startsWith(`<img src="${url}" width="${width}" alt="`)).toBe(true);
        expect(cell.endsWith('">')).toBe(true);
        // Every & starts one of the entities the escape writes.
        expect(cell).toMatch(/^(?:[^&]|&(?:amp|lt|gt|quot|#124);)*$/);
      }),
    );
  });
});

describe('pictureTable, for any captions', () => {
  it('has a header, then a caption row and a picture row a row, each `columns` cells wide', () => {
    fc.assert(
      fc.property(
        fc.array(caption, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 4 }),
        (captions, columns) => {
          const pictures = captions.map((c) => ({ url, caption: c }));
          const lines = pictureTable(pictures, { columns, width: 300 }).split('\n');
          const wide = Math.min(columns, captions.length);
          const rows = Math.ceil(captions.length / wide);
          expect(lines).toHaveLength(2 * rows + 1);
          for (const line of lines) {
            expect(line.startsWith('| ')).toBe(true);
            expect(line.endsWith(' |')).toBe(true);
            expect(line).not.toMatch(/\r/);
            expect(cells(line)).toHaveLength(wide);
          }
          expect(cells(lines[1]).every((c) => c.trim() === '---')).toBe(true);
          // Each picture, in order, once.
          const shown = lines.flatMap((l) => l.match(/<img [^>]*>/g) ?? []);
          expect(shown).toHaveLength(captions.length);
          // A bold caption row stays bold: no unescaped * runs into its **.
          for (let r = 1; r < rows; r++) {
            for (const c of cells(lines[1 + 2 * r])
              .map((x) => x.trim())
              .filter(Boolean)) {
              expect(c).toMatch(/^\*\*(?:[^*\\]|\\.)*\*\*$/s);
            }
          }
        },
      ),
    );
  });
});
