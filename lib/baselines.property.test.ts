import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pairBaselines, stateOf } from './baselines.ts';

// File names come from a pull request: any segment a path may hold, biased
// toward the shapes baselines have.
const segment = fc.oneof(
  fc.stringMatching(/^[\w.{}$&()[\]+*?^|\\ -]{1,12}$/),
  fc.constantFrom('a-snapshots', 'b-snapshots', 'shots', 'src', 'x'),
);
const name = fc.oneof(
  fc
    .tuple(
      fc.stringMatching(/^[\w-]{1,10}$/),
      fc.constantFrom('-phone.png', '-desktop.png', '-firefox.png', '.png', '.txt'),
    )
    .map(([a, b]) => a + b),
  segment,
);
const filename = fc
  .tuple(fc.array(segment, { minLength: 0, maxLength: 3 }), name)
  .map(([dirs, base]) => [...dirs, base].join('/'));
const status = fc.constantFrom('added', 'removed', 'modified');
/** A changed shot: its paths follow its status, its folder is its directory. */
const entry = fc.tuple(filename, status).map(([file, st]) => ({
  before: st === 'added' ? null : file,
  after: st === 'removed' ? null : file,
  status: st,
  folder: file.split('/').slice(0, -1).join('/'),
}));
const pattern = fc
  .tuple(fc.stringMatching(/^[\w.$&()+-]{0,6}$/), fc.stringMatching(/^[\w.$&()+-]{0,10}$/))
  .map(([head, tail]) => `${head}{state}${tail}.png`);
const columns = fc
  .uniqueArray(fc.stringMatching(/^[A-Z][a-z]{0,6}$/), { minLength: 0, maxLength: 3 })
  .chain((labels) =>
    fc.tuple(
      ...labels.map((label) =>
        fc.array(pattern, { minLength: 1, maxLength: 3 }).map((file) => ({ label, file })),
      ),
    ),
  );
/** The name a pattern gives a state. */
const fill = (/** @type {string} */ p, /** @type {string} */ state) =>
  p.replace('{state}', () => state);

describe('pairing, for any changed files', () => {
  it('never throws, and puts every changed shot in one cell or in unpaired', () => {
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 30 }), columns, (changed, cols) => {
        const { rows, unpaired } = pairBaselines(changed, cols);
        const placed = [...rows.flatMap((r) => Object.values(r.cells)), ...unpaired];
        expect(placed).toHaveLength(changed.length);
        for (const c of changed) expect(placed.filter((p) => p === c)).toHaveLength(1);
        for (const row of rows) {
          expect(Object.keys(row.cells).length).toBeGreaterThan(0);
          const labels = cols.map((c) => c.label);
          expect(Object.keys(row.cells)).toEqual(labels.filter((l) => row.cells[l]));
        }
      }),
    );
  });

  it('moves a removed column’s shots to another column or to unpaired, and no others', () => {
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 30 }), columns, (changed, cols) => {
        fc.pre(cols.length > 0);
        const all = pairBaselines(changed, cols);
        const fewer = pairBaselines(changed, cols.slice(1));
        const inFirst = all.rows.flatMap((r) =>
          r.cells[cols[0].label] ? [r.cells[cols[0].label]] : [],
        );
        // What stayed unpaired stays so; the first column's files go elsewhere.
        for (const c of all.unpaired) expect(fewer.unpaired).toContain(c);
        for (const c of fewer.unpaired) expect([...all.unpaired, ...inFirst]).toContain(c);
        if (cols.length === 1) expect(fewer.unpaired).toHaveLength(changed.length);
      }),
    );
  });
});

describe('stateOf, for any pattern and name', () => {
  it('reads back the state a pattern was filled with', () => {
    fc.assert(
      fc.property(pattern, fc.stringMatching(/^[^/]{1,20}$/), (p, state) => {
        expect(stateOf(p, fill(p, state))).toBe(state);
      }),
    );
  });

  it('gives a state only for a name it fills back to', () => {
    fc.assert(
      fc.property(pattern, name, (p, base) => {
        const state = stateOf(p, base);
        if (state !== null) {
          expect(state.length).toBeGreaterThan(0);
          expect(state.includes('/')).toBe(false);
          expect(fill(p, state)).toBe(base);
        }
      }),
    );
  });
});
