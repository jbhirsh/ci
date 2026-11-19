import { describe, expect, it } from 'vitest';
import { bodyProblems } from '../pr-template/body.mjs';
import {
  CELL_CHARS,
  REVISIONS_BUDGET,
  SUBJECTS,
  addRevision,
  budgeted,
  describeRange,
  goalSentence,
  inert,
  parseTable,
  previousHead,
  renderTable,
} from './revisions.mjs';

const REPO = 'o/r';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const head = (/** @type {string} */ sha) =>
  `[\`${sha.slice(0, 7)}\`](https://github.com/${REPO}/commit/${sha})`;
const row = (/** @type {string} */ rev, /** @type {string} */ sha, what = 'w', why = 'y') =>
  `| ${rev} | ${head(sha)} | ${what} | ${why} |`;
const table = (/** @type {string[]} */ ...lines) =>
  ['| Rev | Head | What changed | Why |', '| --- | --- | --- | --- |', ...lines].join('\n');

describe('parseTable', () => {
  it('reads valid rows, keeping their cells', () => {
    const t = parseTable(
      table(row('2 (current)', B, 'two', 'because'), row('1', A, 'Opened')),
      REPO,
    );
    expect(t.rows).toEqual([
      { rev: 2, current: true, sha: B, what: 'two', why: 'because' },
      { rev: 1, current: false, sha: A, what: 'Opened', why: 'y' },
    ]);
    expect(t.rest).toEqual([]);
    expect(t.omitted).toBe(0);
  });

  it('skips the heading, header, separator and blank lines, and reads the left-out note', () => {
    const t = parseTable(
      `## Revisions\n\n${table(row('1', A))}\n\n_3 earlier revisions left out to stay under GitHub's limit._`,
      REPO,
    );
    expect(t.rows).toHaveLength(1);
    expect(t.rest).toEqual([]);
    expect(t.omitted).toBe(3);
  });

  it.each([
    ['three cells', `| 1 | ${head(A)} | w |`],
    ['three cells', `| 1 | ${head(A)} | w |`],
    ['Rev 0', row('0', A)],
    ['Rev 1e3', row('1e3', A)],
    ['Rev -1', row('-1', A)],
    ['seven digits', row('1234567', A)],
    ['another repo', `| 1 | [\`aaaaaaa\`](https://github.com/x/y/commit/${A}) | w | y |`],
    [
      'seven hex not the sha',
      `| 1 | [\`bbbbbbb\`](https://github.com/${REPO}/commit/${A}) | w | y |`,
    ],
    ['an uppercase sha', row('1', 'A'.repeat(40))],
    ['a huge cell', row('1', A, 'x'.repeat(CELL_CHARS + 1))],
    ['prose', 'some words'],
  ])('keeps %s below the table, never reading it', (_name, line) => {
    const t = parseTable(line, REPO);
    expect(t.rows).toEqual([]);
    expect(t.rest).toHaveLength(1);
  });

  it('keeps an escaped pipe inside a cell', () => {
    const t = parseTable(row('1', A, 'a \\| b'), REPO);
    expect(t.rows[0].what).toBe('a \\| b');
  });

  it('reads CRLF text', () => {
    expect(parseTable(table(row('1', A)).replace(/\n/g, '\r\n'), REPO).rows).toHaveLength(1);
  });

  it('keeps a Why that has pipes in it as one cell, with the pipes escaped', () => {
    const t = parseTable(table(row('2 (current)', A, 'w', 'use a || b | c')), REPO);
    expect(t.rest).toEqual([]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].current).toBe(true);
    expect(t.rows[0].why).toBe('use a \\|  \\| b \\| c');
    expect(parseTable(renderTable(t, REPO, { heading: false }), REPO).rows).toEqual(t.rows);
  });

  it('makes an HTML comment inert in a cell and in a kept line', () => {
    const t = parseTable(`${row('1', A, '<!-- x', '-->')}\n<!-- end -->`, REPO);
    expect(t.rows[0].what).toBe('&lt;!-- x');
    expect(t.rows[0].why).toBe('--&gt;');
    expect(t.rest).toEqual(['&lt;!-- end --&gt;']);
    expect(inert('<!-- a -->')).toBe('&lt;!-- a --&gt;');
    expect(inert('a --!> b')).toBe('a --!&gt; b');
  });

  it("defuses `(current)` in a line it keeps, so the check can't read it", () => {
    const t = parseTable('| 9 (current) | not a head | x | y |', REPO);
    expect(t.rest[0]).not.toContain('(current)');
    expect(renderTable(t, REPO, { heading: false })).not.toMatch(/\(current\)/);
  });

  it('never reads a row inside an HTML comment as state', () => {
    const t = parseTable(`<!-- ${row('3 (current)', C)} -->`, REPO);
    expect(t.rows).toEqual([]);
    expect(t.rest[0]).toContain('(current​)');
  });
});

describe('previousHead', () => {
  it('is the current row, else the highest Rev, else null', () => {
    const rows = parseTable(table(row('1 (current)', A), row('2', B)), REPO).rows;
    expect(previousHead(rows)).toBe(A);
    expect(previousHead(parseTable(table(row('1', A), row('3', C), row('2', B)), REPO).rows)).toBe(
      C,
    );
    expect(previousHead([])).toBeNull();
  });
});

describe('renderTable', () => {
  it('writes the heading unless one stands before, rows newest first, then the note and kept lines', () => {
    const t = parseTable(`${table(row('1', A), row('2 (current)', B))}\nextra`, REPO);
    t.omitted = 2;
    const out = renderTable(t, REPO, { heading: true });
    expect(out.startsWith('## Revisions\n\n| Rev |')).toBe(true);
    expect(out.indexOf('| 2 (current)')).toBeLessThan(out.indexOf('| 1 |'));
    expect(out).toContain("_2 earlier revisions left out to stay under GitHub's limit._");
    expect(out.endsWith('extra')).toBe(true);
    expect(renderTable(t, REPO, { heading: false }).startsWith('| Rev |')).toBe(true);
    expect(renderTable({ ...t, omitted: 1 }, REPO, { heading: false })).toContain(
      '1 earlier revision left',
    );
  });

  it('is a fixpoint: reading what it wrote and writing it again changes nothing', () => {
    const t = parseTable(`${table(row('1', A), row('2 (current)', B))}\nextra`, REPO);
    const once = renderTable(t, REPO, { heading: true });
    expect(renderTable(parseTable(once, REPO), REPO, { heading: true })).toBe(once);
  });
});

describe('describeRange', () => {
  const commits = (/** @type {number} */ n) =>
    Array.from({ length: n }, (_, i) => ({ sha: `${i}`, subject: `Subject ${i}`, skipped: false }));

  it('links the range and lists the subjects, then "+ N more"', () => {
    const out = describeRange({ repo: REPO, prev: A, head: B, how: 'ahead', commits: commits(7) });
    expect(
      out.startsWith(`[\`aaaaaaa…bbbbbbb\`](https://github.com/o/r/compare/${A}...${B})<br>`),
    ).toBe(true);
    expect(out.split('<br>')).toHaveLength(1 + SUBJECTS + 1);
    expect(out.endsWith('+ 2 more')).toBe(true);
  });

  it('counts a bot or merge commit instead of listing it', () => {
    const out = describeRange({
      repo: REPO,
      prev: A,
      head: B,
      how: 'ahead',
      commits: [
        ...commits(1),
        { sha: 'm', subject: 'Merge branch', skipped: true },
        { sha: 'n', subject: 'Merge branch', skipped: true },
      ],
    });
    expect(out).toContain('+ 2 bot or merge commits');
    expect(out).not.toContain('Merge branch');
  });

  it("cuts a long subject to 72 characters and escapes a stranger's text", () => {
    const out = describeRange({
      repo: REPO,
      prev: A,
      head: B,
      how: 'ahead',
      commits: [{ sha: '1', subject: `a|b \`c\` @d #1 <br> ${'x'.repeat(100)}`, skipped: false }],
    });
    const subject = out.split('<br>')[1];
    expect(subject).toContain('a\\|b \\`c\\`');
    expect(subject).not.toMatch(/@(?!\u200b)/);
    expect(out.split('<br>')).toHaveLength(2);
    expect(subject.endsWith('…')).toBe(true);
  });

  it('says a rewrite, with the merge base and the commits no longer on the branch', () => {
    const out = describeRange({
      repo: REPO,
      prev: A,
      head: B,
      how: 'rewritten',
      commits: commits(1),
      dropped: 3,
      base: C,
    });
    expect(out).toContain(
      'rewritten (force-push or rebase) from `aaaaaaa`, merge base `ccccccc`, 3 earlier commits no longer on the branch',
    );
    expect(
      describeRange({ repo: REPO, prev: A, head: B, how: 'rewritten', commits: [], dropped: 1 }),
    ).toContain('1 earlier commit no');
  });

  it('says the old head is gone', () => {
    expect(describeRange({ repo: REPO, prev: A, head: B, how: 'gone', commits: [] })).toBe(
      'rewritten, the old head `aaaaaaa` is gone',
    );
  });

  it('lists no subject when asked for none', () => {
    const out = describeRange(
      { repo: REPO, prev: A, head: B, how: 'ahead', commits: commits(3) },
      0,
    );
    expect(out.endsWith('+ 3 more')).toBe(true);
  });
});

describe('goalSentence', () => {
  it('is the first sentence of the goal, escaped and cut', () => {
    expect(goalSentence(['## Goal', '', 'Make `x` | y. Then more.'])).toBe('Make \\`x\\` \\| y.');
    expect(goalSentence(['## Problem', 'No stop here'])).toBe('No stop here');
    expect(goalSentence(['## Goal', 'x'.repeat(300)])).toHaveLength(200);
  });

  it('is empty without a goal or with nothing under it', () => {
    expect(goalSentence(['## Plan', 'x'])).toBe('');
    expect(goalSentence(['## Goal', '', '## Changes'])).toBe('');
    expect(goalSentence(['## Goal'])).toBe('');
  });
});

describe('addRevision', () => {
  it('adds row 1 for the opening head with the goal as its Why, and the new row as current', () => {
    const t = addRevision(parseTable('', REPO), {
      head: B,
      what: 'new',
      opened: { sha: A, why: 'Goal.' },
    });
    expect(t.rows).toEqual([
      { rev: 1, current: false, sha: A, what: 'Opened', why: 'Goal.' },
      { rev: 2, current: true, sha: B, what: 'new', why: '' },
    ]);
  });

  it('continues after the highest Rev (a deleted row does not repeat a number) and moves current', () => {
    const t = addRevision(parseTable(table(row('4 (current)', A), row('2 (current)', B)), REPO), {
      head: C,
      what: 'w',
      opened: null,
    });
    expect(t.rows.filter((r) => r.current).map((r) => r.rev)).toEqual([5]);
    expect(t.rows.map((r) => r.rev).sort()).toEqual([2, 4, 5]);
  });

  it('makes a table the check reads: green for its head, red for another', () => {
    const t = addRevision(parseTable('', REPO), {
      head: B,
      what: 'w',
      opened: { sha: A, why: '' },
    });
    const body = `## Goal\n\nx.\n\n## Changes\n\n### 1. c\n\nwhy\n\n<!-- pr-changes:revisions -->\n${renderTable(t, REPO, { heading: true })}\n<!-- /pr-changes:revisions -->\n`;
    const revisions = (/** @type {string} */ sha) =>
      bodyProblems(body, sha).filter((p) => /Revisions/.test(p));
    expect(revisions(B)).toEqual([]);
    expect(revisions(A)).toHaveLength(1);
  });
});

describe('budgeted', () => {
  const base = () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      rev: i + 1,
      current: false,
      sha: `${i % 10}`.repeat(40),
      what: `what ${i} ${'w'.repeat(300)}`,
      why: 'y'.repeat(400),
    }));
    return { rows, rest: [], omitted: 0 };
  };

  it('writes everything when it fits', () => {
    const out = budgeted(
      (n) =>
        addRevision(parseTable('', REPO), { head: B, what: `n${n}`, opened: { sha: A, why: '' } }),
      REPO,
      { heading: true },
    );
    expect(out.length).toBeLessThan(REVISIONS_BUDGET);
    expect(out).toContain('| 2 (current)');
  });

  it('steps the new row down to fewer subjects first', () => {
    /** @type {number[]} */
    const asked = [];
    const out = budgeted(
      (n) => {
        asked.push(n);
        return addRevision(parseTable('', REPO), {
          head: B,
          what: n > 0 ? 'x'.repeat(REVISIONS_BUDGET) : 'short',
          opened: { sha: A, why: '' },
        });
      },
      REPO,
      { heading: true },
    );
    expect(asked).toEqual([SUBJECTS, 3, 0]);
    expect(out).toContain('short');
  });

  it('cuts older rows, then leaves out the oldest, keeping row 1 and the newest', () => {
    const out = budgeted(
      () => addRevision(base(), { head: B, what: 'newest what', opened: null }),
      REPO,
      { heading: true },
    );
    expect(out.length).toBeLessThanOrEqual(REVISIONS_BUDGET);
    expect(out).toContain('| 41 (current)');
    expect(out).toContain('newest what');
    expect(out).toContain('| 1 |');
    expect(out).toContain('earlier revisions left out');
    expect(out).toContain('older revision: its commits are cut');
  });

  it('stops shrinking when only row 1 and the newest are left', () => {
    const huge = (/** @type {number} */ rev) => ({
      rev,
      current: false,
      sha: A,
      what: 'x'.repeat(2000),
      why: 'y'.repeat(2000),
    });
    const out = budgeted(
      () => ({
        rows: [huge(1), huge(2), huge(3), huge(4), huge(5), huge(6), { ...huge(7), current: true }],
        rest: [],
        omitted: 0,
      }),
      REPO,
      { heading: false },
    );
    expect(out).toContain('| 1 |');
    expect(out).toContain('| 7 (current)');
  });
});
