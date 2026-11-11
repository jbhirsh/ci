import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { changedBaselines, pairBaselines } from '../lib/baselines.mjs';
import { MARKER, MAX_CHARS, renderTable } from './table.mjs';

const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const COLUMNS = [
  { label: 'Light', file: ['light-{state}.png'] },
  { label: 'Dark', file: ['dark-{state}.png'], width: 220 },
];

// File names come from the PR: anything a path segment may hold.
const name = fc.oneof(
  fc
    .tuple(fc.constantFrom('light-', 'dark-', 'other-'), fc.string({ minLength: 1, maxLength: 80 }))
    .map(([a, b]) => `${a}${b.replaceAll('/', '_')}.png`),
  fc.string({ maxLength: 20 }),
);
const entry = fc.record({
  filename: name.map((n) => `shots/${n}`),
  status: fc.constantFrom('added', 'removed', 'modified', 'renamed'),
});

describe('renderTable, for any changed files', () => {
  it('has the marker once, links at the two SHAs, stays under the limit, and counts what it drops', () => {
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 600 }), (files) => {
        const changed = changedBaselines(files, { folders: ['shots'] });
        const { rows, unpaired } = pairBaselines(changed, COLUMNS);
        const body = renderTable({
          rows,
          unpaired,
          columns: COLUMNS,
          repo: 'o/r',
          base: BASE,
          head: HEAD,
        });
        if (changed.length === 0) {
          expect(body).toBe(null);
          return;
        }
        const text = /** @type {string} */ (body);
        expect(text.startsWith(`${MARKER}\n`)).toBe(true);
        expect(text.split(MARKER)).toHaveLength(2);
        expect(text.length).toBeLessThanOrEqual(MAX_CHARS);
        expect(text).not.toMatch(/@/);
        for (const [, sha] of text.matchAll(/raw\.githubusercontent\.com\/o\/r\/(\w+)\//g)) {
          expect([BASE, HEAD]).toContain(sha);
        }
        // Rows go in order, then links: what's shown plus what's counted is every baseline.
        const lines = text.split('\n');
        const shownRows = lines.filter((l) => l.startsWith('| <code>')).length;
        const shownLinks = lines.filter((l) => l.startsWith('- <a href=')).length;
        const inRows = rows
          .slice(0, shownRows)
          .reduce((n, r) => n + Object.keys(r.cells).length, 0);
        const left = /And (\d+) more changed baselines?: see Files changed\.$/.exec(text);
        expect(inRows + shownLinks + (left ? Number(left[1]) : 0)).toBe(changed.length);
        if (left) expect(Number(left[1])).toBeGreaterThan(0);
      }),
      { numRuns: 60 },
    );
  });
});
