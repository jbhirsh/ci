import { describe, expect, it } from 'vitest';
import { keyOf, lines, pick, renderTable } from './table.mjs';

const columns = [
  { label: 'Mobile', file: ['{state}-mobile-linux.png'] },
  { label: 'Desktop', file: ['{state}-desktop-linux.png'], width: 400 },
];
const DIFF = Buffer.from('d');
/** @type {import('./compare.mjs').Change[]} */
const changes = [
  { file: 'm/trips-desktop-linux.png', kind: 'changed', ratio: 0.1, diff: DIFF, after: 'a1' },
  { file: 'm/trips-mobile-linux.png', kind: 'changed', ratio: 0.1, diff: DIFF, after: 'a2' },
  { file: 'm/new-mobile-linux.png', kind: 'added', after: 'a3' },
  { file: 'odd.png', kind: 'removed', after: '' },
];

describe('lines', () => {
  it("pairs a screen's sizes next to each other, in the columns' order, then the rest", () => {
    expect(lines(changes, columns).map((l) => [l.label, l.width])).toEqual([
      ['trips, mobile', 300],
      ['trips, desktop', 400],
      ['new, mobile', 300],
      ['odd.png', 300],
    ]);
  });
});

describe('pick', () => {
  it('takes before and after first, then the diffs, up to the limit', () => {
    const rows = lines(changes, columns);
    expect(pick(rows).map(keyOf)).toEqual([
      'before:m/trips-mobile-linux.png',
      'after:m/trips-mobile-linux.png',
      'before:m/trips-desktop-linux.png',
      'after:m/trips-desktop-linux.png',
      'after:m/new-mobile-linux.png',
      'before:odd.png',
      'diff:m/trips-mobile-linux.png',
      'diff:m/trips-desktop-linux.png',
    ]);
    expect(pick(rows, 3)).toHaveLength(3);
  });
});

describe('renderTable', () => {
  it('shows before and after inline, the diffs folded, new and removed by name', () => {
    const rows = lines(changes, columns);
    const links = new Map(pick(rows).map((p) => [keyOf(p), `https://u/${keyOf(p)}`]));
    const md = renderTable({ rows, links, base: '0123456789' });
    expect(md).toContain('### Visual changes: 4 screens, compared with main at `0123456`');
    expect(md).toContain(
      '| trips, mobile | <img src="https://u/before:m/trips-mobile-linux.png" alt="trips, mobile, before" width="300"> |',
    );
    expect(md).toContain('| new, mobile | new | <img');
    expect(md).toContain('| odd.png | <img');
    expect(md).toMatch(/\| odd\.png \| <img [^|]*> \| removed \|/);
    expect(md).toContain('<details><summary>Show diffs</summary>');
    expect(md).toContain('| trips, desktop | <img src="https://u/diff:m/trips-desktop-linux.png"');
  });

  it('says when a picture was left out, and has no diffs section without diffs', () => {
    const rows = lines([changes[2]], columns);
    const md = renderTable({ rows, links: new Map(), base: 'abc' });
    expect(md).toContain('1 screen,');
    expect(md).toContain('not shown (too many pictures)');
    expect(md).not.toContain('<details>');
  });

  it('escapes what could break the table or mention someone', () => {
    const rows = [
      {
        label: 'a|b @x',
        width: 300,
        change: /** @type {import('./compare.mjs').Change} */ ({
          file: 'x.png',
          kind: 'added',
          after: '',
        }),
      },
    ];
    const md = renderTable({ rows, links: new Map([['after:x.png', 'https://u/"x']]), base: 'a' });
    expect(md).toContain('a&#124;b &#64;x');
    expect(md).toContain('src="https://u/&quot;x"');
  });
});
