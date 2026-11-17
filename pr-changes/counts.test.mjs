import { describe, expect, it } from 'vitest';
import { blocks } from './changes.mjs';
import {
  GREEN,
  hashOf,
  images,
  indexText,
  isLink,
  pairText,
  picture,
  RED,
  readIndex,
  SIZES,
  svg,
  WIDE,
} from './counts.mjs';
import { GLYPHS, RISE, SPACE, UNITS } from './glyphs.mjs';

const LINK = 'https://github.com/user-attachments/assets/0123abcd-0000-1111-2222-333344445555';
const LINK2 = 'https://github.com/user-attachments/assets/abcdef01-2222-3333-4444-555566667777';

describe('svg', () => {
  it('is the pair in green and red, drawn as shapes and not text, on a transparent background', () => {
    const out = svg(81, 37, SIZES[0]);
    expect(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(out.endsWith('</svg>')).toBe(true);
    expect(out.match(/fill="#3d874d"/g)).toHaveLength(3);
    expect(out.match(/fill="#b6605d"/g)).toHaveLength(3);
    expect(GREEN).toBe('#3d874d');
    expect(RED).toBe('#b6605d');
    expect(out).not.toContain('<text');
    expect(out).not.toContain('<rect');
    expect(out).not.toContain('font');
  });

  it('is as wide as its glyphs and as high as a digit plus its lift, at each size', () => {
    for (const look of SIZES) {
      const k = look.size / UNITS;
      const advance =
        ['+', '8', '1'].reduce((n, c) => n + GLYPHS[c].advance, 0) +
        SPACE +
        ['−', '3', '7'].reduce((n, c) => n + GLYPHS[c].advance, 0);
      const width = Math.ceil(advance * k);
      const height = Math.ceil(RISE * k) + look.lift;
      expect(svg(81, 37, look)).toContain(
        `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`,
      );
    }
  });

  it('lifts the 12px image 1px and not the 14px one', () => {
    expect(SIZES.map((s) => [s.size, s.lift])).toEqual([
      [12, 1],
      [14, 0],
    ]);
    expect(svg(1, 1, SIZES[0])).toContain('translate(0 9) scale(0.012)');
    expect(svg(1, 1, SIZES[1])).toContain('translate(0 11) scale(0.014)');
  });

  it('draws a pair with nothing in it: +0 −0', () => {
    expect(svg(0, 0, SIZES[0]).match(/<path/g)).toHaveLength(4);
  });
});

describe('images', () => {
  it('gives both sizes, named by their content hash and size alone', () => {
    const [small, large] = images(81, 37);
    expect(small.size).toBe(12);
    expect(large.size).toBe(14);
    expect(small.sha).toBe(hashOf(small.svg));
    expect(small.file).toBe(`${small.sha}-12.svg`);
    expect(large.file).toBe(`${large.sha}-14.svg`);
    expect(small.sha).not.toBe(large.sha);
  });

  it('gives the same pair the same hashes, and another pair others', () => {
    expect(images(1, 2)[0].sha).toBe(images(1, 2)[0].sha);
    expect(images(1, 2)[0].sha).not.toBe(images(2, 1)[0].sha);
  });
});

describe('picture', () => {
  it('shows the larger image from 768px up and the smaller otherwise, with the plain pair as alt text', () => {
    expect(WIDE).toBe(768);
    expect(picture(81, 37, { small: LINK, large: LINK2 })).toBe(
      `<picture><source media="(min-width: 768px)" srcset="${LINK2}"><img src="${LINK}" alt="+81 −37"></picture>`,
    );
    expect(pairText(81, 37)).toBe('+81 −37');
  });
});

describe('isLink', () => {
  it("accepts GitHub's attachment form and nothing else", () => {
    expect(isLink(LINK)).toBe(true);
    for (const bad of [
      `${LINK}?x=1`,
      `${LINK}"`,
      `${LINK} `,
      'http://github.com/user-attachments/assets/0123abcd-0000-1111-2222-333344445555',
      'https://github.com.evil.example/user-attachments/assets/0123abcd-0000-1111-2222-333344445555',
      'https://github.com/user-attachments/assets/ZZZZ',
      '',
    ]) {
      expect(isLink(bad)).toBe(false);
    }
  });
});

describe('the index', () => {
  const SHA = 'a'.repeat(64);
  const SHA2 = 'b'.repeat(64);

  it('is one hidden comment of hash=id entries, and reads back what it wrote', () => {
    const links = new Map([
      [SHA, LINK],
      [SHA2, LINK2],
    ]);
    const text = indexText(links);
    expect(text.startsWith('<!-- ')).toBe(true);
    expect(text.endsWith(' -->')).toBe(true);
    expect(readIndex(blocks.write('', 'index', text))).toEqual(links);
    expect(indexText(new Map())).toBe('');
  });

  it('reads only the index block and the staging block', () => {
    const outside = `<!-- ${SHA}=0123abcd-0000-1111-2222-333344445555 -->\n![${SHA}](${LINK})`;
    expect(readIndex(outside).size).toBe(0);
    const staging = blocks.write('', 'staging', `![${SHA}](${LINK})`);
    expect(readIndex(staging)).toEqual(new Map([[SHA, LINK]]));
  });

  it('keeps no entry whose link is not an attachment link', () => {
    const bad = `<!-- ${SHA}=not-an-id ${SHA2}=0123abcd-0000-1111-2222-33334444555 -->`;
    expect(readIndex(blocks.write('', 'index', bad)).size).toBe(0);
    const staged = blocks.write('', 'staging', `![${SHA}](https://example.com/x.svg)`);
    expect(readIndex(staged).size).toBe(0);
  });

  it('does not take the index for a marker of another tool', () => {
    expect(indexText(new Map([[SHA, LINK]]))).not.toMatch(/<!-- \/?[a-z][a-z0-9-]*:[^\s<>]+ -->/);
  });
});
