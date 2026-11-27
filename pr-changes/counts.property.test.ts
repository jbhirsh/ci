import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blocks } from './changes.ts';
import { images, indexText, isLink, pairText, picture, readIndex, SIZES, svg } from './counts.ts';
import { GLYPHS, SPACE, UNITS } from './glyphs.ts';

const count = fc.integer({ min: 0, max: 1_000_000_000 });

describe('svg', () => {
  it('is well formed, drawn as shapes, and exactly as wide as its glyphs, for any pair', () => {
    fc.assert(
      fc.property(count, count, (added, removed) => {
        for (const look of SIZES) {
          const out = svg(added, removed, look);
          expect(out.startsWith('<svg ')).toBe(true);
          expect(out.endsWith('</svg>')).toBe(true);
          expect(out.match(/<g /g)).toHaveLength(1);
          expect(out.match(/<\/g>/g)).toHaveLength(1);
          const text = `+${added}−${removed}`;
          expect(out.match(/<path /g)).toHaveLength([...text].length);
          const advance = [...text].reduce((n, c) => n + GLYPHS[c].advance, 0) + SPACE;
          const width = Math.ceil((advance * look.size) / UNITS);
          expect(out).toContain(`width="${width}"`);
          expect(out).not.toMatch(/[^\x20-\x7e]/);
        }
      }),
    );
  });
});

describe('images', () => {
  it('give equal pairs equal hashes and different pairs different ones', () => {
    fc.assert(
      fc.property(count, count, count, count, (a, r, a2, r2) => {
        const x = images(a, r);
        const y = images(a2, r2);
        expect(x.map((i) => i.sha)).toEqual(images(a, r).map((i) => i.sha));
        if (a !== a2 || r !== r2) expect(x[0].sha).not.toBe(y[0].sha);
      }),
    );
  });
});

describe('picture', () => {
  it('carries the plain pair as its alt text, for any pair', () => {
    fc.assert(
      fc.property(count, count, (a, r) => {
        const link =
          'https://github.com/user-attachments/assets/0123abcd-0000-1111-2222-333344445555';
        expect(picture(a, r, { small: link, large: link })).toContain(`alt="${pairText(a, r)}"`);
      }),
    );
  });
});

describe('the index', () => {
  const entry = fc.tuple(fc.stringMatching(/^[0-9a-f]{64}$/), fc.uuid());

  it('reads back what it wrote, and never throws on any text', () => {
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 20 }), (entries) => {
        const links = new Map(
          entries.map(([sha, id]) => [sha, `https://github.com/user-attachments/assets/${id}`]),
        );
        expect(readIndex(blocks.write('', 'index', indexText(links)))).toEqual(links);
      }),
    );
    fc.assert(fc.property(fc.string(), (text) => void readIndex(text)));
  });

  it('only ever yields attachment links, whatever the description says', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 8 }), (parts) => {
        const body = `${blocks.write('', 'index', parts.join(' '))}\n${blocks.write('', 'staging', parts.join('\n'))}`;
        for (const link of readIndex(body).values()) expect(isLink(link)).toBe(true);
      }),
    );
  });
});
