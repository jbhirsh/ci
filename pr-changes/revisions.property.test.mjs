import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bodyProblems,
  htmlLeadBold,
  htmlLeadPlain,
  htmlLink,
  revisionsPair,
} from '../pr-template/body.ts';
import {
  REVISIONS_BUDGET,
  addRevision,
  budgeted,
  capChain,
  goalSentence,
  headChain,
  headHistory,
  parseTable,
  rangeNote,
  renderTable,
  summaryReader,
  withPair,
} from './revisions.mjs';

const REPO = 'o/r';
// 1,000 runs a property; REVISIONS_FUZZ_RUNS and REVISIONS_FUZZ_SEED run the same properties
// as a fuzz (100,000 runs, several seeds), which a failure reports with its seed and counterexample.
const RUNS = Number(process.env.REVISIONS_FUZZ_RUNS ?? 1000);
const SEED =
  process.env.REVISIONS_FUZZ_SEED === undefined
    ? undefined
    : Number(process.env.REVISIONS_FUZZ_SEED);
/** @type {{ numRuns: number, seed?: number }} */
const RUN = { numRuns: RUNS, ...(SEED === undefined ? {} : { seed: SEED }) };

const sha = fc.stringMatching(/^[0-9a-f]{40}$/);
const ahref = (/** @type {string} */ s) =>
  `<a href="https://github.com/${REPO}/commit/${s}"><code>${s.slice(0, 7)}</code></a>`;
const mdlink = (/** @type {string} */ s) =>
  `[\`${s.slice(0, 7)}\`](https://github.com/${REPO}/commit/${s})`;
const ONE = 'a'.repeat(40);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const ZW = String.fromCharCode(0x200b);

/** Text the way an author, a stranger or a tool might mangle a cell: markers, tags, pipes, emoji, breaks, long runs. */
const messy = fc
  .array(
    fc.oneof(
      { weight: 6, arbitrary: fc.string() },
      { weight: 2, arbitrary: fc.string({ unit: 'binary' }) },
      {
        weight: 8,
        arbitrary: fc.constantFrom(
          '|',
          '\\|',
          '\\',
          '`',
          '```',
          '**',
          '*',
          '_',
          '-',
          '---',
          '- ',
          '# ',
          '> ',
          '1. ',
          '&',
          '&lt;',
          '"',
          ZW,
          '😀',
          '👉',
          '—',
          '(current)',
          ' (current)',
          '<!--',
          '-->',
          '--!>',
          '<!x',
          '<?php',
          '<!>',
          '</ x>',
          '</>',
          '<![CDATA[',
          '<!-- /pr-changes:revisions -->',
          '<!-- pr-changes:revisions -->',
          '\n',
          '\r\n',
          '\r',
          LS,
          PS,
          '\n\n',
          '\n \n',
          '<br>',
          '<b>',
          '</b>',
          '<details>',
          '<details open>',
          '</details>',
          '<summary>',
          '</summary>',
          '<tr>',
          '</tr>',
          '<td>',
          '</td>',
          '<table>',
          '</table>',
          '<ul>',
          '<li>',
          '## Revisions',
          '| What changed | Why |',
          '| --- | --- |',
          '|  |  |',
          '| 1 (current) |',
          "_3 earlier revisions left out to stay under GitHub's limit._",
          '_2 earlier heads are not listed: the table keeps the first head and the latest ones._',
          ahref(ONE),
          `<b>👉 ${ahref(ONE)}</b> (current)`,
          `<summary><b>👉 ${ahref(ONE)}</b> (current)</summary>`,
          `<details open>\n<summary><b>👉 ${ahref(ONE)}</b> (current)</summary>\n\n| a | b |\n\n</details>`,
          `<tr><td>${ahref(ONE)} (current)</td><td>y</td></tr>`,
          `| **👉 ${mdlink(ONE)}** (current)<br>**w** | y |`,
          `| ${mdlink(ONE)}<br>w | y |`,
          `| 2 (current) | ${mdlink(ONE)} | w | y |`,
        ),
      },
      { weight: 1, arbitrary: fc.integer({ min: 1, max: 6000 }).map((n) => 'x'.repeat(n)) },
    ),
    { maxLength: 24 },
  )
  .map((parts) => parts.join(''));

/** A line of the author's table: starts with a pipe, holds anything but a line break. */
const authorRow = messy
  .map((t) => `|${t.replace(/[\r\n]+/g, ' ')}`)
  // Not what the reader skips as the table's own: its header, its rule, an empty row.
  .filter((r) => {
    const c = r.replace(/[\u2028\u2029]/g, ' ').trim();
    return (
      !/^\|(?:\s*\|)+$/.test(c) &&
      !/^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(c) &&
      !/^\|\s*(?:Rev|What changed)\s*\|/.test(c)
    );
  });

/**
 * A table of any shape: revisions newest first with distinct places from the oldest, any number
 * current, a compare link or none, a note or none, any rows and lines typed, the two notes.
 */
const tables = fc
  .record({
    rows: fc.array(
      fc.record({
        sha,
        prev: fc.option(sha, { nil: null }),
        note: fc.oneof(
          fc.constant(''),
          fc.constantFrom('Opened', 'rewritten from <code>aaaaaaa</code> (2 commits dropped)'),
          messy,
        ),
        rows: fc.array(authorRow, { maxLength: 8 }),
        typed: fc.array(
          messy.map((x) => x.replace(/^\s*\|/, 'x|')),
          { maxLength: 3 },
        ),
        current: fc.boolean(),
      }),
      { minLength: 1, maxLength: 10 },
    ),
    omitted: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 999 })),
    capped: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 999 })),
  })
  .map(({ rows, omitted, capped }) => ({
    rows: rows.map((r, i) => ({ ...r, rev: rows.length - i })),
    rest: [],
    omitted,
    capped,
  }));

/**
 * The text of a line for comparing what an author typed with what is read: the escapes the tool
 * makes (`&lt;`, `&gt;`) undone, the characters those escapes are for (`< > ! ? -`) and the
 * zero-width space dropped on both sides, and whitespace squeezed. Nothing is sanitised here: it
 * only drops what the tool may change.
 */
const flat = (/** @type {string} */ text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[<>!?\-\u200b]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** A row as `flat` reads it, with the pipes and the backslashes of its escapes dropped too: a row of other than two cells is written as GitHub reads it. */
const flatRow = (/** @type {string} */ row) => flat(row.replace(/[|\\]/g, ' '));

/** Tables of at most 4 revisions: the round-trip properties don't need 8, and each thousand runs stays near a second under load. */
const smallTables = tables.map((t) => ({ ...t, rows: t.rows.slice(0, 4) }));

const wrap = (/** @type {string} */ block) =>
  `## Goal\n\nx.\n\n## Changes\n\n### 1. c\n\nwhy\n\n<!-- pr-changes:revisions -->\n${block}\n<!-- /pr-changes:revisions -->\n`;
const BAD_TAG = /<\/?(?:details|summary|table|thead|tbody|tfoot|tr|td|th|colgroup|col|caption)\b/i;
const BOGUS = /<!|<\?|<\/(?![A-Za-z])/;

describe('parseTable', () => {
  it('never throws, and every revision it keeps passes the grammar', () => {
    fc.assert(
      fc.property(messy, (text) => {
        const t = parseTable(text, REPO);
        for (const r of t.rows) {
          expect(r.rev).toBeGreaterThanOrEqual(1);
          // A place from the oldest: a Rev cell's own (6 digits at most) or the rows, counted with the notes' counts.
          expect(r.rev).toBeLessThanOrEqual(
            Math.max(999_999, t.rows.length + t.omitted + (t.capped ?? 0)),
          );
          expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
          if (r.prev !== null) expect(r.prev).toMatch(/^[0-9a-f]{40}$/);
          for (const l of [...r.rows, ...r.typed, r.note]) {
            expect(l).not.toMatch(/<!--|--!?>|[\r\n\u2028\u2029]/);
            expect(l).not.toMatch(BAD_TAG);
            expect(l).not.toMatch(BOGUS);
          }
          for (const l of r.rows) expect(l.startsWith('|')).toBe(true);
        }
        for (const l of t.rest) {
          expect(l).not.toMatch(/<!--|--!?>|\(current\)|[\u2028\u2029]/);
          expect(l).not.toMatch(BOGUS);
        }
      }),
      RUN,
    );
  });

  it('agrees with the check on every form of a current revision, in every shape', () => {
    /** @type {[string, (s: string) => string][]} */
    const forms = [
      ['details', (s) => `<summary><b>👉 ${ahref(s)}</b> (current)</summary>`],
      ['details', (s) => `<summary><b>${ahref(s)}</b> (current)</summary>`],
      ['details', (s) => `<summary>${ahref(s)} (current)</summary>`],
      ['details', (s) => `<summary>${ahref(s)} (current) · note</summary>`],
      ['details', (s) => `<summary>${ahref(s)}</summary>`],
      ['details', (s) => `<summary><b>👉 ${ahref(s)}</b>(current)</summary>`],
      ['details', (s) => `<summary><b>👉 ${ahref(s)} (current)</b></summary>`],
      ['details', (s) => `<summary>see ${ahref(s)} (current)</summary>`],
      ['details', (s) => `<summary>${ahref(s).replace('<code>', '<code>0')} (current)</summary>`],
      [
        'details',
        (s) => `<summary>${ahref(s).replace('github.com', 'example.com')} (current)</summary>`,
      ],
      ['table', (s) => `<tr><td><b>👉 ${ahref(s)}</b> (current)</td><td>y</td></tr>`],
      ['table', (s) => `<tr><td>${ahref(s)} (current)</td><td>y</td></tr>`],
      ['table', (s) => `<tr><td>${ahref(s)}</td><td>y</td></tr>`],
      ['md', (s) => `| **👉 ${mdlink(s)}** (current)<br>w | y |`],
      ['md', (s) => `| ${mdlink(s)} (current)<br>w | y |`],
      ['md', (s) => `| ${mdlink(s)}<br>fix (current) | y |`],
      ['md', (s) => `| **👉 ${mdlink(s)}**(current) | y |`],
      ['md4', (s) => `| 2 (current) | ${mdlink(s)} | w | y |`],
    ];
    fc.assert(
      fc.property(fc.constantFrom(...forms), sha, fc.boolean(), (form, s, spaced) => {
        const [kind, make] = form;
        const cell = make(s);
        const text =
          kind === 'details'
            ? `<details${spaced ? ' open' : ''}>\n${cell}\n\n| What changed | Why |\n| --- | --- |\n| a | b |\n\n</details>`
            : kind === 'table'
              ? `<table>\n${cell}\n</table>`
              : cell;
        const parsed = parseTable(text, REPO).rows.some((r) => r.current);
        const checked = !bodyProblems(wrap(text), s, { pushed: true }).some((p) =>
          /no current row/.test(p),
        );
        expect(checked, text).toBe(parsed);
      }),
      RUN,
    );
  });

  it('reads every sha, current flag, Why and line of an old table, and loses no typed text', () => {
    const word = fc.stringMatching(/^[A-Za-z0-9 .,_*`()-]{0,12}$/);
    const whyText = fc
      .array(fc.oneof(word, fc.constantFrom('**')), { maxLength: 5 })
      .map((parts) => parts.join(''));
    const cellText = fc
      .array(fc.oneof(word, fc.constantFrom('**', '<br>')), { maxLength: 5 })
      .map((parts) => parts.join(''));
    const rows = fc.array(fc.record({ sha, what: cellText, why: whyText }), {
      minLength: 1,
      maxLength: 8,
    });
    /** The letters and digits of a text: what a reader would see of it, in order. */
    const alnum = (/** @type {string} */ t) => {
      let inTag = false;
      let out = '';
      for (const c of t) {
        if (c === '<') inTag = true;
        else if (c === '>') inTag = false;
        else if (!inTag && /[A-Za-z0-9]/.test(c)) out += c;
      }
      return out;
    };
    fc.assert(
      fc.property(rows, fc.nat(), fc.constantFrom('four', 'two'), (list, at, shape) => {
        const current = at % list.length;
        const text = list
          .map((r, i) =>
            shape === 'four'
              ? `| ${list.length - i}${i === current ? ' (current)' : ''} | ${mdlink(r.sha)} | ${r.what} | ${r.why} |`
              : `| ${i === current ? `**👉 ${mdlink(r.sha)}** (current)` : mdlink(r.sha)}<br>${r.what} | ${r.why} |`,
          )
          .join('\n');
        const t = parseTable(text, REPO);
        expect(t.rest).toEqual([]);
        expect(t.rows.map((r) => r.sha)).toEqual(list.map((r) => r.sha));
        expect(t.rows.map((r) => r.current)).toEqual(list.map((_, i) => i === current));
        const out = renderTable(t, REPO, { heading: false });
        expect(out.startsWith('<details')).toBe(true);
        expect(out).not.toContain('| Rev |');
        const back = parseTable(out, REPO);
        expect(back.rows.map((r) => r.sha)).toEqual(list.map((r) => r.sha));
        // One revision is current: the newest of those that say so.
        const newest = [...t.rows].sort((a, b) => b.rev - a.rev).find((r) => r.current);
        expect(back.rows.map((r) => r.current)).toEqual(t.rows.map((r) => r === newest));
        list.forEach((r, i) => {
          // Nothing the author typed is lost: the What and the Why are in the row, in order.
          expect(alnum(back.rows[i].rows.join(' '))).toBe(alnum(r.what) + alnum(r.why));
        });
        expect(renderTable(back, REPO, { heading: false })).toBe(out);
      }),
      RUN,
    );
  });
});

describe('renderTable', () => {
  it('writes a block that holds no raw comment, and is stable: read and written again it is the same', () => {
    fc.assert(
      fc.property(messy, (text) => {
        const t = parseTable(text, REPO);
        const out = renderTable(t, REPO, { heading: true });
        expect(out).not.toContain('<!--');
        expect(out).not.toContain('-->');
        expect(renderTable(parseTable(out, REPO), REPO, { heading: true })).toBe(out);
        // Whatever was typed, no more summaries say (current) than were read as current.
        const current = out
          .split('\n')
          .filter((l) =>
            /^<summary>(?:<b>👉 )?<a href=[^>]*><code>[0-9a-f]{7}<\/code><\/a>(?:<\/b>)? \(current\)/.test(
              l,
            ),
          );
        expect(current.length).toBeLessThanOrEqual(t.rows.filter((r) => r.current).length);
      }),
      RUN,
    );
  });

  it('writes, reads and writes again the same table, for a table of any shape', () => {
    fc.assert(
      fc.property(smallTables, (t) => {
        const out = renderTable(t, REPO, { heading: true });
        const back = parseTable(out, REPO);
        expect(back.rest).toEqual([]);
        expect(renderTable(back, REPO, { heading: true })).toBe(out);
        expect(back.rows.map((r) => r.sha)).toEqual(t.rows.map((r) => r.sha));
        // One revision is current: the newest of those that say so.
        const newest = [...t.rows].sort((a, b) => b.rev - a.rev).find((r) => r.current);
        expect(back.rows.map((r) => r.current)).toEqual(t.rows.map((r) => r === newest));
        expect(back.rows.map((r) => r.prev)).toEqual(t.rows.map((r) => r.prev));
        expect(back.omitted).toBe(t.omitted);
        expect(back.capped).toBe(t.capped);
      }),
      RUN,
    );
  });

  it('keeps what was written: each row and each typed line comes back as typed, up to the escapes it makes', () => {
    fc.assert(
      fc.property(smallTables, (t) => {
        const back = parseTable(renderTable(t, REPO, { heading: false }), REPO);
        back.rows.forEach((r, i) => {
          expect(r.rows.map(flatRow).filter((l) => l !== '')).toEqual(
            t.rows[i].rows.map(flatRow).filter((l) => l !== ''),
          );
          expect(r.typed.map(flat).filter((l) => l !== '')).toEqual(
            t.rows[i].typed.map(flat).filter((l) => l !== ''),
          );
        });
      }),
      RUN,
    );
  });

  it('keeps a row of plain words, pipes, code, bold and links exactly as written', () => {
    const plainCell = fc.stringMatching(/^[A-Za-z0-9 .,;:'"()_*`[\]/=#&%@!?+—…-]{1,40}$/);
    const verbatim = fc
      .tuple(plainCell, plainCell)
      .map(([a, b]) => `| ${a.trim() || 'a'} | ${b.trim() || 'b'} |`)
      .filter((r) => !/^\|\s*:?-{3,}:?\s*\|/.test(r));
    fc.assert(
      fc.property(fc.array(verbatim, { minLength: 1, maxLength: 12 }), sha, (rows, s) => {
        const t = {
          rows: [{ rev: 1, current: true, sha: s, prev: null, note: '', rows, typed: [] }],
          rest: [],
          omitted: 0,
        };
        const out = renderTable(t, REPO, { heading: false });
        for (const r of rows) expect(out).toContain(`\n${r}\n`);
        expect(parseTable(out, REPO).rows[0].rows).toEqual(rows);
      }),
      RUN,
    );
  });
});

describe('blank lines in a block', () => {
  it('blank lines between and around its lines, anywhere but inside the summary, read as the same revisions, and the current one is still found by the parser and the check', () => {
    fc.assert(
      fc.property(
        // Blank lines don't depend on how many revisions or rows a block holds, only on where they
        // fall: a small block keeps a thousand runs cheap (a block of up to 8 revisions took ~5 s on CI).
        tables.map((t) => ({
          ...t,
          rows: t.rows.slice(0, 2).map((r) => ({ ...r, rows: r.rows.slice(0, 2) })),
        })),
        fc.constantFrom('\n\n', '\n \n\t\n', '\r\n\r\n', '\n\n\n\n'),
        (t, gap) => {
          const written = renderTable(t, REPO, { heading: false });
          const base = parseTable(written, REPO);
          const normal = renderTable(base, REPO, { heading: false });
          const spread = normal.split('\n').join(gap);
          const back = parseTable(spread, REPO);
          expect(back.rest).toEqual([]);
          expect(back.rows).toEqual(base.rows);
          expect(renderTable(back, REPO, { heading: false })).toBe(normal);
          const named = base.rows.find((r) => r.current)?.sha;
          // A line of its own that opens a code fence hides what follows from the check (and from GitHub, which
          // renders it as code): the tool never writes one, so only an author's own reformatting can.
          const fenced = /^ {0,3}(`{3,}|~{3,})/m.test(spread);
          if (named !== undefined && !fenced) {
            expect(back.rows.find((r) => r.current)?.sha).toBe(named);
            expect(
              bodyProblems(wrap(spread), named, { pushed: true }).filter((p) =>
                /names another commit/.test(p),
              ),
            ).toEqual([]);
          }
        },
      ),
      RUN,
    );
  });
});

describe('addRevision and budgeted', () => {
  it('stays within the budget (unless revision 1 and the newest alone are over), never cuts a row, and the check reads it as current', () => {
    fc.assert(
      fc.property(tables, sha, (t, head) => {
        const first = parseTable(renderTable(t, REPO, { heading: false }), REPO);
        const out = budgeted(
          addRevision(first, { head, prev: ONE, note: '', opened: { sha: ONE, why: '' } }),
          REPO,
          { heading: true },
        );
        const kept = parseTable(out, REPO);
        // Held to the budget unless nothing is left to drop: only revision 1 and the newest.
        if (out.length > REVISIONS_BUDGET) expect(kept.rows.length).toBeLessThanOrEqual(2);
        for (const l of out.split('\n')) {
          expect(l).toMatch(
            /^(?:## Revisions|<\/?details[^\n]*>|<summary>[^\n]*<\/summary>|\|[^\n]*|_\d+ earlier [^\n]*_|[^\n]*)$/,
          );
        }
        // A revision that is kept has every row it had, as it was: only whole oldest ones go.
        const before = new Map(first.rows.map((r) => [r.sha + r.rev, r.rows]));
        for (const r of kept.rows) {
          const had = before.get(r.sha + r.rev);
          if (had && had.length > 0) expect(r.rows).toEqual(had);
        }
        expect(kept.rows.filter((r) => r.current && r.sha === head)).toHaveLength(1);
        // The new revision's placeholder is the author's to fill (ci#140): the one problem, until
        // its row is written. The newest revision is the first block, so its placeholder is the first.
        const revisionsProblems = (/** @type {string} */ text) =>
          bodyProblems(wrap(text), head).filter((p) => /Revisions/.test(p));
        expect(revisionsProblems(out)).toEqual([
          `fill Revisions' current revision, \`${head.slice(0, 7)}\`: its table has no row with both cells filled. In the description, write one row for each change this push made, both cells in plain words, such as \`| The cap fails closed | It's the only paid API |\` (each row opens with \`|\`; write a pipe in a cell as \`\\|\`). Do it once this push's \`PR changes\` run has ended: a run still going can write an older copy over your edit`,
        ]);
        expect(revisionsProblems(out.replace('|  |  |', '| A change | Its reason |'))).toEqual([]);
      }),
      { ...RUN, numRuns: Math.max(100, Math.floor(RUN.numRuns / 10)) },
    );
  });

  it('keeps every row the author wrote, in order, through any number of pushes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(authorRow, { maxLength: 4 }), { minLength: 1, maxLength: 6 }),
        (perPush) => {
          let t = parseTable('', REPO);
          const written = /** @type {string[][]} */ ([]);
          perPush.forEach((rows, i) => {
            const head = (i + 1).toString(16).padStart(2, '0').repeat(20);
            t = addRevision(t, {
              head,
              prev: i === 0 ? ONE : written.length.toString(16).padStart(2, '0').repeat(20),
              note: '',
              opened: { sha: ONE, why: '' },
            });
            // The author fills the new current revision's rows in the description.
            t = { ...t, rows: t.rows.map((r) => (r.current ? { ...r, rows } : r)) };
            const out = renderTable(t, REPO, { heading: false });
            t = parseTable(out, REPO);
            written.push(t.rows.find((r) => r.current)?.rows ?? []);
          });
          // After every push: each revision still holds the rows read when it was written.
          const final = t.rows.filter((r) => r.rev > 1).sort((a, b) => a.rev - b.rev);
          expect(final.map((r) => r.rows)).toEqual(written);
        },
      ),
      RUN,
    );
  });
});

describe('rangeNote', () => {
  it('never throws, and writes only a note of its own: code, a number, plain words', () => {
    fc.assert(
      fc.property(
        sha,
        fc.constantFrom('ahead', 'rewritten', 'gone'),
        fc.integer({ min: 0, max: 9999 }),
        (prev, how, dropped) => {
          const out = rangeNote({ prev, how, dropped });
          expect(out.note).toMatch(/^(?:|rewritten[^<>]*(?:<code>[0-9a-f]{7}<\/code>[^<>]*)?)$/);
          expect(out.prev === null || out.prev === prev).toBe(true);
          expect(how === 'gone' ? out.prev === null : out.prev === prev).toBe(true);
        },
      ),
      RUN,
    );
  });
});

describe('goalSentence', () => {
  it('never throws and stays one escaped line of at most 200 characters', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 6 }), (lines) => {
        const out = goalSentence(['## Goal', ...lines]);
        expect([...out].length).toBeLessThanOrEqual(400);
        expect(out).not.toMatch(/[<>\r\n]/);
      }),
    );
  });
});

describe('withPair (property)', () => {
  const PAIR = '<!-- pr-changes:revisions -->\n<!-- /pr-changes:revisions -->';
  const body = fc
    .array(
      fc.oneof(
        fc.string(),
        fc.constantFrom(
          '\n',
          '\n\n',
          '---',
          '_footer_',
          '`',
          '```',
          '<!-- pr-changes:index -->',
          '<!-- /pr-changes:index -->',
          '<!-- pr-changes:revisions -->',
          '<!-- /pr-changes:revisions -->',
          '<!-- pr-changes:change:1 -->',
        ),
      ),
      { maxLength: 30 },
    )
    .map((parts) => parts.join(''));
  const squash = (/** @type {string} */ t) => t.replace(/\s+/g, '');

  it('never throws, is idempotent, and only ever adds the one empty pair', () => {
    fc.assert(
      fc.property(body, (b) => {
        const out = withPair(b);
        expect(withPair(out)).toBe(out);
        if (out === b) return;
        // One clean pair, as the description check counts it, and nothing else added.
        const at = revisionsPair(out).at;
        expect(at).not.toBeNull();
        const { from, to } = /** @type {{ from: number, to: number }} */ (at);
        expect(out.slice(from, to).replace(/\r?\n/, '\n')).toBe(PAIR);
        expect(squash(out.slice(0, from) + out.slice(to))).toBe(squash(b));
      }),
    );
  });
});

describe('headChain and capChain (property)', () => {
  const heads = fc.array(sha, { maxLength: 40 });
  const noise = fc.array(
    fc.oneof(
      fc.record({ event: fc.constant('committed'), sha }),
      fc.record({ event: fc.string(), commit_id: fc.oneof(sha, fc.string(), fc.integer()) }),
    ),
    { maxLength: 10 },
  );

  it('lists heads in order, without a repeat in a row, ending at the head', () => {
    fc.assert(
      fc.property(heads, noise, sha, fc.option(sha, { nil: null }), (ids, extra, head, before) => {
        const events = [
          ...extra,
          ...ids.map((commit_id) => ({ event: 'head_ref_force_pushed', commit_id })),
        ];
        const chain = headChain(events, { head, before });
        if (chain.length === 0) return;
        expect(chain.length).toBeGreaterThanOrEqual(2);
        expect(chain[chain.length - 1]).toBe(head);
        for (let i = 1; i < chain.length; i++) expect(chain[i]).not.toBe(chain[i - 1]);
        // every head but the last two came from a force-push, in the order they were made
        const fromPushes = ids.filter((id, i) => id !== ids[i - 1]);
        expect(fromPushes.join()).toContain(chain.slice(0, -2).join());
      }),
    );
  });

  it('keeps the first head and the latest, each with its true place, in order', () => {
    fc.assert(
      fc.property(
        fc.array(sha, { minLength: 2, maxLength: 60 }),
        fc.integer({ min: 2, max: 25 }),
        (chain, max) => {
          const { kept, omitted } = capChain(chain, max);
          expect(kept.length).toBeLessThanOrEqual(max);
          expect(kept.length + omitted).toBe(chain.length);
          expect(kept[0].rev).toBe(1);
          expect(kept[kept.length - 1].rev).toBe(chain.length);
          for (let i = 0; i < kept.length; i++) {
            expect(kept[i].sha).toBe(chain[kept[i].rev - 1]);
            if (i > 0) expect(kept[i].rev).toBeGreaterThan(kept[i - 1].rev);
          }
        },
      ),
    );
  });
});

describe('headHistory (property)', () => {
  it('says the first head came from a force-push only when one did, apart from the head', () => {
    fc.assert(
      fc.property(
        fc.array(sha, { maxLength: 20 }),
        sha,
        fc.option(sha, { nil: null }),
        (ids, head, before) => {
          const events = ids.map((commit_id) => ({ event: 'head_ref_force_pushed', commit_id }));
          const { chain, fromTimeline } = headHistory(events, { head, before });
          expect(chain).toEqual(headChain(events, { head, before }));
          if (chain.length === 0) {
            expect(fromTimeline).toBe(false);
            return;
          }
          if (fromTimeline) expect(ids).toContain(chain[0]);
          else expect(chain[0] === before || ids.every((id) => id === head)).toBe(true);
        },
      ),
    );
  });
});

describe('summaryReader (property)', () => {
  // The one pattern the reader replaced (ci#157), kept as the reference: cubic on spaces after
  // `· ` with text after `</summary>`, so the lines here stay short enough for it to finish.
  const where = REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const compare = `<a href="https://github\\.com/${where}/compare/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})">compare <code>[0-9a-f]{7}…[0-9a-f]{7}</code></a>`;
  const [oldBold, oldPlain] = [htmlLeadBold, htmlLeadPlain].map(
    (lead) =>
      new RegExp(
        String.raw`^<summary>\s*${lead(htmlLink(where))}(\s*\(current\))?(?:\s*·\s*${compare})?(?:\s*·\s*([\s\S]*?))?\s*</summary>$`,
      ),
  );
  /** What the old pattern read of `label`, in the reader's shape. */
  const reference = (/** @type {string} */ label) => {
    const s = oldBold.exec(label) ?? oldPlain.exec(label);
    if (!s) return null;
    return {
      sha: s[1],
      current: s[3] !== undefined,
      ...(s[4] === undefined ? {} : { from: s[4], to: s[5] }),
      ...(s[6] === undefined ? {} : { note: s[6] }),
    };
  };
  const [A, B, C] = ['a', 'b', 'c'].map((c) => c.repeat(40));
  const ahrefOf = (/** @type {string} */ s, /** @type {string} */ repo = REPO) =>
    `<a href="https://github.com/${repo}/commit/${s}"><code>${s.slice(0, 7)}</code></a>`;
  const compareOf = (/** @type {string} */ from, /** @type {string} */ to, repo = REPO) =>
    `<a href="https://github.com/${repo}/compare/${from}...${to}">compare <code>${from.slice(0, 7)}…${to.slice(0, 7)}</code></a>`;
  const shaOf = fc.constantFrom(A, B, C);
  // Spaces of every kind the pattern's `\s` reads, and two it doesn't.
  const space = fc
    .array(fc.constantFrom(' ', '\t', '\r', ' ', LS, PS, '　', '﻿', ZW, '\u0085'), { maxLength: 4 })
    .map((s) => s.join(''));
  const lead = fc.oneof(
    shaOf.map((s) => `<b>👉 ${ahrefOf(s)}</b>`),
    shaOf.map((s) => `<b>${ahrefOf(s)}</b>`),
    shaOf.map((s) => ahrefOf(s)),
    // Near misses: another repo, a link text that isn't the sha's, upper-case hex, a short sha.
    shaOf.map((s) => ahrefOf(s, 'o/x')),
    shaOf.map((s) => ahrefOf(s).replace(`<code>${s.slice(0, 7)}`, '<code>1234567')),
    shaOf.map((s) => ahrefOf(s.toUpperCase())),
    shaOf.map((s) => ahrefOf(s.slice(0, 39))),
    shaOf.map((s) => `<b>👉${ahrefOf(s)}</b>`),
  );
  const part = fc.oneof(
    space,
    fc.constantFrom('·', ' · ', '·  ', '(current)', ' (current)', '</summary>', '<b>', '</a>', 'x'),
    fc.tuple(shaOf, shaOf).map(([f, t]) => compareOf(f, t)),
    fc.tuple(shaOf, shaOf).map(([f, t]) => ` · ${compareOf(f, t)}`),
    fc.tuple(shaOf, shaOf).map(([f, t]) => compareOf(f, t, 'o/x')),
    fc.string({ maxLength: 6 }),
    fc.string({ unit: 'binary', maxLength: 4 }),
  );
  const label = fc
    .tuple(
      fc.constantFrom('<summary>', '<summary> ', '<summary>\t', '<summary', ' <summary>'),
      lead,
      fc.array(part, { maxLength: 8 }),
      fc.constantFrom('</summary>', ' </summary>', '</summary> ', '</summary>x', '', '</Summary>'),
    )
    .map(([open, head, parts, close]) => `${open}${head}${parts.join('')}${close}`);

  it('reads every summary line as the old pattern did: the sha, (current), the range and the note, or no match', () => {
    const read = summaryReader(where);
    fc.assert(
      fc.property(label, (line) => {
        expect(read(line)).toEqual(reference(line));
      }),
      RUN,
    );
  });

  it('reads the forms the tool writes, and those the old pattern read surprisingly, the same way', () => {
    const read = summaryReader(where);
    for (const line of [
      `<summary><b>👉 ${ahrefOf(B)}</b> (current) · ${compareOf(A, B)} · rewritten from <code>aaaaaaa</code></summary>`,
      `<summary>${ahrefOf(A)} · Opened</summary>`,
      // A compare link with text after it and no ` · `: the whole is a note.
      `<summary>${ahrefOf(B)} · ${compareOf(A, B)} more</summary>`,
      // ` · ` before nothing: an empty note, not none.
      `<summary>${ahrefOf(B)} · </summary>`,
      `<summary>${ahrefOf(B)} (current) (current)</summary>`,
      `<summary>${ahrefOf(B)} · a </summary> b</summary>`,
    ]) {
      expect(read(line)).toEqual(reference(line));
    }
    expect(read(`<summary>${ahrefOf(B)} · </summary>`)).toEqual({
      sha: B,
      current: false,
      note: '',
    });
  });
});
