import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { columnOf, pairBaselines, stateOf } from './baselines.ts';
import type { Changed, Row } from './baselines.ts';

/**
 * An app's committed baselines, as they were when visual review replaced
 * them, beside this test (`git ls-files` of their folders: BoardGames at
 * 7fb4c0e, fog-and-frontier at 2d41396, sift at 2f0a653): realistic names
 * for the columns to pair.
 */
function tracked(app: string) {
  return readFileSync(new URL(`./fixtures/baselines-${app}.txt`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean);
}

/**
 * A shot as a changed entry, in its own folder.
 */
const change = (filename: string, status = 'modified'): Changed => ({
  before: status === 'added' ? null : filename,
  after: status === 'removed' ? null : filename,
  status,
  folder: path.posix.dirname(filename),
});

/**
 * Every shot of an app, as a PR that rewrote them all would list them.
 */
const allChanged = (app: string) => tracked(app).map((filename) => change(filename));

/**
 * The rows with a picture in every one of these columns.
 */
const whole = (rows: Row[], labels: string[]) =>
  rows.filter((r) => labels.every((l) => r.cells[l]));

describe('stateOf', () => {
  it('matches anchored at both ends', () => {
    expect(stateOf('{state}-visual-webkit-linux.png', 'home-visual-webkit-linux.png')).toBe('home');
    expect(stateOf('{state}-visual-webkit-linux.png', 'home-visual-phone-webkit-linux.png')).toBe(
      null,
    );
    expect(stateOf('light-{state}.png', 'dark-01-setup.png')).toBe(null);
    expect(stateOf('light-{state}.png', 'light-.png')).toBe(null);
    expect(stateOf('a.{state}.png', 'aX1.png')).toBe(null);
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
    const changed = [
      change('e2e/full-snapshots/home-desktop.png'),
      change('e2e/phone-snapshots/home-phone.png'),
      change('e2e/phone-snapshots/menu-phone.png', 'added'),
      change('e2e/full-snapshots/home-firefox.png'),
    ];
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
    const changed = [
      change('b/home-phone.png'),
      change('a/home-phone.png'),
      change('a/home-desktop.png', 'removed'),
    ];
    const { rows } = pairBaselines(changed, columns);
    expect(rows.map((r) => [r.state, r.folder, Object.keys(r.cells)])).toEqual([
      ['home', 'b', ['Phone']],
      ['home', 'a', ['Phone', 'Desktop']],
    ]);
    expect(rows[1].cells.Desktop.after).toBe(null);
  });

  it('lists apart a second name in one folder on the same column and state', () => {
    const changed = [
      change('s/curated-mobile-linux.png', 'added'),
      change('s/curated-mobile-mobile-linux.png'),
    ];
    const { rows, unpaired } = pairBaselines(changed, [
      { label: 'Phone', file: ['{state}-mobile-mobile-linux.png', '{state}-mobile-linux.png'] },
    ]);
    expect(rows.map((r) => [r.state, r.cells.Phone.after])).toEqual([
      ['curated', 's/curated-mobile-linux.png'],
    ]);
    expect(unpaired.map((c) => c.after)).toEqual(['s/curated-mobile-mobile-linux.png']);
  });

  it('pairs nothing without columns', () => {
    const changed = [change('a/x-phone.png', 'added')];
    expect(pairBaselines(changed, [])).toEqual({ rows: [], unpaired: changed });
  });
});

describe("the apps' shots, as they were committed", () => {
  it('BoardGames: phone and desktop pair across snapshot folders', () => {
    const changed = allChanged('BoardGames');
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
    const changed = allChanged('fog-and-frontier');
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
    const { rows, unpaired } = pairBaselines(allChanged('sift'), [
      { label: 'Light', file: ['light-{state}.png'] },
      { label: 'Dark', file: ['dark-{state}.png'] },
    ]);
    expect(whole(rows, ['Light', 'Dark'])).toHaveLength(7);
    expect(rows[0].state).toBe('01-setup');
    expect(unpaired).toEqual([]);
  });
});
