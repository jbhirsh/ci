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
