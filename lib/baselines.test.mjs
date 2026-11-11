import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { changedBaselines, columnOf, fillPattern, pairBaselines, stateOf } from './baselines.mjs';

/**
 * An app's tracked baselines on its main, as committed beside this test
 * (`git ls-files` of its `visual-baselines.folders`: BoardGames at 7fb4c0e,
 * fog-and-frontier at 2d41396, sift at 2f0a653).
 *
 * @param {string} app
 */
function tracked(app) {
  return readFileSync(new URL(`./fixtures/baselines-${app}.txt`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean);
}

/**
 * Every baseline of an app, as a PR that rewrote them all would list them.
 *
 * @param {string} app
 * @param {string[]} folders
 */
const allChanged = (app, folders) =>
  changedBaselines(
    tracked(app).map((filename) => ({ filename, status: 'modified' })),
    { folders },
  );

/**
 * The rows with a picture in every one of these columns.
 *
 * @param {import('./baselines.mjs').Row[]} rows
 * @param {string[]} labels
 */
const whole = (rows, labels) => rows.filter((r) => labels.every((l) => r.cells[l]));

describe('changedBaselines', () => {
  const folders = ['e2e/*-snapshots', 'shots'];

  it('keeps PNGs under the folders, with their before and after', () => {
    expect(
      changedBaselines(
        [
          { filename: 'src/App.tsx', status: 'modified' },
          { filename: 'e2e/a-snapshots/notes.txt', status: 'added' },
          { filename: 'e2e/a-snapshots/x.png', status: 'modified' },
          { filename: 'e2e/a-snapshots/new.png', status: 'added' },
          { filename: 'e2e/a-snapshots/gone.png', status: 'removed' },
          {
            filename: 'e2e/a-snapshots/to.png',
            status: 'renamed',
            previous_filename: 'old/from.png',
          },
          {
            filename: 'e2e/a-snapshots/copy.PNG',
            status: 'copied',
            previous_filename: 'e2e/a-snapshots/x.png',
          },
          { filename: 'docs/shot.png', status: 'added' },
        ],
        { folders },
      ),
    ).toEqual([
      {
        before: null,
        after: 'e2e/a-snapshots/copy.PNG',
        status: 'copied',
        folder: 'e2e/a-snapshots',
      },
      {
        before: 'e2e/a-snapshots/gone.png',
        after: null,
        status: 'removed',
        folder: 'e2e/a-snapshots',
      },
      {
        before: null,
        after: 'e2e/a-snapshots/new.png',
        status: 'added',
        folder: 'e2e/a-snapshots',
      },
      {
        before: 'old/from.png',
        after: 'e2e/a-snapshots/to.png',
        status: 'renamed',
        folder: 'e2e/a-snapshots',
      },
      {
        before: 'e2e/a-snapshots/x.png',
        after: 'e2e/a-snapshots/x.png',
        status: 'modified',
        folder: 'e2e/a-snapshots',
      },
    ]);
  });

  it('counts a baseline moved out of the folders as removed', () => {
    expect(
      changedBaselines(
        [
          { filename: 'old/a.png', status: 'renamed', previous_filename: 'shots/a.png' },
          { filename: 'shots/b.png', status: 'renamed', previous_filename: 'shots/a.png' },
        ],
        { folders },
      ),
    ).toEqual([
      { before: 'shots/a.png', after: null, status: 'removed', folder: 'shots' },
      { before: 'shots/a.png', after: 'shots/b.png', status: 'renamed', folder: 'shots' },
    ]);
  });

  it('leaves out a file the API lists as unchanged', () => {
    expect(
      changedBaselines([{ filename: 'shots/a.png', status: 'unchanged' }], { folders }),
    ).toEqual([]);
  });

  it('orders by the folders setting, then by path', () => {
    const order = changedBaselines(
      [
        { filename: 'shots/a.png', status: 'modified' },
        { filename: 'e2e/z-snapshots/b.png', status: 'modified' },
        { filename: 'e2e/a-snapshots/c.png', status: 'modified' },
      ],
      { folders },
    ).map((c) => c.after);
    expect(order).toEqual(['e2e/a-snapshots/c.png', 'e2e/z-snapshots/b.png', 'shots/a.png']);
  });

  it('reads only folders from the settings it is handed', () => {
    const settings = { folders, columns: [], ratio: 0 };
    expect(changedBaselines([{ filename: 'shots/a.png', status: 'added' }], settings)).toHaveLength(
      1,
    );
  });
});

describe('stateOf and fillPattern', () => {
  it('match anchored at both ends', () => {
    expect(stateOf('{state}-visual-webkit-linux.png', 'home-visual-webkit-linux.png')).toBe('home');
    expect(stateOf('{state}-visual-webkit-linux.png', 'home-visual-phone-webkit-linux.png')).toBe(
      null,
    );
    expect(stateOf('light-{state}.png', 'dark-01-setup.png')).toBe(null);
    expect(stateOf('light-{state}.png', 'light-.png')).toBe(null);
    expect(stateOf('a.{state}.png', 'aX1.png')).toBe(null);
    expect(fillPattern('light-{state}.png', '01-setup')).toBe('light-01-setup.png');
    expect(fillPattern('{state}.png', '$&')).toBe('$&.png');
  });

  it('takes the first column, and its first pattern, that matches', () => {
    const columns = [
      { label: 'Phone', file: ['{state}-mobile-mobile-linux.png', '{state}-mobile-linux.png'] },
      { label: 'Any', file: ['{state}.png'] },
    ];
    expect(columnOf('curated-mobile-mobile-linux.png', columns)).toEqual({
      label: 'Phone',
      state: 'curated',
    });
    expect(columnOf('trips-list-mobile-linux.png', columns)).toEqual({
      label: 'Phone',
      state: 'trips-list',
    });
    expect(columnOf('x-desktop-linux.png', columns)).toEqual({
      label: 'Any',
      state: 'x-desktop-linux',
    });
    expect(columnOf('x-desktop-linux.png', columns.slice(0, 1))).toBe(null);
  });
});

describe('pairBaselines', () => {
  const columns = [
    { label: 'Phone', file: ['{state}-phone.png'] },
    { label: 'Desktop', file: ['{state}-desktop.png'] },
  ];

  it('pairs a state across folders, and lists what no column takes', () => {
    const changed = changedBaselines(
      [
        { filename: 'e2e/full-snapshots/home-desktop.png', status: 'modified' },
        { filename: 'e2e/phone-snapshots/home-phone.png', status: 'modified' },
        { filename: 'e2e/phone-snapshots/menu-phone.png', status: 'added' },
        { filename: 'e2e/full-snapshots/home-firefox.png', status: 'modified' },
      ],
      { folders: ['e2e/*-snapshots'] },
    );
    const { rows, unpaired } = pairBaselines(changed, columns);
    expect(rows.map((r) => [r.state, r.folder, Object.keys(r.cells)])).toEqual([
      ['home', undefined, ['Phone', 'Desktop']],
      ['menu', undefined, ['Phone']],
    ]);
    expect(rows[1].cells.Phone).toEqual({
      before: null,
      after: 'e2e/phone-snapshots/menu-phone.png',
      status: 'added',
      folder: 'e2e/phone-snapshots',
    });
    expect(unpaired.map((c) => c.after)).toEqual(['e2e/full-snapshots/home-firefox.png']);
  });

  it('makes a row per folder when one column and state is in two, in folders order', () => {
    const changed = changedBaselines(
      [
        { filename: 'b/home-phone.png', status: 'modified' },
        { filename: 'a/home-phone.png', status: 'modified' },
        { filename: 'a/home-desktop.png', status: 'removed' },
      ],
      { folders: ['b', 'a'] },
    );
    const { rows } = pairBaselines(changed, columns);
    expect(rows.map((r) => [r.state, r.folder, Object.keys(r.cells)])).toEqual([
      ['home', 'b', ['Phone']],
      ['home', 'a', ['Phone', 'Desktop']],
    ]);
    expect(rows[1].cells.Desktop.after).toBe(null);
  });

  it('lists apart a second name in one folder on the same column and state', () => {
    const changed = changedBaselines(
      [
        { filename: 's/curated-mobile-mobile-linux.png', status: 'modified' },
        { filename: 's/curated-mobile-linux.png', status: 'added' },
      ],
      { folders: ['s'] },
    );
    const { rows, unpaired } = pairBaselines(changed, [
      { label: 'Phone', file: ['{state}-mobile-mobile-linux.png', '{state}-mobile-linux.png'] },
    ]);
    expect(rows.map((r) => [r.state, r.cells.Phone.after])).toEqual([
      ['curated', 's/curated-mobile-linux.png'],
    ]);
    expect(unpaired.map((c) => c.after)).toEqual(['s/curated-mobile-mobile-linux.png']);
  });

  it('pairs nothing without columns', () => {
    const changed = changedBaselines([{ filename: 'a/x-phone.png', status: 'added' }], {
      folders: ['a'],
    });
    expect(pairBaselines(changed, [])).toEqual({ rows: [], unpaired: changed });
  });
});

describe("the apps' baselines on their main", () => {
  it('BoardGames: phone and desktop pair across snapshot folders', () => {
    const changed = allChanged('BoardGames', ['e2e/*-snapshots']);
    const { rows, unpaired } = pairBaselines(changed, [
      { label: 'Phone', file: ['{state}-visual-phone-webkit-linux.png'] },
      { label: 'Desktop', file: ['{state}-visual-webkit-linux.png'] },
    ]);
    expect(rows).toHaveLength(60);
    expect(whole(rows, ['Phone', 'Desktop'])).toHaveLength(12);
    expect(rows.filter((r) => !r.cells.Desktop).map((r) => r.state)).toEqual([
      'filter-sheet-light',
    ]);
    expect(unpaired).toEqual([]);
    expect(rows.some((r) => r.folder)).toBe(false);
    const signIn = rows.find((r) => r.state === 'sign-in-light');
    expect(signIn?.cells.Phone.after).toBe(
      'e2e/visual-phone.spec.ts-snapshots/sign-in-light-visual-phone-webkit-linux.png',
    );
    expect(signIn?.cells.Desktop.after).toBe(
      'e2e/visual-full.spec.ts-snapshots/sign-in-light-visual-webkit-linux.png',
    );
  });

  it('fog-and-frontier: the ordered phone patterns pair every desktop state', () => {
    const changed = allChanged('fog-and-frontier', ['tests/visual/*-snapshots']);
    const { rows, unpaired } = pairBaselines(changed, [
      { label: 'Phone', file: ['{state}-mobile-mobile-linux.png', '{state}-mobile-linux.png'] },
      { label: 'Desktop', file: ['{state}-desktop-linux.png'] },
    ]);
    expect(whole(rows, ['Phone', 'Desktop']).map((r) => r.state)).toEqual([
      'activity-permalink',
      'curated',
      'explore-empty',
      'trip-planning',
      'trip-voting',
      'trips-list',
      'trips-new',
    ]);
    expect(rows.filter((r) => !r.cells.Desktop).map((r) => r.state)).toEqual([
      'activity-detail',
      'activity-detail-photos',
      'activity-not-found',
      'add-activity-form',
      'add-activity-review',
      'curated-mobile-filter-sheet',
      'curated-mobile-filters-on',
      'map',
      'map-sheet-half',
    ]);
    expect(unpaired).toEqual([]);
    // One pattern alone pairs fewer.
    const single = pairBaselines(changed, [
      { label: 'Phone', file: ['{state}-mobile-linux.png'] },
      { label: 'Desktop', file: ['{state}-desktop-linux.png'] },
    ]);
    expect(whole(single.rows, ['Phone', 'Desktop'])).toHaveLength(4);
  });

  it('sift: light and dark pair all seven screens', () => {
    const { rows, unpaired } = pairBaselines(allChanged('sift', ['e2e/screenshots/baselines']), [
      { label: 'Light', file: ['light-{state}.png'] },
      { label: 'Dark', file: ['dark-{state}.png'] },
    ]);
    expect(whole(rows, ['Light', 'Dark'])).toHaveLength(7);
    expect(rows[0].state).toBe('01-setup');
    expect(unpaired).toEqual([]);
  });
});
