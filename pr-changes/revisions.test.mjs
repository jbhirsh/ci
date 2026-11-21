import { describe, expect, it } from 'vitest';
import { bodyProblems } from '../pr-template/body.mjs';
import {
  HISTORY_HEADS,
  REVISIONS_BUDGET,
  addRevision,
  budgeted,
  capChain,
  goalSentence,
  headChain,
  inert,
  parseTable,
  previousHead,
  rangeNote,
  renderTable,
  withPair,
} from './revisions.mjs';

const REPO = 'o/r';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
/** A zero-width space, which defuses a `(current)`. */
const Z = String.fromCharCode(0x200b);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const head = (/** @type {string} */ sha) =>
  `[\`${sha.slice(0, 7)}\`](https://github.com/${REPO}/commit/${sha})`;
const ahref = (/** @type {string} */ sha) =>
  `<a href="https://github.com/${REPO}/commit/${sha}"><code>${sha.slice(0, 7)}</code></a>`;
const compare = (/** @type {string} */ prev, /** @type {string} */ sha) =>
  `<a href="https://github.com/${REPO}/compare/${prev}...${sha}">compare <code>${prev.slice(0, 7)}…${sha.slice(0, 7)}</code></a>`;

// The old four-column table, which is still read.
const row = (/** @type {string} */ rev, /** @type {string} */ sha, what = 'w', why = 'y') =>
  `| ${rev} | ${head(sha)} | ${what} | ${why} |`;
const table = (/** @type {string[]} */ ...lines) =>
  ['| Rev | Head | What changed | Why |', '| --- | --- | --- | --- |', ...lines].join('\n');
// The two-column table of ci#126: the current row bold with a pointer, an older one plain.
const now = (/** @type {string} */ sha, what = 'w', why = 'y') =>
  `| **👉 ${head(sha)}** (current)${what === '' ? '' : `<br>**${what}**`} | ${why} |`;
const older = (/** @type {string} */ sha, what = 'w', why = 'y') =>
  `| ${head(sha)}${what === '' ? '' : `<br>${what}`} | ${why} |`;
const fresh = (/** @type {string[]} */ ...lines) =>
  ['| What changed | Why |', '| --- | --- |', ...lines].join('\n');
// The HTML table of ci#132's first push: a `<tbody>` for each revision, its first row the head and
// the Why, then a row across the table for each line of what changed.
const htmlFirst = (
  /** @type {string} */ sha,
  /** @type {string[]} */ what = [],
  why = '',
  current = false,
) => [
  `<tr><td>${current ? `<b>👉 ${ahref(sha)}</b> (current)` : ahref(sha)}</td><td>${why}</td></tr>`,
  ...what.map((w) => `<tr><td colspan="2">${w}</td></tr>`),
];
const htmlTable = (/** @type {string[]} */ ...rows) =>
  [
    '<table width="100%">',
    '<thead><tr><th width="30%">Revision</th><th width="70%">Why</th></tr></thead>',
    '<tbody>',
    ...rows,
    '</tbody>',
    '</table>',
  ].join('\n');

/** A revision's summary, as the tool writes it. */
const summary = (/** @type {string} */ sha, { current = false, prev = '', note = '' } = {}) =>
  `<summary>${current ? `<b>👉 ${ahref(sha)}</b> (current)` : ahref(sha)}${prev === '' ? '' : ` · ${compare(prev, sha)}`}${note === '' ? '' : ` · ${note}`}</summary>`;
/** A revision's block, as the tool writes it. */
const block = (
  /** @type {string} */ sha,
  /** @type {{ current?: boolean, prev?: string, note?: string }} */ opts = {},
  /** @type {string[]} */ rows = ['|  |  |'],
) =>
  [
    `<details${opts.current ? ' open' : ''}>`,
    summary(sha, opts),
    '',
    '| What changed | Why |',
    '| --- | --- |',
    ...rows,
    '',
    '</details>',
  ].join('\n');
/** @param {Partial<import('./revisions.mjs').Row> & { sha: string, rev: number }} r */
const revision = (r) => ({
  current: false,
  prev: null,
  note: '',
  rows: [],
  typed: [],
  ...r,
});
/** The description the check reads, with a block between the Revisions markers. */
const described = (/** @type {string} */ inner) =>
  `## Goal\n\nx.\n\n## Changes\n\n### 1. c\n\nwhy\n\n<!-- pr-changes:revisions -->\n${inner}\n<!-- /pr-changes:revisions -->\n`;
const problems = (/** @type {string} */ inner, /** @type {string} */ sha) =>
  bodyProblems(described(inner), sha).filter((p) => /Revisions/.test(p));

describe('parseTable, the details blocks', () => {
  it('reads a revision: its head, `(current)`, its compare link, its note and its rows as written', () => {
    const t = parseTable(
      [
        block(
          B,
          {
            current: true,
            prev: A,
            note: 'rewritten from <code>aaaaaaa</code> (2 commits dropped)',
          },
          ['| what one | because `x` |', '| two \\| three | y |'],
        ),
        block(A, { note: 'Opened' }, ['|  |  |']),
      ].join('\n\n'),
      REPO,
    );
    expect(t.rest).toEqual([]);
    expect(t.rows).toEqual([
      revision({
        rev: 2,
        current: true,
        sha: B,
        prev: A,
        note: 'rewritten from <code>aaaaaaa</code> (2 commits dropped)',
        rows: ['| what one | because `x` |', '| two \\| three | y |'],
      }),
      revision({ rev: 1, sha: A, note: 'Opened' }),
    ]);
  });

  it('reads the pointer, the bold and the plain form of the head alike, a head with no compare link or note', () => {
    for (const lead of [`<b>👉 ${ahref(A)}</b>`, `<b>${ahref(A)}</b>`, ahref(A)]) {
      const t = parseTable(
        `<details open>\n<summary>${lead} (current)</summary>\n\n| What changed | Why |\n| --- | --- |\n| a | b |\n\n</details>`,
        REPO,
      );
      expect(t.rows).toEqual([revision({ rev: 1, current: true, sha: A, rows: ['| a | b |'] })]);
    }
    const plain = parseTable(`<details>\n<summary>${ahref(A)}</summary>\n</details>`, REPO);
    expect(plain.rows).toEqual([revision({ rev: 1, sha: A })]);
  });

  it('takes a compare link that ends at another head as no compare link', () => {
    const t = parseTable(block(B, { prev: A }).replace(`${A}...${B}`, `${A}...${C}`), REPO);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].prev).toBeNull();
  });

  it('keeps an author’s line typed in the block, and skips the table’s own header and rule', () => {
    const t = parseTable(
      `<details>\n<summary>${ahref(A)}</summary>\n\n| What changed | Why |\n| :--- | ---: |\n| a | b |\n\nA note in the block.\n- and a list\n\n</details>`,
      REPO,
    );
    expect(t.rows[0].rows).toEqual(['| a | b |']);
    expect(t.rows[0].typed).toEqual(['A note in the block.', '- and a list']);
    expect(t.rest).toEqual([]);
  });

  it('reads a summary on the details line, a closing tag on the last line, a block with no closing tag, and blocks with no blank line between', () => {
    const t = parseTable(
      [
        `<details open><summary>${ahref(B)} (current)</summary>`,
        '| What changed | Why |',
        '| --- | --- |',
        '| x | y |',
        '</details>',
        `<details><summary>${ahref(A)}</summary>`,
        '| z | w |',
      ].join('\n'),
      REPO,
    );
    expect(t.rest).toEqual([]);
    expect(t.rows.map((r) => [r.sha, r.current, r.rows])).toEqual([
      [B, true, ['| x | y |']],
      [A, false, ['| z | w |']],
    ]);
  });

  it('ends a block that has no closing tag where the next block starts, so it can’t swallow it', () => {
    const t = parseTable(
      [
        `<details open>\n${summary(B, { current: true })}\n\n| a | b |`,
        `<details>\n${summary(A)}\n\n| c | d |`,
      ].join('\n'),
      REPO,
    );
    expect(t.rest).toEqual([]);
    expect(t.rows.map((r) => [r.sha, r.rows])).toEqual([
      [B, ['| a | b |']],
      [A, ['| c | d |']],
    ]);
  });

  it('reads blank lines anywhere, CRLF, and a row of any size', () => {
    const long = 'x'.repeat(50_000);
    const text = `\n\n<details open>\n\n\n<summary>${ahref(A)} (current)</summary>\n\n\n| What changed | Why |\n\n| --- | --- |\n\n| ${long} | ${long} |\n\n</details>\n\n`;
    const t = parseTable(text.replace(/\n/g, '\r\n'), REPO);
    expect(t.rest).toEqual([]);
    expect(t.rows).toEqual([
      revision({ rev: 1, current: true, sha: A, rows: [`| ${long} | ${long} |`] }),
    ]);
  });

  it.each([
    ['another repo', `<a href="https://github.com/x/y/commit/${A}"><code>aaaaaaa</code></a>`],
    [
      'text that is not the sha',
      `<a href="https://github.com/${REPO}/commit/${A}"><code>bbbbbbb</code></a>`,
    ],
    ['a short sha', `<a href="https://github.com/${REPO}/commit/aaaaaaa"><code>aaaaaaa</code></a>`],
    ['text before the link', `see ${ahref(A)}`],
    ['an uppercase sha', ahref('A'.repeat(40))],
  ])(
    'keeps a block whose summary has %s below, never reading it, its (current) defused',
    (_n, lead) => {
      const text = `<details open>\n<summary>${lead} (current)</summary>\n\n| a | b |\n\n</details>`;
      const t = parseTable(text, REPO);
      expect(t.rows).toEqual([]);
      expect(t.rest.join('\n')).toContain('summary');
      expect(t.rest.join('\n')).not.toContain('(current)');
      // Read again as kept, it is still no revision.
      expect(parseTable(t.rest.join('\n'), REPO).rows).toEqual([]);
    },
  );

  it('never reads a row of the table as a revision, or its `(current)` as the current one', () => {
    const t = parseTable(
      [
        block(B, { current: true }, [
          `| ${head(A)} (current) | y |`,
          `| 2 (current) | ${head(A)} | w | y |`,
          '| fix (current) thing | (current) |',
        ]),
        block(A, {}, ['|  |  |']),
      ].join('\n\n'),
      REPO,
    );
    expect(t.rows.map((r) => [r.sha, r.current])).toEqual([
      [B, true],
      [A, false],
    ]);
    expect(t.rest).toEqual([]);
    // The checker reads the summary alone: the current revision is the one written.
    expect(
      problems(
        [
          block(B, { current: true }, [
            `| 2 (current) | ${head(A)} | w | y |`,
            `| ${head(A)} (current) | y |`,
          ]),
          block(A),
        ].join('\n\n'),
        B,
      ),
    ).toEqual([]);
  });

  it('makes a comment, a bogus comment and a tag of the block inert in a row, a line and the note, so they can’t end the block', () => {
    const t = parseTable(
      `<details open>\n<summary>${ahref(A)} (current) · a <!-- b</summary>\n\n| <!x </details> | <?php <summary> |\n\n</details --> and <!-- end\n\n</details>`,
      REPO,
    );
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].note).toBe('a &lt;!-- b');
    expect(t.rows[0].rows).toEqual(['| &lt;!x &lt;/details> | &lt;?php &lt;summary> |']);
    expect(t.rows[0].typed.join('\n')).not.toMatch(/<\/?details|<!/);
    expect(inert('<!-- a -->')).toBe('&lt;!-- a --&gt;');
    expect(inert('a --!> b')).toBe('a --!&gt; b');
    expect(inert('<!x <?php <!> </ x> </> <![CDATA[ a</b> <b>')).toBe(
      '&lt;!x &lt;?php &lt;!> &lt;/ x> &lt;/> &lt;![CDATA[ a</b> <b>',
    );
  });

  it('turns U+2028 and U+2029 into spaces, which the check would read as a line break', () => {
    const t = parseTable(
      `<details>\n<summary>${ahref(A)}</summary>\n\n| a${LS}| 2 (current) | b${PS}c |\n\n</details>`,
      REPO,
    );
    expect(t.rows[0].rows).toEqual(['| a | 2 (current) \\| b c |']);
  });

  it('numbers revisions from the oldest, counting what a note says was left out', () => {
    const blocks = [block(C, { current: true }), block(B), block(A)].join('\n\n');
    expect(parseTable(blocks, REPO).rows.map((r) => r.rev)).toEqual([3, 2, 1]);
    const noted = `${blocks}\n\n_4 earlier heads are not listed: the table keeps the first head and the latest ones._`;
    expect(parseTable(noted, REPO).rows.map((r) => r.rev)).toEqual([7, 6, 1]);
    expect(parseTable(noted, REPO).capped).toBe(4);
    const lost = `${blocks}\n\n_3 earlier revisions left out to stay under GitHub's limit._`;
    expect(parseTable(lost, REPO).omitted).toBe(3);
  });

  it('keeps a line outside the blocks below them, with its (current) defused', () => {
    const t = parseTable(`${block(A)}\n\nnotes (current)\n- x`, REPO);
    expect(t.rest).toEqual([`notes (current${Z})`, '- x']);
  });
});

describe('parseTable, the shapes of earlier PRs', () => {
  it('reads the old four-column table: each revision’s row becomes one author row, its Why kept', () => {
    const t = parseTable(
      table(row('2 (current)', B, 'two<br>lines', 'because'), row('1', A, 'Opened')),
      REPO,
    );
    expect(t.rest).toEqual([]);
    expect(t.rows).toEqual([
      revision({ rev: 2, current: true, sha: B, rows: ['| two<br>lines | because |'] }),
      revision({ rev: 1, sha: A, note: 'Opened', rows: ['| — | y |'] }),
    ]);
  });

  it('reads the two-column table: a head link, its notes to the summary, the old head kept, the rest as the first row', () => {
    const t = parseTable(
      fresh(
        `| **👉 ${head(B)}** (current)<br>**[\`aaaaaaa…bbbbbbb\`](https://github.com/o/r/compare/${A}...${B})**<br>**rewritten from \`aaaaaaa\` (2 commits dropped)**<br>**Fix the \`thing\`**<br>**+ 3 more** | because |`,
        `| ${head(A)}<br>Opened | the goal |`,
        `| ${head(C)}<br>(commits replaced by a force-push) | |`,
      ),
      REPO,
    );
    expect(t.rows).toEqual([
      revision({
        rev: 3,
        current: true,
        sha: B,
        prev: A,
        note: 'rewritten from <code>aaaaaaa</code> (2 commits dropped)',
        rows: ['| Fix the `thing`<br>+ 3 more | because |'],
      }),
      revision({ rev: 2, sha: A, note: 'Opened', rows: ['| — | the goal |'] }),
      revision({ rev: 1, sha: C, note: '(commits replaced by a force-push)' }),
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
      expect(t.rows).toEqual([
        revision({ rev: 1, current: true, sha: A, rows: ['| what | why |'] }),
      ]);
    }
  });

  it('escapes a pipe a What or a Why holds, and keeps the Markdown it was written in', () => {
    const t = parseTable(fresh(`| ${head(A)}<br>a \\| b <br>c | use a || b | \`c\` |`), REPO);
    expect(t.rows[0].rows).toEqual(['| a \\| b<br>c | use a \\|  \\| b \\| `c` |']);
  });

  it('reads the HTML table of ci#132’s first push: the Why, and a line for each row across it', () => {
    const t = parseTable(
      htmlTable(
        ...htmlFirst(
          B,
          ['rewritten from <code>aaaaaaa</code> (2 commits dropped)', 'one', 'two'],
          'because',
          true,
        ),
        ...htmlFirst(A, ['Opened'], 'the goal'),
      ),
      REPO,
    );
    expect(t.rest).toEqual([]);
    expect(t.rows).toEqual([
      revision({
        rev: 2,
        current: true,
        sha: B,
        note: 'rewritten from <code>aaaaaaa</code> (2 commits dropped)',
        rows: ['| one<br>two | because |'],
      }),
      revision({ rev: 1, sha: A, note: 'Opened', rows: ['| — | the goal |'] }),
    ]);
  });

  it('keeps the paragraphs of a Why in that HTML table as a break, a row broken over lines, and CRLF', () => {
    const text = htmlTable(
      '<tr>\n<td>' + ahref(B) + '</td>\n<td>first paragraph\n\nsecond paragraph</td>\n</tr>',
      '<tr><td colspan="2">one</td></tr>',
      ...htmlFirst(A, [], 'the goal'),
    );
    for (const input of [text, text.replace(/\n/g, '\r\n')]) {
      const t = parseTable(input, REPO);
      expect(t.rest).toEqual([]);
      expect(t.rows.map((r) => r.rows)).toEqual([
        ['| one | first paragraph<br><br>second paragraph |'],
        ['| — | the goal |'],
      ]);
    }
  });

  it('a revision with no lines and no Why has no author row (the tool writes the empty one)', () => {
    expect(parseTable(table(row('1', A, '', '')), REPO).rows[0].rows).toEqual([]);
    expect(parseTable(htmlTable(...htmlFirst(A)), REPO).rows[0].rows).toEqual([]);
  });

  it.each([
    ['three cells', `| 1 | ${head(A)} | w |`],
    ['Rev 0', row('0', A)],
    ['Rev 1e3', row('1e3', A)],
    ['seven digits', row('1234567', A)],
    ['another repo', `| 1 | [\`aaaaaaa\`](https://github.com/x/y/commit/${A}) | w | y |`],
    ['an uppercase sha', row('1', 'A'.repeat(40))],
    ['prose', 'some words'],
  ])('keeps %s below the blocks, never reading it', (_name, line) => {
    const t = parseTable(line, REPO);
    expect(t.rows).toEqual([]);
    expect(t.rest).toHaveLength(1);
  });

  it('takes the repo as text, not as a pattern: a dot, a backslash or a bracket in it match themselves', () => {
    const summaryFor = (/** @type {string} */ repo) =>
      `<details open>\n<summary><b>👉 <a href="https://github.com/${repo}/commit/${A}"><code>aaaaaaa</code></a></b> (current)</summary>\n</details>`;
    for (const repo of ['o/r.x', 'o/r[x]', 'o/r\\x', 'o/r+x', 'o/(r)']) {
      expect(parseTable(summaryFor(repo), repo).rows).toHaveLength(1);
    }
    // A dot is a dot: it doesn't match any character.
    expect(parseTable(summaryFor('o/rXx'), 'o/r.x').rows).toHaveLength(0);
    expect(parseTable(summaryFor('o/r[x]'), 'o/rx').rows).toHaveLength(0);
  });

  it('reads CRLF text of the old shapes', () => {
    expect(parseTable(table(row('1', A)).replace(/\n/g, '\r\n'), REPO).rows).toHaveLength(1);
  });

  it('never reads a row inside an HTML comment as state', () => {
    const t = parseTable(`<!-- ${row('3 (current)', C)} -->`, REPO);
    expect(t.rows).toEqual([]);
    expect(t.rest[0]).toContain(`(current${Z})`);
  });
});

describe('renderTable', () => {
  const sample = () => ({
    rows: [
      revision({
        rev: 1,
        sha: A,
        note: 'Opened',
        rows: ['| The first push | The owner could not read it on a phone |'],
      }),
      revision({
        rev: 3,
        current: true,
        sha: C,
        prev: B,
        note: 'rewritten from <code>bbbbbbb</code> (2 commits dropped)',
        rows: ['| a | b |', '| c | d |'],
      }),
      revision({ rev: 2, sha: B, prev: A }),
    ],
    rest: [],
    omitted: 0,
  });

  it('writes a details block a revision, newest first, open for the newest alone', () => {
    expect(renderTable(sample(), REPO, { heading: true }).split('\n')).toEqual([
      '## Revisions',
      '',
      '<details open>',
      `<summary><b>👉 ${ahref(C)}</b> (current) · ${compare(B, C)} · rewritten from <code>bbbbbbb</code> (2 commits dropped)</summary>`,
      '',
      '| What changed | Why |',
      '| --- | --- |',
      '| a | b |',
      '| c | d |',
      '',
      '</details>',
      '',
      '<details>',
      `<summary>${ahref(B)} · ${compare(A, B)}</summary>`,
      '',
      '| What changed | Why |',
      '| --- | --- |',
      '|  |  |',
      '',
      '</details>',
      '',
      '<details>',
      `<summary>${ahref(A)} · Opened</summary>`,
      '',
      '| What changed | Why |',
      '| --- | --- |',
      '| The first push | The owner could not read it on a phone |',
      '',
      '</details>',
    ]);
  });

  it('writes the heading unless one stands before, then the notes and the kept lines', () => {
    const t = { ...sample(), omitted: 2, capped: 1, rest: ['extra'] };
    const out = renderTable(t, REPO, { heading: false });
    expect(out.startsWith('<details open>')).toBe(true);
    expect(out).toContain(
      "</details>\n\n_2 earlier revisions left out to stay under GitHub's limit._\n\n_1 earlier head is not listed: the table keeps the first head and the latest ones._\n\nextra",
    );
    expect(renderTable({ ...t, omitted: 1 }, REPO, { heading: false })).toContain(
      '_1 earlier revision left out',
    );
  });

  it('writes one empty row for a revision with none, and keeps what the author typed below the table', () => {
    const out = renderTable(
      {
        rows: [revision({ rev: 1, current: true, sha: A, typed: ['A note.', '- a list'] })],
        rest: [],
        omitted: 0,
      },
      REPO,
      { heading: false },
    );
    expect(out.split('\n').slice(3, -1)).toEqual([
      '| What changed | Why |',
      '| --- | --- |',
      '|  |  |',
      '',
      'A note.',
      '- a list',
      '',
    ]);
  });

  it('keeps every row the author wrote as written, however many and whatever they hold', () => {
    const rows = [
      '| a `code` with \\| a pipe | because **bold** and <b>html</b> |',
      '| a [link](https://x.y) | a <br> break |',
      '| long | ' + 'w '.repeat(500) + '|',
    ];
    const out = renderTable(
      { rows: [revision({ rev: 1, current: true, sha: A, rows })], rest: [], omitted: 0 },
      REPO,
      { heading: false },
    );
    for (const r of rows) expect(out).toContain(`\n${r}\n`);
    expect(parseTable(out, REPO).rows[0].rows).toEqual(rows);
  });

  it('is a fixpoint: reading what it wrote and writing it again changes nothing', () => {
    const once = renderTable({ ...sample(), rest: ['extra'], omitted: 1 }, REPO, { heading: true });
    expect(renderTable(parseTable(once, REPO), REPO, { heading: true })).toBe(once);
  });

  it('writes a block the check reads: green for its head, red for another, and never the table', () => {
    const out = renderTable(
      {
        rows: [
          revision({ rev: 2, current: true, sha: B, rows: ['| a (current) | b |'] }),
          revision({ rev: 1, sha: A, rows: [`| ${head(A)} (current) | b |`] }),
        ],
        rest: [],
        omitted: 0,
      },
      REPO,
      { heading: true },
    );
    expect(problems(out, B)).toEqual([]);
    expect(problems(out, A)).toHaveLength(1);
    expect(out.match(/<summary>/g)).toHaveLength(2);
  });

  it('defuses a (current) after a head link in a row or a typed line, and a tag of the block', () => {
    const out = renderTable(
      {
        rows: [
          revision({
            rev: 1,
            current: true,
            sha: A,
            rows: [`| ${head(B)} (current) | </details> <summary> |`],
            typed: ['</details>', `**${head(B)}** (current)`],
          }),
        ],
        rest: [],
        omitted: 0,
      },
      REPO,
      { heading: false },
    );
    expect(out.match(/<\/details>/g)).toHaveLength(1);
    expect(out.match(/<summary>/g)).toHaveLength(1);
    expect(out).not.toMatch(/\(current\)\s*\|/);
    expect(out).toContain(`(current${Z})`);
    expect(parseTable(out, REPO).rows).toHaveLength(1);
  });

  it('writes the old shapes as details blocks: a fixpoint from the first write', () => {
    for (const old of [
      table(row('1', A), row('2 (current)', B)),
      fresh(now(B, 'w<br>x', 'why'), older(A, 'Opened')),
      htmlTable(...htmlFirst(B, ['w'], 'why', true), ...htmlFirst(A, ['Opened'], 'goal')),
    ]) {
      const once = renderTable(parseTable(old, REPO), REPO, { heading: true });
      expect(once).not.toContain('| Rev |');
      expect(once).not.toContain('<table');
      expect(once).toContain('<details open>');
      expect(renderTable(parseTable(once, REPO), REPO, { heading: true })).toBe(once);
    }
  });

  it('is read by the check as every shape is: the current revision must name the head', () => {
    for (const text of [
      table(row('1', A), row('2 (current)', B)),
      fresh(now(B), older(A)),
      htmlTable(...htmlFirst(B, [], '', true), ...htmlFirst(A)),
      renderTable(parseTable(table(row('1', A), row('2 (current)', B)), REPO), REPO, {
        heading: false,
      }),
    ]) {
      expect(problems(text, B)).toEqual([]);
      expect(problems(text, A)).toHaveLength(1);
    }
  });
});

describe('rangeNote', () => {
  it('says nothing for a plain push, a rewrite with the commits dropped, and a head that is gone', () => {
    expect(rangeNote({ prev: A, how: 'ahead' })).toEqual({ prev: A, note: '' });
    expect(rangeNote({ prev: A, how: 'rewritten', dropped: 3 })).toEqual({
      prev: A,
      note: 'rewritten from <code>aaaaaaa</code> (3 commits dropped)',
    });
    expect(rangeNote({ prev: A, how: 'rewritten', dropped: 1 }).note).toBe(
      'rewritten from <code>aaaaaaa</code> (1 commit dropped)',
    );
    expect(rangeNote({ prev: A, how: 'rewritten', dropped: 0 }).note).toBe(
      'rewritten from <code>aaaaaaa</code>',
    );
    expect(rangeNote({ prev: A, how: 'gone' })).toEqual({
      prev: null,
      note: 'rewritten, the old head <code>aaaaaaa</code> is gone',
    });
  });
});

describe('addRevision', () => {
  it('adds revision 1 for the opening head with the goal as the Why of its row, and the new one current', () => {
    const t = addRevision(parseTable('', REPO), {
      head: B,
      prev: A,
      note: '',
      opened: { sha: A, why: 'Goal.' },
    });
    expect(t.rows).toEqual([
      revision({ rev: 1, sha: A, note: 'Opened', rows: ['| — | Goal. |'] }),
      revision({ rev: 2, current: true, sha: B, prev: A }),
    ]);
    expect(
      addRevision(parseTable('', REPO), { head: B, prev: A, note: '', opened: { sha: A, why: '' } })
        .rows[0].rows,
    ).toEqual([]);
  });

  it('continues after the highest number, moves current, and keeps every row of the others', () => {
    const start = parseTable(
      [
        block(B, { current: true }, ['| mine | yours |']),
        block(A, { note: 'Opened' }, ['| first | one |']),
      ].join('\n\n'),
      REPO,
    );
    const t = addRevision(start, { head: C, prev: B, note: '', opened: null });
    expect(t.rows.filter((r) => r.current).map((r) => r.sha)).toEqual([C]);
    expect(t.rows.map((r) => r.rev)).toEqual([2, 1, 3]);
    expect(t.rows.map((r) => r.rows)).toEqual([['| mine | yours |'], ['| first | one |'], []]);
    const out = renderTable(t, REPO, { heading: false });
    expect(out.match(/<details open>/g)).toHaveLength(1);
    expect(out.indexOf(ahref(C))).toBeLessThan(out.indexOf(ahref(B)));
  });

  it('makes a block the check reads: green for its head, red for another', () => {
    const t = addRevision(parseTable('', REPO), {
      head: B,
      prev: A,
      note: '',
      opened: { sha: A, why: '' },
    });
    const out = renderTable(t, REPO, { heading: true });
    expect(problems(out, B)).toEqual([]);
    expect(problems(out, A)).toHaveLength(1);
  });
});

describe('budgeted', () => {
  const many = (/** @type {number} */ n) => ({
    rows: Array.from({ length: n }, (_, i) =>
      revision({
        rev: i + 1,
        current: i === n - 1,
        sha: i.toString(16).padStart(2, '0').repeat(20),
        rows: [`| what ${i} ${'w'.repeat(300)} | ${'y'.repeat(400)} |`],
      }),
    ),
    rest: [],
    omitted: 0,
  });

  it('writes everything when it fits', () => {
    const out = budgeted(many(3), REPO, { heading: true });
    expect(out).toBe(renderTable(many(3), REPO, { heading: true }));
    expect(out.length).toBeLessThan(REVISIONS_BUDGET);
  });

  it('leaves out the oldest revisions whole, keeping revision 1 and the newest, and never touches a row of one it keeps', () => {
    const start = many(120);
    const out = budgeted(start, REPO, { heading: true });
    expect(out.length).toBeLessThanOrEqual(REVISIONS_BUDGET);
    const read = parseTable(out, REPO);
    expect(read.rows[0].current).toBe(true);
    expect(read.rows.at(-1)?.rev).toBe(1);
    expect(out).toContain('earlier revisions left out');
    expect(out).not.toContain('older revision: its rows');
    // Every revision kept has the rows it had; the ones gone are the oldest after revision 1.
    const had = new Map(start.rows.map((r) => [r.sha, r.rows]));
    for (const r of read.rows) expect(r.rows).toEqual(had.get(r.sha));
    const keptShas = new Set(read.rows.map((r) => r.sha));
    const gone = start.rows.filter((r) => !keptShas.has(r.sha)).map((r) => r.rev);
    expect(gone.length).toBe(start.rows.length - read.rows.length);
    expect(gone).toEqual(Array.from({ length: gone.length }, (_, i) => i + 2));
    // Written whole: every line is a block's frame, a row, the note, or a blank.
    for (const l of out.split('\n')) {
      expect(l).toMatch(
        /^(?:## Revisions|<\/?details[^>]*>|<summary>.*<\/summary>|\|.*\||_\d+ earlier .*_|)$/,
      );
    }
  });

  it('stops shrinking when only revision 1 and the newest are left', () => {
    const huge = (/** @type {number} */ rev) =>
      revision({
        rev,
        current: rev === 7,
        sha: A,
        rows: [`| ${'x'.repeat(5000)} | ${'y'.repeat(5000)} |`],
      });
    const out = budgeted({ rows: [1, 2, 3, 4, 5, 6, 7].map(huge), rest: [], omitted: 0 }, REPO, {
      heading: false,
    });
    expect(parseTable(out, REPO).rows).toHaveLength(2);
    expect(out).toContain('<details open>');
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
    const next = addRevision(parseTable(both, REPO), { head: C, prev: B, note: '', opened: null });
    const out = renderTable(next, REPO, { heading: false });
    expect(out).toContain('left out to stay under');
    expect(out).toContain('12 earlier heads are not listed');
    expect(out).toContain(`<b>👉 ${ahref(C)}</b>`);
  });
});

describe('a details block that is no revision', () => {
  it('keeps its opener and reads the lines after it as any are, so the write is a fixpoint', () => {
    const text = `<details>\n\n| [\`aaaaaaa\`](https://github.com/o/r/commit/${A})<br>w | y |`;
    const once = renderTable(parseTable(text, REPO), REPO, { heading: true });
    expect(parseTable(text, REPO).rows.map((r) => r.sha)).toEqual([A]);
    expect(renderTable(parseTable(once, REPO), REPO, { heading: true })).toBe(once);
  });
});

describe('replacement patterns', () => {
  // A `$&`, `$1`, `` $` ``, `$'` or `$$` typed by an author, or in a commit subject, is text:
  // nothing here may take it for a replacement pattern.
  it('keeps a row, a typed line and a note made of replacement patterns byte for byte', () => {
    const patterns = "Fix $& and $1 and $` and $' and $$";
    const start = parseTable(
      `<details>\n<summary>${ahref(A)}</summary>\n\n| What changed | Why |\n| --- | --- |\n| ${patterns} | ${patterns} |\n\nnote: ${patterns}\n\n</details>`,
      REPO,
    );
    const t = addRevision(start, { head: C, prev: A, note: '', opened: null });
    const out = renderTable(t, REPO, { heading: true });
    expect(out).toContain(`| ${patterns} | ${patterns} |`);
    expect(out).toContain(`note: ${patterns}`);
    expect(parseTable(out, REPO).rows.find((r) => r.sha === A)?.rows).toEqual([
      `| ${patterns} | ${patterns} |`,
    ]);
  });
});

describe('what an author types in a row', () => {
  const block = (/** @type {string[]} */ ...lines) =>
    `<details open>\n<summary>${ahref(A)} (current)</summary>\n\n| What changed | Why |\n| --- | --- |\n${lines.join('\n')}\n\n</details>`;

  it('writes a row of other than two cells as GitHub reads it, and leaves a row of two exactly as it is', () => {
    const rows = (/** @type {string} */ text) => parseTable(text, REPO).rows[0].rows;
    expect(rows(block('| a | b | c |'))).toEqual(['| a | b \\| c |']);
    expect(rows(block('| a | b | c | d'))).toEqual(['| a | b \\| c \\| d |']);
    expect(rows(block('| a \\| b |'))).toEqual(['| a \\| b | |']);
    expect(rows(block('| only |'))).toEqual(['| only | |']);
    expect(rows(block('|  a  |  b  |'))).toEqual(['|  a  |  b  |']);
    expect(rows(block('| a \\| b | c |'))).toEqual(['| a \\| b | c |']);
    const once = renderTable(parseTable(block('| a | b | c |'), REPO), REPO, { heading: false });
    expect(renderTable(parseTable(once, REPO), REPO, { heading: false })).toBe(once);
  });

  it('keeps a row that ends in a closing details tag in its revision, the tag made harmless', () => {
    const t = parseTable(`${block('| a | b </details>', '| c | d |')}`, REPO);
    expect(t.rest).toEqual([]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].rows).toHaveLength(2);
    expect(t.rows[0].rows[0]).toContain('&lt;/details>');
    expect(t.rows[0].rows[1]).toBe('| c | d |');
  });

  it('writes one open block, the newest current one, when a table has two current revisions', () => {
    const out = renderTable(
      {
        rows: [
          revision({ rev: 1, current: true, sha: A }),
          revision({ rev: 2, current: true, sha: B }),
        ],
        rest: [],
        omitted: 0,
      },
      REPO,
      { heading: false },
    );
    expect(out.match(/<details open>/g)).toHaveLength(1);
    expect(out.match(/\(current\)/g)).toHaveLength(1);
    expect(parseTable(out, REPO).rows[0]).toMatchObject({ sha: B, current: true });
  });
});
