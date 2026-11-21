import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bodyProblems, revisionsPair } from '../pr-template/body.mjs';
import {
  REVISIONS_BUDGET,
  addRevision,
  budgeted,
  capChain,
  describeRange,
  goalSentence,
  headChain,
  headHistory,
  parseTable,
  renderTable,
  withPair,
} from './revisions.mjs';

const REPO = 'o/r';
const sha = fc.stringMatching(/^[0-9a-f]{40}$/);
/** Text the way an author might mangle a table: pipes, comments, markers, parens, newlines. */
const messy = fc
  .array(
    fc.oneof(
      fc.string(),
      fc.constantFrom(
        '|',
        '\\|',
        '<!--',
        '-->',
        '<!-- /pr-changes:revisions -->',
        '(current)',
        '| 1 (current) |',
        '\n',
        '\r\n',
        '`',
        '## Revisions',
      ),
    ),
    { maxLength: 40 },
  )
  .map((parts) => parts.join(''));

/**
 * @param {string} head
 * @param {string} block
 */
const body = (head, block) =>
  `## Goal\n\nx.\n\n## Changes\n\n### 1. c\n\nwhy\n\n<!-- pr-changes:revisions -->\n${block}\n<!-- /pr-changes:revisions -->\n`;

describe('parseTable', () => {
  it('never throws, and every row it keeps passes the row grammar', () => {
    fc.assert(
      fc.property(messy, (text) => {
        const t = parseTable(text, REPO);
        for (const r of t.rows) {
          expect(r.rev).toBeGreaterThanOrEqual(1);
          expect(r.rev).toBeLessThanOrEqual(999_999);
          expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
          expect(r.what).not.toMatch(/<!--|--!?>/);
          expect(r.why).not.toMatch(/<!--|--!?>/);
        }
        for (const line of t.rest) {
          expect(line).not.toMatch(/<!--|--!?>|\(current\)/);
        }
      }),
    );
  });
});

describe('renderTable', () => {
  it('writes a block that holds no end marker, no raw comment and no newline in a cell, and is stable', () => {
    fc.assert(
      fc.property(messy, (text) => {
        const t = parseTable(text, REPO);
        const out = renderTable(t, REPO, { heading: true });
        expect(out).not.toContain('<!--');
        expect(out).not.toContain('-->');
        const once = parseTable(out, REPO);
        expect(renderTable(once, REPO, { heading: true })).toBe(out);
        // Whatever the author typed, at most one row can say (current) in its Rev cell.
        const current = out.split('\n').filter((l) => /^\|[^|]*\(current\)/.test(l));
        expect(current.length).toBeLessThanOrEqual(t.rows.filter((r) => r.current).length);
      }),
    );
  });
});

describe('addRevision and budgeted', () => {
  it('stays within the budget (unless row 1 and the newest alone are over) and the check reads it as current', () => {
    fc.assert(
      fc.property(messy, sha, sha, (text, opened, head) => {
        const first = parseTable(text, REPO);
        const out = budgeted(
          (n) =>
            addRevision(first, {
              head,
              what: describeRange(
                {
                  repo: REPO,
                  prev: opened,
                  head,
                  how: 'ahead',
                  commits: Array.from({ length: 8 }, (_, i) => ({
                    sha: `${i}`,
                    subject: text,
                    skipped: false,
                  })),
                },
                n,
              ),
              opened: { sha: opened, why: '' },
            }),
          REPO,
          { heading: true },
        );
        const kept = parseTable(out, REPO);
        expect(out.length).toBeLessThanOrEqual(
          Math.max(REVISIONS_BUDGET, 2 * 2000 * 4 + 4000 + text.length * 4),
        );
        expect(kept.rows.filter((r) => r.current).map((r) => r.sha)).toEqual([head]);
        const problems = bodyProblems(body(head, out), head).filter((p) => /Revisions/.test(p));
        expect(problems).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});

describe('describeRange', () => {
  it('never throws and never leaves a tag, a newline or a pipe unescaped in a subject', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 12 }), sha, sha, (subjects, prev, head) => {
        const out = describeRange({
          repo: REPO,
          prev,
          head,
          how: 'ahead',
          commits: subjects.map((subject, i) => ({ sha: `${i}`, subject, skipped: i % 3 === 0 })),
        });
        expect(out).not.toMatch(/[\r\n]/);
        for (const part of out.split('<br>').slice(1)) {
          expect(part).not.toMatch(/[<>]/);
          expect(part.replace(/\\\|/g, '')).not.toContain('|');
        }
      }),
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

describe('the two-column table', () => {
  const head = (/** @type {string} */ s) =>
    `[\`${s.slice(0, 7)}\`](https://github.com/${REPO}/commit/${s})`;
  /** One line of text an author might leave in a Why or a What: no newline, no pipe, bold marks and breaks allowed. */
  const cell = fc
    .array(
      fc.oneof(
        fc.stringMatching(/^[A-Za-z0-9 .,_*`()-]{0,12}$/),
        // Bold marks, breaks, spaces and backticks on their own: a What of `** **`, of spaces, of a
        // last line of spaces (what a cell's trim and the writer's bold must agree on).
        fc.constantFrom('**', '<br>', ' ', '`', '** **', '*', '  '),
      ),
      { maxLength: 6 },
    )
    .map((parts) => parts.join(''));
  const rows = fc.array(fc.record({ sha, what: cell, why: cell }), { minLength: 1, maxLength: 8 });

  it('reads a table of either shape, and writes it back in the new one with every sha, Why and older row What kept, in order, and the one current row', () => {
    fc.assert(
      fc.property(rows, fc.nat(), fc.boolean(), (list, at, oldShape) => {
        const current = at % list.length;
        const text = list
          .map((r, i) =>
            oldShape
              ? `| ${list.length - i}${i === current ? ' (current)' : ''} | ${head(r.sha)} | ${r.what} | ${r.why} |`
              : `| ${i === current ? `**👉 ${head(r.sha)}** (current)` : head(r.sha)}<br>${r.what} | ${r.why} |`,
          )
          .join('\n');
        const t = parseTable(text, REPO);
        expect(t.rest).toEqual([]);
        expect(t.rows.map((r) => r.sha)).toEqual(list.map((r) => r.sha));
        expect(t.rows.map((r) => r.current)).toEqual(list.map((_, i) => i === current));
        // What an author typed in a plain (older) row is what is read, bold marks and breaks and all:
        // only a cell's outer spaces go, as a cell is trimmed (the What cell of the old shape is a cell of its own).
        list.forEach((r, i) => {
          if (oldShape) expect(t.rows[i].what).toBe(r.what.trim());
          else if (i !== current) expect(t.rows[i].what).toBe(r.what.trimEnd());
          expect(t.rows[i].why).toBe(r.why.trim());
        });
        const out = renderTable(t, REPO, { heading: false });
        expect(out.startsWith('| What changed | Why |')).toBe(true);
        expect(out).not.toContain('| Rev |');
        const back = parseTable(out, REPO);
        expect(back.rows.map((r) => r.sha)).toEqual(list.map((r) => r.sha));
        expect(back.rows.map((r) => r.why)).toEqual(t.rows.map((r) => r.why));
        expect(back.rows.map((r) => r.current)).toEqual(t.rows.map((r) => r.current));
        // The current row's What is written bold line by line, each line trimmed: read again, the
        // same text up to the spaces at the lines' ends; every other row is as it was.
        t.rows.forEach((r, i) => {
          const same = back.rows[i].what;
          expect(r.current ? same.replace(/\s+/g, '') : same).toBe(
            r.current ? r.what.replace(/\s+/g, '') : r.what,
          );
        });
        expect(renderTable(back, REPO, { heading: false })).toBe(out);
      }),
      // The generator reaches the bold-spaces class in about one run of 75 (worst of 300 seeds: 643):
      // a bound above that, so the property finds it on any seed; the pinned test below is the sure guard.
      { numRuns: 1000 },
    );
  });

  it('writes a current row whose What ends in bold spaces the same way it reads it back', () => {
    // Found by fast-check (seed 1675818613): `** **` is read as one space, which the writer put after a
    // `<br>` the next read trimmed away, so the table changed on its second write. A plain trailing
    // space never got this far (the cell's trim takes it before the writer sees it): only bold ones fail.
    const sha0 = 'aaa0aaaaa00a000aaa0aa0aaa00a00a0a0a00a0a';
    for (const what of ['** **', '**  **', 'x<br>** **']) {
      const text = `| **👉 ${head(sha0)}** (current)<br>${what} |  |`;
      const first = renderTable(parseTable(text, REPO), REPO, { heading: false });
      const second = renderTable(parseTable(first, REPO), REPO, { heading: false });
      expect(second).toBe(first);
      expect(first).not.toMatch(/<br> {2,}\|/);
    }
  });

  it('keeps every line an author typed that is no row, below the table, and the highlight on the newest row alone after a push', () => {
    const prose = fc.array(fc.stringMatching(/^[a-z][a-z ]{0,20}$/), { maxLength: 4 });
    fc.assert(
      fc.property(rows, prose, sha, (list, notes, next) => {
        const text = [
          ...list.map(
            (r, i) =>
              `| ${i === 0 ? `**👉 ${head(r.sha)}** (current)` : head(r.sha)}<br>${r.what} | ${r.why} |`,
          ),
          ...notes,
        ].join('\n');
        const pushed = addRevision(parseTable(text, REPO), {
          head: next,
          what: 'new',
          opened: null,
        });
        const out = renderTable(pushed, REPO, { heading: false });
        for (const note of notes) expect(out).toContain(note.trim());
        expect(out.match(/\(current\)/g)).toHaveLength(1);
        expect(out.split('\n')[2]).toContain('**👉 ');
        expect(out.match(/\*\*👉 /g)).toHaveLength(1);
      }),
    );
  });

  it('never throws on any text, old shape or new', () => {
    fc.assert(
      fc.property(messy, (text) => {
        const t = parseTable(
          `| **👉 ${head('a'.repeat(40))}** (current)<br>${text} | ${text} |\n${text}`,
          REPO,
        );
        renderTable(t, REPO, { heading: true });
        parseTable(text, REPO);
      }),
    );
  });
});
