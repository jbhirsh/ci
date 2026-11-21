import { describe, expect, it } from 'vitest';
import { bodyProblems } from '../pr-template/body.mjs';
import {
  CELL_CHARS,
  REVISIONS_BUDGET,
  SUBJECTS,
  OLDER_SUBJECTS,
  HISTORY_HEADS,
  addRevision,
  budgeted,
  capChain,
  describeRange,
  goalSentence,
  headChain,
  inert,
  parseTable,
  previousHead,
  renderTable,
  withPair,
} from './revisions.mjs';

const REPO = 'o/r';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const head = (/** @type {string} */ sha) =>
  `[\`${sha.slice(0, 7)}\`](https://github.com/${REPO}/commit/${sha})`;
// The table's old four-column shape, which is still read.
const row = (/** @type {string} */ rev, /** @type {string} */ sha, what = 'w', why = 'y') =>
  `| ${rev} | ${head(sha)} | ${what} | ${why} |`;
const table = (/** @type {string[]} */ ...lines) =>
  ['| Rev | Head | What changed | Why |', '| --- | --- | --- | --- |', ...lines].join('\n');
// The two-column shape the tool writes: the current row bold with a pointer, an older one plain.
const now = (/** @type {string} */ sha, what = 'w', why = 'y') =>
  `| **👉 ${head(sha)}** (current)${what === '' ? '' : `<br>**${what}**`} | ${why} |`;
const older = (/** @type {string} */ sha, what = 'w', why = 'y') =>
  `| ${head(sha)}${what === '' ? '' : `<br>${what}`} | ${why} |`;
const fresh = (/** @type {string[]} */ ...lines) =>
  ['| What changed | Why |', '| --- | --- |', ...lines].join('\n');

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

  it('takes the repo as text, not as a pattern: a dot, a backslash or a bracket in it match themselves', () => {
    const link = (/** @type {string} */ repo) =>
      `| **👉 [\`aaaaaaa\`](https://github.com/${repo}/commit/${A})** (current) | w |`;
    for (const repo of ['o/r.x', 'o/r[x]', 'o/r\\x', 'o/r+x', 'o/(r)']) {
      const text = link(repo);
      expect(parseTable(text, repo).rows).toHaveLength(1);
    }
    // A dot is a dot: it doesn't match any character.
    expect(parseTable(link('o/rXx'), 'o/r.x').rows).toHaveLength(0);
    expect(parseTable(link('o/r[x]'), 'o/rx').rows).toHaveLength(0);
  });

  it('reads CRLF text', () => {
    expect(parseTable(table(row('1', A)).replace(/\n/g, '\r\n'), REPO).rows).toHaveLength(1);
  });

  it('keeps a Why that has pipes in it as one cell, with the pipes escaped', () => {
    const t = parseTable(table(row('1 (current)', A, 'w', 'use a || b | c')), REPO);
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
    expect(out.startsWith('## Revisions\n\n| What changed | Why |')).toBe(true);
    expect(out.indexOf('| **👉 [`bbbbbbb`]')).toBeLessThan(out.indexOf('| [`aaaaaaa`]'));
    expect(out).toContain("_2 earlier revisions left out to stay under GitHub's limit._");
    expect(out.endsWith('extra')).toBe(true);
    expect(renderTable(t, REPO, { heading: false }).startsWith('| What changed | Why |')).toBe(
      true,
    );
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
    expect(out.endsWith(`+ ${7 - SUBJECTS} more`)).toBe(true);
  });

  it('lists at most three subjects, an older row of a rebuilt table two, each at most 56 characters', () => {
    expect([SUBJECTS, OLDER_SUBJECTS]).toEqual([3, 2]);
    const long = [{ sha: '1', subject: 'x'.repeat(100), skipped: false }];
    const out = describeRange({ repo: REPO, prev: A, head: B, how: 'ahead', commits: long });
    expect([...out.split('<br>')[1]]).toHaveLength(56 + 1);
  });

  it('keeps a row’s first cell under CELL_CHARS whatever a subject is, so it is read back as a row', () => {
    for (const ch of ['&', '\\', '`', '<', '|', '@']) {
      const subjects = Array.from({ length: SUBJECTS }, (_, i) => ({
        sha: `${i}`,
        subject: ch.repeat(100),
        skipped: false,
      }));
      const what = describeRange({
        repo: REPO,
        prev: A,
        head: B,
        how: 'rewritten',
        commits: subjects,
        dropped: 999,
      });
      const t = addRevision(parseTable('', REPO), { head: B, what, opened: { sha: A, why: '' } });
      const out = renderTable(t, REPO, { heading: false });
      const first = out
        .split('\n')[2]
        .split(/(?<!\\)\|/)[1]
        .trim();
      expect(first.length).toBeLessThanOrEqual(CELL_CHARS);
      expect(parseTable(out, REPO).rows).toHaveLength(2);
    }
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

  it('says a rewrite, with the commits dropped, and no merge base', () => {
    const out = describeRange({
      repo: REPO,
      prev: A,
      head: B,
      how: 'rewritten',
      commits: commits(1),
      dropped: 3,
    });
    expect(out.split('<br>')[0]).toBe('rewritten from `aaaaaaa` (3 commits dropped)');
    expect(
      describeRange({ repo: REPO, prev: A, head: B, how: 'rewritten', commits: [], dropped: 1 }),
    ).toBe('rewritten from `aaaaaaa` (1 commit dropped)');
    expect(
      describeRange({ repo: REPO, prev: A, head: B, how: 'rewritten', commits: [], dropped: 0 }),
    ).toBe('rewritten from `aaaaaaa`');
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
    expect(out).toContain('| **👉 [`bbbbbbb`]');
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
    expect(asked).toEqual([SUBJECTS, 1, 0]);
    expect(out).toContain('short');
  });

  it('cuts older rows, then leaves out the oldest, keeping row 1 and the newest', () => {
    const out = budgeted(
      () => addRevision(base(), { head: B, what: 'newest what', opened: null }),
      REPO,
      { heading: true },
    );
    expect(out.length).toBeLessThanOrEqual(REVISIONS_BUDGET);
    expect(out).toContain('| **👉 [`bbbbbbb`]');
    expect(out).toContain('newest what');
    expect(out).toContain('| [`0000000`]');
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
    expect(out).toContain('| [`aaaaaaa`]');
    expect(out).toContain('| **👉 [`aaaaaaa`]');
  });
});

describe('withPair', () => {
  const START = '<!-- pr-changes:revisions -->';
  const END = '<!-- /pr-changes:revisions -->';
  const INDEX = '<!-- pr-changes:index -->\n<!-- abc=def -->\n<!-- /pr-changes:index -->';

  it('puts the pair above the index block, where the template has it', () => {
    const body = `## Goal\n\nx\n\n## Checklist\n\n- [x] y\n\n${INDEX}\n`;
    expect(withPair(body)).toBe(
      `## Goal\n\nx\n\n## Checklist\n\n- [x] y\n\n${START}\n${END}\n\n${INDEX}\n`,
    );
  });

  it('puts it ahead of a footer rule when there is no index block', () => {
    const body = '## Goal\n\nx\n\n---\n_Generated by a tool_\n';
    expect(withPair(body)).toBe(`## Goal\n\nx\n\n${START}\n${END}\n\n---\n_Generated by a tool_\n`);
  });

  it('puts it at the end when there is neither', () => {
    expect(withPair('## Goal\n\nx\n')).toBe(`## Goal\n\nx\n\n${START}\n${END}\n`);
    expect(withPair('')).toBe(`${START}\n${END}\n`);
  });

  it('leaves a description that has a revisions marker line as it is', () => {
    for (const body of [`a\n${START}\n${END}\n`, `a\n${START}\n`, `a\n${END}\n`]) {
      expect(withPair(body)).toBe(body);
    }
  });

  it('counts markers as the description check does: not in a fence, not in a sentence', () => {
    const fenced = `a\n\`\`\`\n${START}\n${END}\n\`\`\`\n`;
    expect(withPair(fenced)).toBe(`${fenced.trimEnd()}\n\n${START}\n${END}\n`);
    const quoted = `Put \`${START}\` and ${END} in it.\n`;
    expect(withPair(quoted)).toBe(`${quoted.trimEnd()}\n\n${START}\n${END}\n`);
    const both = `${fenced}\n${START}\n${END}\n`;
    expect(withPair(both)).toBe(both);
  });

  it('keeps a CRLF description’s line endings, and finds its footer', () => {
    const body = '## Goal\r\n\r\nx\r\n\r\n---\r\n_Generated by a tool_\r\n';
    const out = withPair(body);
    expect(out).toBe(
      `## Goal\r\n\r\nx\r\n\r\n${START}\r\n${END}\r\n\r\n---\r\n_Generated by a tool_\r\n`,
    );
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    const index = `## Goal\r\n\r\n<!-- pr-changes:index -->\r\n<!-- /pr-changes:index -->\r\n`;
    expect(withPair(index)).toBe(
      `## Goal\r\n\r\n${START}\r\n${END}\r\n\r\n<!-- pr-changes:index -->\r\n<!-- /pr-changes:index -->\r\n`,
    );
  });

  it('does not take a fenced index block for the template’s', () => {
    const body = `a\n\n\`\`\`\n${INDEX}\n\`\`\`\n`;
    expect(withPair(body)).toBe(`${body.trimEnd()}\n\n${START}\n${END}\n`);
  });
});

describe('headChain and capChain', () => {
  const sha = (/** @type {number} */ n) => n.toString(16).padStart(2, '0').repeat(20);
  const forced = (/** @type {string} */ id) => ({ event: 'head_ref_force_pushed', commit_id: id });

  it('is the heads force-pushes made, the head before this push, and the head', () => {
    const [a, b, c, d] = [sha(1), sha(2), sha(3), sha(4)];
    expect(headChain([forced(a), forced(b), forced(c)], { head: c, before: b })).toEqual([a, b, c]);
    expect(headChain([forced(a), forced(b)], { head: d, before: b })).toEqual([a, b, d]);
    expect(headChain([forced(a), forced(b)], { head: d, before: c })).toEqual([a, b, c, d]);
    expect(headChain([forced(a), forced(b)], { head: d, before: null })).toEqual([a, b, d]);
  });

  it('is empty without a force-push, and for fewer than two heads', () => {
    expect(headChain([], { head: sha(1), before: sha(2) })).toEqual([]);
    expect(
      headChain([{ event: 'committed', sha: sha(3) }, { event: 'labeled' }], {
        head: sha(1),
        before: sha(2),
      }),
    ).toEqual([]);
    expect(headChain([forced(sha(1))], { head: sha(1), before: null })).toEqual([]);
  });

  it('reads only what is a head: 40 hex, an event of its kind, once in a row', () => {
    const [a, b] = [sha(1), sha(2)];
    /** @type {Record<string, unknown>[]} */
    const events = [
      forced(a),
      forced(a),
      forced(a.toUpperCase()),
      forced('nope'),
      { event: 'head_ref_force_pushed' },
      { event: 'head_ref_force_pushed', commit_id: 7 },
      { event: 'committed', commit_id: sha(9) },
      forced(b),
    ];
    expect(headChain(events, { head: b, before: a })).toEqual([a, b]);
    expect(headChain([forced(a)], { head: 'short', before: a })).toEqual([]);
  });

  it('keeps all heads up to the cap, else the first and the latest, with their true numbers', () => {
    const chain = Array.from({ length: 25 }, (_, i) => sha(i + 1));
    expect(capChain(chain.slice(0, 3))).toEqual({
      kept: [
        { sha: sha(1), rev: 1 },
        { sha: sha(2), rev: 2 },
        { sha: sha(3), rev: 3 },
      ],
      omitted: 0,
    });
    const capped = capChain(chain, 5);
    expect(capped.kept.map((k) => k.rev)).toEqual([1, 22, 23, 24, 25]);
    expect(capped.omitted).toBe(20);
    expect(capChain(chain).kept).toHaveLength(HISTORY_HEADS);
  });
});

describe('the note of heads the first write did not list', () => {
  const note =
    '_12 earlier heads are not listed: the table keeps the first head and the latest ones._';

  it('is read back as a count, not as a line that is no row, and written again once', () => {
    const t = parseTable(`${table(row('1', A), row('13', B))}\n\n${note}`, REPO);
    expect(t.capped).toBe(12);
    expect(t.rest).toEqual([]);
    const out = renderTable(t, REPO, { heading: false });
    expect(out.match(/earlier heads are not listed/g)).toHaveLength(1);
    expect(parseTable(out, REPO).capped).toBe(12);
    expect(renderTable({ ...t, capped: 1 }, REPO, { heading: false })).toContain(
      '_1 earlier head is not listed',
    );
  });

  it('is told apart from the limit’s note, and both survive a new row', () => {
    const both = `${table(row('1', A), row('9', B))}\n\n_2 earlier revisions left out to stay under GitHub's limit._\n\n${note}`;
    const next = addRevision(parseTable(both, REPO), { head: C, what: 'w', opened: null });
    const out = renderTable(next, REPO, { heading: false });
    expect(out).toContain('left out to stay under');
    expect(out).toContain('12 earlier heads are not listed');
    expect(out).toContain('| **👉 [`ccccccc`]');
  });
});

describe('the two-column table', () => {
  it('writes the head link, then what changed, in one cell, and the Why in the other', () => {
    const t = addRevision(parseTable('', REPO), {
      head: B,
      what: `[\`aaaaaaa…bbbbbbb\`](https://github.com/${REPO}/compare/${A}...${B})<br>Subject<br>+ 2 more`,
      opened: { sha: A, why: 'Goal.' },
    });
    expect(renderTable(t, REPO, { heading: false }).split('\n')).toEqual([
      '| What changed | Why |',
      '| --- | --- |',
      `| **👉 ${head(B)}** (current)<br>**[\`aaaaaaa…bbbbbbb\`](https://github.com/${REPO}/compare/${A}...${B})**<br>**Subject**<br>**+ 2 more** |  |`,
      `| ${head(A)}<br>Opened | Goal. |`,
    ]);
  });

  it('reads a highlighted row, a plain one and a row an author took the pointer or the bold off, the same', () => {
    const lead = head(A);
    for (const cell of [
      `**👉 ${lead}** (current)<br>**what**`,
      `**${lead}** (current)<br>what`,
      `${lead} (current)<br>what`,
    ]) {
      const t = parseTable(fresh(`| ${cell} | why |`), REPO);
      expect(t.rest).toEqual([]);
      expect(t.rows).toEqual([{ rev: 1, current: true, sha: A, what: 'what', why: 'why' }]);
    }
    expect(parseTable(fresh(older(A, 'what')), REPO).rows[0]).toEqual({
      rev: 1,
      current: false,
      sha: A,
      what: 'what',
      why: 'y',
    });
  });

  it('numbers a row by its place from the oldest, keeping row 1 when a note says rows were left out', () => {
    const t = parseTable(fresh(now(C), older(B), older(A)), REPO);
    expect(t.rows.map((r) => r.rev)).toEqual([3, 2, 1]);
    const gap = parseTable(
      `${fresh(now(C), older(A))}\n\n_5 earlier heads are not listed: the table keeps the first head and the latest ones._`,
      REPO,
    );
    expect(gap.rows.map((r) => r.rev)).toEqual([7, 1]);
  });

  it('keeps what an author wrote in the Why, bold or not, as written', () => {
    // A pipe in a Why is the author's text, kept as one cell with the pipe escaped; a backslash stays.
    for (const [why, kept] of [
      ['**stay**', '**stay**'],
      ['plain', 'plain'],
      ['**a** and _b_ | c', '**a** and _b_ \\| c'],
      ['a \\ b', 'a \\ b'],
      ['a \\| b', 'a \\| b'],
    ]) {
      const t = parseTable(fresh(now(A, 'w', why)), REPO);
      const again = parseTable(renderTable(t, REPO, { heading: false }), REPO);
      expect(t.rows[0].why).toBe(kept);
      expect(again.rows[0].why).toBe(kept);
    }
  });

  it('moves the highlight to the new row on every push, and reads the old four-column shape', () => {
    const start = parseTable(
      table(row('2 (current)', B, 'two', 'because'), row('1', A, 'Opened')),
      REPO,
    );
    const once = renderTable(addRevision(start, { head: C, what: 'three', opened: null }), REPO, {
      heading: false,
    });
    expect(once.split('\n').slice(2)).toEqual([
      `| **👉 ${head(C)}** (current)<br>**three** |  |`,
      `| ${head(B)}<br>two | because |`,
      `| ${head(A)}<br>Opened | y |`,
    ]);
    const twice = renderTable(
      addRevision(parseTable(once, REPO), { head: A, what: 'four', opened: null }),
      REPO,
      { heading: false },
    );
    expect(twice.split('\n').slice(2)).toEqual([
      `| **👉 ${head(A)}** (current)<br>**four** |  |`,
      `| ${head(C)}<br>three |  |`,
      `| ${head(B)}<br>two | because |`,
      `| ${head(A)}<br>Opened | y |`,
    ]);
    expect(twice.match(/\(current\)/g)).toHaveLength(1);
  });

  it('is a fixpoint, the old shape normalised to the new one on the first write', () => {
    const old = parseTable(table(row('1', A), row('2 (current)', B)), REPO);
    const once = renderTable(old, REPO, { heading: true });
    expect(once).not.toContain('| Rev |');
    expect(renderTable(parseTable(once, REPO), REPO, { heading: true })).toBe(once);
  });

  it('is read by the check as the old shape is: the current row must name the head', () => {
    const t = parseTable(table(row('1', A), row('2 (current)', B)), REPO);
    const body = (/** @type {string} */ revisions) =>
      `## Goal\n\nx.\n\n## Changes\n\n### 1. c\n\nwhy\n\n<!-- pr-changes:revisions -->\n${revisions}\n<!-- /pr-changes:revisions -->\n`;
    const problems = (/** @type {string} */ revisions, /** @type {string} */ sha) =>
      bodyProblems(body(revisions), sha).filter((p) => /Revisions/.test(p));
    const oldShape = table(row('1', A), row('2 (current)', B));
    const newShape = renderTable(t, REPO, { heading: false });
    for (const text of [oldShape, newShape]) {
      expect(problems(text, B)).toEqual([]);
      expect(problems(text, A)).toHaveLength(1);
    }
    // A subject that says (current) in an older row is not a current row.
    const tricky = fresh(older(A, 'fix (current) thing'));
    expect(problems(tricky, A)).toEqual([]);
  });
});

describe('what an author typed in a plain row, and how the highlight is written', () => {
  it('keeps the What of a plain older row as typed, bold marks and all', () => {
    const typed = '**Important** fix **now**<br>**whole line**';
    const t = parseTable(fresh(now(B), `| ${head(A)}<br>${typed} | y |`), REPO);
    expect(t.rows[1].what).toBe(typed);
    const out = renderTable(t, REPO, { heading: false });
    expect(out).toContain(`| ${head(A)}<br>${typed} | y |`);
    expect(renderTable(parseTable(out, REPO), REPO, { heading: false })).toBe(out);
  });

  it('takes the bold off a bold row’s What on reading and puts it back on writing, trimming each line', () => {
    const t = parseTable(fresh(`| **👉 ${head(A)}** (current)<br>**one**<br>**two** | y |`), REPO);
    expect(t.rows[0].what).toBe('one<br>two');
    const padded = { ...t, rows: [{ ...t.rows[0], what: 'Fix the thing <br> and more ' }] };
    expect(renderTable(padded, REPO, { heading: false })).toContain(
      '<br>**Fix the thing**<br>**and more** |',
    );
  });

  it('is read by the check and the parser alike: each form of a current row is current to both', () => {
    const forms = [
      `**👉 ${head(A)}** (current)<br>w`,
      `**${head(A)}** (current)<br>w`,
      `${head(A)} (current)<br>w`,
      `**👉 ${head(A)}**(current)`,
      `**👉 ${head(A)} (current)**`,
      `👉 ${head(A)} (current)`,
      `**👉 [\`aaaaaaa\`](https://elsewhere.example/x)** (current)<br>w`,
    ];
    for (const cell of forms) {
      const text = fresh(`| ${cell} | y |`);
      const parsed = parseTable(text, REPO).rows.some((r) => r.current);
      const body = `## Goal\n\nx.\n\n## Changes\n\n### 1. c\n\nwhy\n\n<!-- pr-changes:revisions -->\n${text}\n<!-- /pr-changes:revisions -->\n`;
      // The check says "no current row" on a push when it finds none.
      const checked = !bodyProblems(body, A, { pushed: true }).some((p) =>
        /no current row/.test(p),
      );
      expect(checked, cell).toBe(parsed);
    }
  });
});
