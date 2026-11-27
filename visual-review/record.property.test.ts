import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blocks } from '../describe/describe.ts';
import { withoutAppended } from './attach.ts';
import { ownEdit } from './find.ts';
import { assetLink, BOT, outsideOwnBlocks, parseRecord, recordLine } from './record.ts';

const hex = (/** @type {number} */ n) =>
  fc.string({ unit: fc.constantFrom(...'0123456789abcdef'), minLength: n, maxLength: n });
const record = fc.record({
  sha: hex(40),
  fingerprint: hex(8),
  format: fc.integer({ min: 1, max: 9999 }),
  layout: hex(8),
  run: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  assets: fc.array(fc.uuid({ version: 4 }), { maxLength: 50 }),
});
/** Text a person might type around the blocks: anything but our own markers. */
const prose = fc.string().filter((s) => !s.includes('<!--') && !s.includes('-->'));

describe('parseRecord, for any description', () => {
  it('never throws, and reads back any record it wrote, whatever surrounds it', () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        parseRecord(body);
      }),
    );
    fc.assert(
      fc.property(prose, record, prose, (before, r, after) => {
        const body = blocks.write(before, BOT, `${recordLine(r)}\n${after}`);
        expect(parseRecord(body)).toEqual(r);
      }),
    );
  });
});

describe('ownEdit, for any description', () => {
  it("calls any change inside the block or a slot the upload's, and any outside an author's", () => {
    fc.assert(
      fc.property(prose, prose, prose, prose, (around, slotText, a, b) => {
        const slot = (/** @type {string} */ text) =>
          `<!-- describe:visual-review:s -->\n${text}\n<!-- /describe:visual-review:s -->`;
        const was = blocks.write(`${around}\n${slot(slotText)}`, BOT, a);
        const now = blocks.write(`${around}\n${slot(b)}`, BOT, b);
        const edit = {
          action: 'edited',
          changes: { body: { from: was } },
          pull_request: { body: now },
        };
        expect(ownEdit(edit)).toBe(true);
        const theirs = { ...edit, pull_request: { body: `${now}\n\nx${around}` } };
        expect(ownEdit(theirs)).toBe(false);
      }),
    );
  });

  it('never throws on any payload', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (changes, pr) => {
        ownEdit({
          action: 'edited',
          changes: /** @type {never} */ (changes),
          pull_request: /** @type {never} */ (pr ?? {}),
        });
      }),
    );
    fc.assert(
      fc.property(fc.string(), (body) => {
        outsideOwnBlocks(body);
      }),
    );
  });
});

describe('withoutAppended, for any description', () => {
  it('drops exactly the images appended after what was meant, and keeps any other text', () => {
    fc.assert(
      fc.property(
        prose,
        fc.array(fc.uuid({ version: 4 }), { minLength: 1, maxLength: 5 }),
        (meant, ids) => {
          const appended = ids.map((id) => `\n![x](${assetLink(id)})`).join('');
          expect(withoutAppended(`${meant}${appended}`, meant)).toBe(`${meant.trimEnd()}\n`);
        },
      ),
    );
    fc.assert(
      fc.property(fc.string(), fc.string(), (body, meant) => {
        const out = withoutAppended(body, meant);
        expect(out === body || body.startsWith(out.trimEnd())).toBe(true);
      }),
    );
  });
});
