import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PIXELS as pixels } from '../lib/pixels.mjs';
import { testPng } from '../lib/test-pixels.mjs';
import { compareShots, isShotPath, MAX_SHOT_BYTES, shotsIn } from './compare.mjs';

/**
 * A folder tree holding these files.
 *
 * @param {Record<string, string | Buffer>} files
 */
function tree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'shots-'));
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), bytes);
  }
  return dir;
}

describe('isShotPath', () => {
  it('takes plain nested PNG paths and nothing else', () => {
    expect(isShotPath('pages.spec.ts-snapshots/home-mobile-linux.png')).toBe(true);
    expect(isShotPath('light-01-setup.png')).toBe(true);
    for (const bad of ['a.jpg', '../a.png', 'a/../b.png', './a.png', 'a b.png', 'a/.png/..', '']) {
      expect(isShotPath(bad)).toBe(false);
    }
  });
});

describe('shotsIn', () => {
  it('lists the PNGs in a tree, sorted, and skips other files', () => {
    const dir = tree({ 'b/x.png': 'x', 'a.png': 'a', 'notes.txt': 'n' });
    expect(shotsIn(dir)).toEqual(['a.png', 'b/x.png']);
  });

  it('refuses an odd name and a link', () => {
    expect(() => shotsIn(tree({ 'a b.png': 'x' }))).toThrow(/not a screenshot's name/);
    const dir = tree({ 'a.png': 'x' });
    symlinkSync(path.join(dir, 'a.png'), path.join(dir, 'link.png'));
    expect(() => shotsIn(dir)).toThrow(/not a plain file/);
  });
});

describe('compareShots', () => {
  it('finds nothing when both trees match', () => {
    const shots = { 'f/a.png': testPng(), 'b.png': testPng(4, 4) };
    expect(compareShots({ before: tree(shots), after: tree(shots), ratio: 0, pixels })).toEqual([]);
  });

  it('finds changed, new and gone shots, with the diff and the after hash', () => {
    const before = tree({ 'same.png': testPng(), 'changed.png': testPng(), 'gone.png': testPng() });
    const after = tree({
      'same.png': testPng(),
      'changed.png': testPng(10, 10, 5),
      'new.png': testPng(),
    });
    const changes = compareShots({ before, after, ratio: 0, pixels });
    expect(changes.map((c) => [c.file, c.kind])).toEqual([
      ['changed.png', 'changed'],
      ['gone.png', 'removed'],
      ['new.png', 'added'],
    ]);
    expect(changes[0].ratio).toBeCloseTo(0.05);
    expect(changes[0].diff).toBeInstanceOf(Buffer);
    expect(changes[0].after).toMatch(/^[0-9a-f]{64}$/);
    expect(changes[1].after).toBe('');
  });

  it('lets a change within the ratio pass, and counts a new size as a change', () => {
    const before = tree({ 'a.png': testPng(), 'b.png': testPng() });
    const after = tree({ 'a.png': testPng(10, 10, 5), 'b.png': testPng(8, 8) });
    const changes = compareShots({ before, after, ratio: 0.1, pixels });
    expect(changes).toEqual([
      expect.objectContaining({ file: 'b.png', kind: 'changed', ratio: 1 }),
    ]);
  });

  it('says where a change under `minor` is, and only for one', () => {
    const before = tree({ 'small.png': testPng(100, 100), 'big.png': testPng(100, 100) });
    const after = tree({ 'small.png': testPng(100, 100, 3), 'big.png': testPng(100, 100, 500) });
    const [big, small] = compareShots({ before, after, ratio: 0, minor: 0.01, pixels });
    expect(big.look).toBeUndefined();
    expect(small.look).toMatchObject({ large: false, width: 100, height: 100 });
    expect(small.look?.places).toEqual([{ x: 0, y: 0, w: 3, h: 1 }]);
  });

  it('marks a resized shot, which has no look', () => {
    const [c] = compareShots({
      before: tree({ 'a.png': testPng() }),
      after: tree({ 'a.png': testPng(8, 8) }),
      ratio: 0,
      pixels,
    });
    expect(c).toMatchObject({ ratio: 1, resized: true });
    expect(c.look).toBeUndefined();
  });

  it('refuses a shot that is not a PNG', () => {
    expect(() =>
      compareShots({ before: tree({}), after: tree({ 'a.png': 'not a png' }), ratio: 0, pixels }),
    ).toThrow(/not a PNG/);
  });

  it('refuses a shot over 10 MB', () => {
    const big = Buffer.alloc(MAX_SHOT_BYTES + 1);
    expect(() =>
      compareShots({ before: tree({}), after: tree({ 'a.png': big }), ratio: 0, pixels }),
    ).toThrow(/over 10 MB/);
  });
});
