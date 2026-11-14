import { describe, expect, it } from 'vitest';
import { cellText, escapeCaption, hostBlock, imageCell, pictureTable } from './table.mjs';

const url = (/** @type {number} */ i) => `https://github.com/user-attachments/assets/id-${i}`;

describe('hostBlock', () => {
  it("references each picture by its local path, for gh's --attach to rewrite, captions left out", () => {
    expect(
      hostBlock(
        [
          { path: 'light/before.png', caption: 'Light, before' },
          { path: 'a.png', caption: 'With ](./other.png) in it' },
        ],
        { target: '222', runId: '99' },
      ),
    ).toBe(
      [
        'Pictures for #222, from run 99.',
        '',
        '![light/before.png](./light/before.png)',
        '![a.png](./a.png)',
      ].join('\n'),
    );
  });
});

describe('escapeCaption', () => {
  it('turns what would end a cell or an attribute into entities', () => {
    expect(escapeCaption('a | b < c > d & e " f')).toBe(
      'a &#124; b &lt; c &gt; d &amp; e &quot; f',
    );
    expect(escapeCaption('&amp;')).toBe('&amp;amp;');
    expect(escapeCaption('one\r\ntwo\nthree')).toBe('one two three');
  });

  it('backslashes inline Markdown in a cell, so a caption is plain text', () => {
    expect(cellText('*a* _b_ `c` [d](e) ![f] ~g~ \\')).toBe(
      '\\*a\\* \\_b\\_ \\`c\\` \\[d\\]\\(e\\) \\!\\[f\\] \\~g\\~ \\\\',
    );
    expect(cellText('Light, before')).toBe('Light, before');
  });
});

describe('imageCell', () => {
  it('is one <img> with the width and the caption as its alt text', () => {
    expect(imageCell(url(1), 'Sift, "light"', 300)).toBe(
      `<img src="${url(1)}" width="300" alt="Sift, &quot;light&quot;">`,
    );
  });
});

describe('pictureTable', () => {
  const pictures = (/** @type {number} */ n) =>
    Array.from({ length: n }, (_, i) => ({ url: url(i), caption: `Shot ${i}` }));

  it('puts two side by side under their captions, as the plan showed', () => {
    expect(pictureTable(pictures(2), { columns: 2, width: 300 })).toBe(
      [
        '| Shot 0 | Shot 1 |',
        '| --- | --- |',
        `| ${imageCell(url(0), 'Shot 0', 300)} | ${imageCell(url(1), 'Shot 1', 300)} |`,
      ].join('\n'),
    );
  });

  it('starts a row each `columns` pictures, its captions in bold, the last one padded', () => {
    const lines = pictureTable(pictures(5), { columns: 2, width: 200 }).split('\n');
    expect(lines).toHaveLength(2 + 1 + 2 + 2);
    expect(lines[0]).toBe('| Shot 0 | Shot 1 |');
    expect(lines[3]).toBe('| **Shot 2** | **Shot 3** |');
    expect(lines[5]).toBe('| **Shot 4** |  |');
    expect(lines[6]).toBe(`| ${imageCell(url(4), 'Shot 4', 200)} |  |`);
    // Every row has as many cells as the header.
    for (const line of lines) expect(line.split(' | ')).toHaveLength(2);
  });

  it('is no wider than its pictures, and as wide as four', () => {
    expect(pictureTable(pictures(1), { columns: 4, width: 300 }).split('\n')[1]).toBe('| --- |');
    const four = pictureTable(pictures(8), { columns: 4, width: 300 }).split('\n');
    expect(four[1]).toBe('| --- | --- | --- | --- |');
    expect(four).toHaveLength(5);
    expect(pictureTable(pictures(3), { columns: 1, width: 300 }).split('\n')).toHaveLength(7);
  });

  it('escapes each caption, in its header and its alt text', () => {
    const table = pictureTable([{ url: url(0), caption: 'a|b <i>' }], { columns: 2, width: 9 });
    expect(table).toBe(
      [
        '| a&#124;b &lt;i&gt; |',
        '| --- |',
        `| <img src="${url(0)}" width="9" alt="a&#124;b &lt;i&gt;"> |`,
      ].join('\n'),
    );
  });
});
