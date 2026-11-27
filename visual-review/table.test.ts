import { describe, expect, it } from 'vitest';
import { parseUpload, SECTION, uploadMarker, withSections } from '../describe/describe.ts';
import { isMinor, keyOf, lines, pick, renderTable, share, summary } from './table.ts';

const columns = [
  { label: 'Mobile', file: ['{state}-mobile-linux.png'] },
  { label: 'Desktop', file: ['{state}-desktop-linux.png'], width: 400 },
];
const DIFF = Buffer.from('d');
/** @type {import('./compare.ts').Change[]} */
const changes = [
  { file: 'm/trips-desktop-linux.png', kind: 'changed', ratio: 0.1, diff: DIFF, after: 'a1' },
  { file: 'm/trips-mobile-linux.png', kind: 'changed', ratio: 0.2, diff: DIFF, after: 'a2' },
  { file: 'm/new-mobile-linux.png', kind: 'added', after: 'a3' },
  { file: 'odd.png', kind: 'removed', after: '' },
];
/** @type {import('./zoom.ts').Look} */
const LOOK = {
  places: [{ x: 10, y: 10, w: 20, h: 12 }],
  zoom: { x: 2, y: 2, w: 36, h: 30 },
  scale: 6,
  large: false,
  width: 402,
  height: 800,
};
/** @type {import('./compare.ts').Change} */
const small = {
  file: 'm/menu-mobile-linux.png',
  kind: 'changed',
  ratio: 0.0004,
  diff: DIFF,
  after: 'a4',
  look: LOOK,
};
const REPO = 'jbhirsh/app';
const BASE = '0123456789abcdef0123456789abcdef01234567';
const keysOf = (/** @type {string} */ md) =>
  [...md.matchAll(/^<!-- describe-part:(\S+) -->$/gm)].map((m) => m[1]);
const urls = (/** @type {import('./table.ts').Line[]} */ rows) =>
  new Map(pick(rows).map((p) => [keyOf(p), `https://u/${keyOf(p)}`]));

describe('lines', () => {
  it('puts the largest change first: new, gone and resized, then by share', () => {
    expect(lines(changes, columns).map((l) => l.label)).toEqual([
      'new, mobile',
      'odd.png',
      'trips, mobile',
      'trips, desktop',
    ]);
    const mix = lines([small, ...changes], columns);
    expect(mix.at(-1)?.label).toBe('menu, mobile');
    expect(mix.map(isMinor)).toEqual([false, false, false, false, true]);
  });

  it("carries each paired row's state, size and width, and a shot no column takes has no state", () => {
    expect(lines(changes, columns).map((l) => [l.state, l.size, l.width])).toEqual([
      ['new', 'mobile', 300],
      [undefined, undefined, 300],
      ['trips', 'mobile', 300],
      ['trips', 'desktop', 400],
    ]);
  });
});

describe('share', () => {
  it('names a share briefly', () => {
    expect([0.5, 0.0655, 0.012, 0.0007, 0.00001].map(share)).toEqual([
      '50%',
      '6.6%',
      '1.2%',
      '0.07%',
      '<0.01%',
    ]);
  });
});

describe('summary', () => {
  it('counts the screens and links the base commit', () => {
    expect(summary({ count: 3, base: BASE, repo: REPO })).toBe(
      `Visual changes: 3 screens changed · compared with main at [\`0123456\`](https://github.com/${REPO}/commit/${BASE})`,
    );
    expect(summary({ count: 1, base: BASE, repo: REPO })).toContain('1 screen changed');
    expect(summary({ count: 0, base: BASE, repo: REPO })).toContain('Visual changes: none ·');
  });
});

describe('the summary', () => {
  const rend = (/** @type {import('./compare.ts').Change[]} */ list, omitted = 0) => {
    const rows = lines(list, columns);
    return renderTable({ rows, links: new Map(), base: BASE, repo: REPO, minor: 0.001, omitted });
  };

  it('says every change is minor and how small the most is', () => {
    const md = rend([small]);
    expect(md).toContain('1 screen changed, all minor edge differences');
    expect(md).toContain('The most is 0.04%, about 129 pixels of a 402×800 screen.');
    expect(md).toContain('Largest first. The outline shows where on the screen.');
  });

  it('has no such line when nothing is minor, and counts the screens left out', () => {
    expect(rend(changes)).not.toContain('The most is');
    const md = rend(changes, 2);
    expect(md).toContain('5 screens changed');
    expect(md).toContain('2 more screens changed, not shown.');
  });
});

describe('pick', () => {
  it('takes one picture a row first, then the rest of each, then the diffs', () => {
    const rows = lines([...changes, small], columns);
    expect(pick(rows).map(keyOf)).toEqual([
      'after:m/new-mobile-linux.png',
      'after:m/trips-mobile-linux.png',
      'after:m/trips-desktop-linux.png',
      'zoom:m/menu-mobile-linux.png',
      'before:odd.png',
      'before:m/trips-mobile-linux.png',
      'before:m/trips-desktop-linux.png',
      'where:m/menu-mobile-linux.png',
      'diff:m/trips-mobile-linux.png',
      'diff:m/trips-desktop-linux.png',
    ]);
    expect(pick(rows, 3)).toHaveLength(3);
  });

  it('shows a change too large to zoom as its diff, with where it is', () => {
    const large = { ...small, look: { ...LOOK, large: true } };
    expect(pick(lines([large], columns)).map(keyOf)).toEqual([
      'diff:m/menu-mobile-linux.png',
      'where:m/menu-mobile-linux.png',
    ]);
  });
});

describe('renderTable', () => {
  /** @param {import('./compare.ts').Change[]} list */
  const render = (list) => {
    const rows = lines(list, columns);
    return renderTable({ rows, links: urls(rows), base: BASE, repo: REPO, minor: 0.001 });
  };

  it('shows a big row as before, after and diff, the share under its name', () => {
    const md = render(changes);
    expect(md).toContain('Visual changes: 3 screens changed · compared with main at');
    expect(md).toContain(
      '| <b>trips, mobile</b><br><sub>20%</sub> | <img src="https://u/before:m/trips-mobile-linux.png"',
    );
    expect(md).toContain('| <b>new, mobile</b><br><sub>new</sub> | new | <img');
    expect(md).toMatch(
      /\| <b>odd\.png<\/b><br><sub>removed<\/sub> \| <img [^|]*> \| removed \| – \|/,
    );
    expect(md).toContain('| <img src="https://u/diff:m/trips-desktop-linux.png"');
    expect(md).toContain('| Screen | Before | After | Diff |');
    expect(md).toContain('<!-- describe-part:fold:closed -->');
  });

  it('shows a minor row as where it is and a zoom, and the fold starts closed beside big ones', () => {
    const md = render([small, ...changes]);
    expect(md).toContain('| Screen | Where | Zoom: before, after, diff |');
    expect(md).toContain(
      '| <b>menu, mobile</b><br><sub>0.04%</sub> | <img src="https://u/where:m/menu-mobile-linux.png"',
    );
    expect(md).toContain('alt="menu, mobile, zoom" width="660"');
    expect(md).toContain('<!-- describe-part:fold:closed -->\nMinor edge differences (under 0.1%)');
  });

  it('starts the fold open when every change is minor, and shows a large one as its diff', () => {
    const md = render([{ ...small, look: { ...LOOK, large: true } }]);
    expect(md).toContain('<!-- describe-part:fold:open -->');
    expect(md).toMatch(
      /\| <img [^|]*where[^|]*> \| <img src="https:\/\/u\/diff:m\/menu-mobile-linux.png"/,
    );
  });

  it('says when a picture was left out', () => {
    const rows = lines([changes[2]], columns);
    const md = renderTable({ rows, links: new Map(), base: BASE, repo: REPO, minor: 0.001 });
    expect(md).toContain('not shown (too many pictures)');
  });

  it('escapes what could break the table or mention someone', () => {
    const rows = [
      {
        label: 'a|b @x',
        width: 300,
        change: /** @type {import('./compare.ts').Change} */ ({
          file: 'x.png',
          kind: 'added',
          after: '',
        }),
      },
    ];
    const md = renderTable({
      rows,
      links: new Map([['after:x.png', 'https://u/"x']]),
      base: BASE,
      repo: REPO,
      minor: 0.001,
    });
    expect(md).toContain('a&#124;b &#64;x');
    expect(md).toContain('src="https://u/&quot;x"');
  });

  it("writes the summary, each table's header and a part of rows a screen", () => {
    const md = render([small, ...changes]);
    expect(keysOf(md)).toEqual([
      'head',
      'header:big',
      'big:new',
      'big',
      'big:trips',
      'header:minor',
      'minor:menu',
      'fold:closed',
    ]);
  });

  it('counts screens, not their sizes, and merges a state in two folders into one part', () => {
    const rows = lines(changes, columns);
    const twice = [
      ...rows,
      { ...rows[2], change: { ...rows[2].change, file: 'other/trips-mobile-linux.png' } },
    ];
    const md = renderTable({ rows: twice, links: new Map(), base: BASE, repo: REPO, minor: 0.001 });
    expect(md).toContain('3 screens changed');
    expect(md.match(/<!-- describe-part:big:trips -->/g)).toHaveLength(1);
  });

  it("keeps a state a marker can't hold out of the parts", () => {
    const mk = (/** @type {string} */ state) => ({
      label: `${state}, mobile`,
      width: 300,
      state,
      size: 'mobile',
      change: /** @type {import('./compare.ts').Change} */ ({
        file: 'x.png',
        kind: 'added',
        after: '',
      }),
    });
    const md = renderTable({
      rows: [mk('a--b'), mk('a b'), mk('<x>'), mk('ok')],
      links: new Map(),
      base: BASE,
      repo: REPO,
      minor: 0.001,
    });
    expect(keysOf(md)).toEqual(['head', 'header:big', 'big', 'big:ok', 'fold:closed']);
    expect(md).not.toContain('<x>');
  });
});

describe('renderTable, written by describe', () => {
  const rows = lines([small, ...changes], columns);
  const links = new Map(
    pick(rows).map((p) => [
      keyOf(p),
      `https://github.com/user-attachments/assets/${'a'.repeat(12)}`,
    ]),
  );
  const md = renderTable({ rows, links, base: BASE, repo: REPO, minor: 0.001 });
  const sha = 'b'.repeat(40);
  const upload = parseUpload(
    {
      id: 1,
      node_id: 'N',
      user: { login: 'o' },
      body: `${uploadMarker('visual-review', sha)}\n\n${SECTION}\n${md}`,
    },
    'o',
  );
  const write = (/** @type {string} */ body) =>
    withSections(
      body,
      new Map([['visual-review', /** @type {NonNullable<typeof upload>} */ (upload)]]),
    );
  const slot = (/** @type {string} */ state) =>
    `<!-- describe:visual-review:${state} -->\n<!-- /describe:visual-review:${state} -->`;

  it('takes a section describe accepts', () => {
    expect(upload).not.toBeNull();
  });

  it('puts a screen under its change with one header a table, the rest after the summary', () => {
    const out = write(`1. Trips.\n\n${slot('trips')}\n\n2. More.`);
    expect(out.indexOf('<b>trips, mobile</b>')).toBeLessThan(out.indexOf('2. More.'));
    expect(out.indexOf('2. More.')).toBeLessThan(out.indexOf('Visual changes: 4 screens changed'));
    expect(out.match(/<b>trips, mobile<\/b>/g)).toHaveLength(1);
    expect(out).not.toContain('describe-part');
    // The slot's table has its own header; the leftovers one more.
    expect(out.match(/\| Screen \| Before \| After \| Diff \|/g)).toHaveLength(2);
  });

  it("puts the rows no slot took in the bot's block, the minor ones in a fold with their count", () => {
    const out = write(`1. Trips.\n\n${slot('trips')}`);
    expect(out).toContain('_Not placed under a change yet._');
    expect(out).toContain(
      '<details><summary>Minor edge differences (under 0.1%): 1 screen</summary>',
    );
    expect(out.indexOf('Not placed')).toBeLessThan(out.indexOf('<details>'));
  });

  it('writes the same description again, and takes the fold away once its screens are placed', () => {
    const body = `${slot('trips')}\n\n${slot('menu')}`;
    const once = write(body);
    expect(write(once)).toBe(once);
    expect(once).not.toContain('Minor edge differences (under 0.1%): ');
    expect(once).not.toContain('<details><summary>Minor');
    expect(once).toContain('| Screen | Where | Zoom: before, after, diff |');
  });

  it('leaves the fold open when every change is minor, with no placed slots and no note', () => {
    const only = lines([small], columns);
    const text = renderTable({
      rows: only,
      links: new Map(),
      base: BASE,
      repo: REPO,
      minor: 0.001,
    });
    const u = parseUpload(
      {
        id: 2,
        node_id: 'M',
        user: { login: 'o' },
        body: `${uploadMarker('visual-review', sha)}\n\n${SECTION}\n${text}`,
      },
      'o',
    );
    const out = withSections(
      'Body',
      new Map([['visual-review', /** @type {NonNullable<typeof u>} */ (u)]]),
    );
    expect(out).toContain(
      '<details open><summary>Minor edge differences (under 0.1%): 1 screen</summary>',
    );
    expect(out).not.toContain('Not placed');
  });
});
