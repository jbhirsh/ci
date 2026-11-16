import { describe, expect, it } from 'vitest';
import { parseUpload, SECTION, uploadMarker, withSections } from '../describe/describe.mjs';
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

describe('lines, for the parts', () => {
  it("carries each paired row's state and size, and a shot no column takes has neither", () => {
    expect(lines(changes, columns).map((l) => [l.state, l.size])).toEqual([
      ['trips', 'mobile'],
      ['trips', 'desktop'],
      ['new', 'mobile'],
      [undefined, undefined],
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
    expect(md).toContain('### Visual changes: 3 screens, compared with main at `0123456`');
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

  it('writes the heading and a part a screen, each a folded-open details with its sizes', () => {
    const rows = lines(changes, columns);
    const links = new Map(pick(rows).map((p) => [keyOf(p), `https://u/${keyOf(p)}`]));
    const md = renderTable({ rows, links, base: '0123456789' });
    const keys = [...md.matchAll(/^<!-- describe-part:(\S+) -->$/gm)].map((m) => m[1]);
    expect(keys).toEqual(['head', 'screen:trips', 'screen:new', 'rest']);
    expect(md).toContain(
      '<details open><summary><b>trips</b>: mobile, desktop</summary>\n\n| Screen',
    );
    expect(md).toContain('<details open><summary><b>new</b>: mobile</summary>');
    // The rows with no state of their own stay together, and need no fold.
    expect(md.split('<!-- describe-part:rest -->')[1]).not.toContain('<details open>');
  });

  it('counts screens, not their sizes, and merges a state in two folders into one part', () => {
    const rows = lines(changes, columns);
    const twice = [
      ...rows,
      { ...rows[0], change: { ...rows[0].change, file: 'other/trips-mobile-linux.png' } },
    ];
    const md = renderTable({ rows: twice, links: new Map(), base: 'abc' });
    expect(md).toContain('### Visual changes: 3 screens,');
    expect(md.match(/<!-- describe-part:screen:trips -->/g)).toHaveLength(1);
    expect(md).toContain('<summary><b>trips</b>: mobile, desktop</summary>');
  });

  it("keeps a state a marker can't hold out of the parts, and escapes what it names", () => {
    const mk = (/** @type {string} */ state) => ({
      label: `${state}, mobile`,
      width: 300,
      state,
      size: 'mobile',
      change: /** @type {import('./compare.mjs').Change} */ ({
        file: 'x.png',
        kind: 'added',
        after: '',
      }),
    });
    const md = renderTable({
      rows: [mk('a--b'), mk('a b'), mk('<x>'), mk('ok')],
      links: new Map(),
      base: 'abc',
    });
    expect([...md.matchAll(/^<!-- describe-part:(\S+) -->$/gm)].map((m) => m[1])).toEqual([
      'head',
      'screen:ok',
      'rest',
    ]);
    expect(md).not.toContain('<x>');
  });

  it('gives a section describe takes, whose parts split as written', () => {
    const rows = lines(changes, columns);
    const links = new Map(
      pick(rows).map((p) => [
        keyOf(p),
        `https://github.com/user-attachments/assets/${'a'.repeat(12)}`,
      ]),
    );
    const md = renderTable({ rows, links, base: 'abc' });
    const sha = 'b'.repeat(40);
    const comment = {
      id: 1,
      node_id: 'N',
      user: { login: 'o' },
      body: `${uploadMarker('visual-review', sha)}\n\n${SECTION}\n${md}`,
    };
    const upload = parseUpload(comment, 'o');
    expect(upload).not.toBeNull();
    const slot = '<!-- describe:visual-review:trips -->\n<!-- /describe:visual-review:trips -->';
    const out = withSections(
      `1. Trips.\n\n${slot}\n\n2. More.`,
      new Map([['visual-review', /** @type {NonNullable<typeof upload>} */ (upload)]]),
    );
    // Trips sits under its change; the rest, under the heading, goes last.
    expect(out.indexOf('<b>trips</b>')).toBeLessThan(out.indexOf('2. More.'));
    expect(out.indexOf('2. More.')).toBeLessThan(out.indexOf('### Visual changes'));
    expect(out.match(/<b>trips<\/b>/g)).toHaveLength(1);
    expect(out).not.toContain('describe-part');
  });
});
