// Properties of the byte compare and the line counts, over any text: an
// app's file is outside input, and the PR's table must never throw on one.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blockers, codeCell, diffStat, lineDiff, sameBytes } from './plan.ts';

/** Text made of a few short lines, so that runs share lines often. */
const lines = fc
  .array(fc.oneof(fc.constantFrom('a', 'b', 'c', '', ' x', '\r'), fc.string({ maxLength: 4 })), {
    maxLength: 30,
  })
  .map((parts) => parts.join('\n'));
const text = fc.oneof(
  lines,
  fc.string({ maxLength: 200 }),
  fc.string({ unit: 'binary', maxLength: 60 }),
);

/**
 * How many times each line occurs.
 *
 * @param {string[]} list
 */
const counts = (list) => {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const line of list) out.set(line, (out.get(line) ?? 0) + 1);
  return out;
};

describe('the byte compare and the line counts', () => {
  it('agree with === and never throw', () => {
    fc.assert(
      fc.property(text, text, (a, b) => {
        const same = sameBytes(Buffer.from(a), Buffer.from(b));
        expect(same).toBe(a === b);
        const stat = diffStat(a, b);
        expect(stat.added + stat.removed === 0).toBe(a === b);
      }),
    );
  });

  it('count exactly the change in lines, and take lines only from each side', () => {
    fc.assert(
      fc.property(text, text, (a, b) => {
        const { removed, added } = lineDiff(a, b);
        const before = a.split('\n');
        const after = b.split('\n');
        expect(added.length - removed.length).toBe(after.length - before.length);
        // What survives (before less what it lost) is also what after keeps.
        const kept = counts(before);
        for (const line of removed) kept.set(line, (kept.get(line) ?? 0) - 1);
        const left = counts(after);
        for (const line of added) left.set(line, (left.get(line) ?? 0) - 1);
        for (const [line, n] of kept) expect(n >= 0 && n === (left.get(line) ?? 0)).toBe(true);
        for (const [line, n] of left) expect(n >= 0 && n === (kept.get(line) ?? 0)).toBe(true);
      }),
    );
  });

  it('count nothing changed from a text to itself, and the same both ways', () => {
    fc.assert(
      fc.property(text, text, (a, b) => {
        expect(diffStat(a, a)).toEqual({ added: 0, removed: 0 });
        const there = diffStat(a, b);
        const back = diffStat(b, a);
        expect(back).toEqual({ added: there.removed, removed: there.added });
      }),
    );
  });
});

describe('codeCell', () => {
  /** @param {string} html */
  const decode = (html) =>
    html
      .replace(/^<code>|<\/code>$/g, '')
      .replace(/&#(\d+);|&(amp|lt|gt);/g, (_, code, name) =>
        code
          ? String.fromCharCode(Number(code))
          : { amp: '&', lt: '<', gt: '>' }[/** @type {'amp' | 'lt' | 'gt'} */ (name)],
      );

  it('holds any text in one table cell, and reads back as that text on one line', () => {
    fc.assert(
      fc.property(fc.oneof(text, fc.stringMatching(/^[\\|&<> a-z\n]{0,20}$/)), (value) => {
        const html = codeCell(value);
        expect(html.slice(6, -7)).not.toMatch(/[|\\<>\n\r]/);
        expect(decode(html)).toBe(value.replace(/\s+/g, ' '));
      }),
    );
  });
});

describe('blockers', () => {
  const name = fc.constantFrom('a', 'b', 'c');
  const state = fc.record({
    threads: fc.array(
      fc.record({
        isResolved: fc.boolean(),
        path: fc.option(fc.string({ maxLength: 5 })),
        line: fc.option(fc.nat(99)),
      }),
      { maxLength: 4 },
    ),
    required: fc.uniqueArray(name, { maxLength: 3 }),
    checkRuns: fc.uniqueArray(
      fc.record({
        id: fc.nat(50),
        name,
        status: fc.constantFrom('completed', 'in_progress', 'queued'),
        conclusion: fc.option(
          fc.constantFrom('success', 'failure', 'skipped', 'cancelled', 'neutral'),
        ),
      }),
      { selector: (run) => run.id, maxLength: 6 },
    ),
    statuses: fc.uniqueArray(
      fc.record({
        context: name,
        state: fc.constantFrom('success', 'failure', 'error', 'pending'),
      }),
      { selector: (s) => s.context, maxLength: 3 },
    ),
    mergeable: fc.option(fc.constantFrom('blocked', 'clean', 'unstable', 'behind', 'dirty')),
    ruleTypes: fc.array(fc.constantFrom('pull_request', 'code_scanning'), { maxLength: 2 }),
  });

  it('names each unresolved thread and each failed required check, nothing else, and never throws', () => {
    fc.assert(
      fc.property(state, (s) => {
        const causes = blockers(s);
        const threads = causes.filter((c) => c.startsWith('unresolved review thread'));
        expect(threads).toHaveLength(s.threads.filter((t) => !t.isResolved).length);
        const failed = causes.filter((c) => c.startsWith('required check'));
        for (const cause of failed) {
          const context = /"(.*)"/.exec(cause)?.[1] ?? '';
          expect(s.required).toContain(context);
          const newest = s.checkRuns
            .filter((r) => r.name === context)
            .sort((x, y) => y.id - x.id)[0];
          const status = s.statuses.find((st) => st.context === context);
          expect(
            (newest?.status === 'completed' &&
              ['failure', 'cancelled'].includes(newest.conclusion ?? '')) ||
              ['failure', 'error'].includes(status?.state ?? ''),
          ).toBe(true);
        }
        const blocked = causes.filter((c) => c.startsWith('GitHub says'));
        // Only for a blocked PR with no other cause to name.
        if (blocked.length > 0) {
          expect(s.mergeable).toBe('blocked');
          expect(causes).toEqual(blocked);
        }
        expect(threads.length + failed.length + blocked.length).toBe(causes.length);
      }),
    );
  });

  it('never leaves a blocked PR with no cause once every required check passed', () => {
    fc.assert(
      fc.property(state, (s) => {
        const all = s.required.map((context, i) => ({
          id: 100 + i,
          name: context,
          status: 'completed',
          conclusion: 'success',
        }));
        const causes = blockers({
          ...s,
          mergeable: 'blocked',
          checkRuns: [...s.checkRuns, ...all],
          statuses: [],
        });
        expect(causes.length).toBeGreaterThan(0);
      }),
    );
  });
});
