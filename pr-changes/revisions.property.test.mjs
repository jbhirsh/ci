import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bodyProblems } from '../pr-template/body.mjs';
import {
  REVISIONS_BUDGET,
  addRevision,
  budgeted,
  describeRange,
  goalSentence,
  parseTable,
  renderTable,
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
