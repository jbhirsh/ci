import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePixels as pixels, fakePng as png, testPng } from '../lib/test-pixels.mjs';
import { compare, diffRatio, main, shouldReplace } from './compare.mjs';

// Outputs print instead of reaching the real job's, should these run in Actions.
beforeEach(() => {
  vi.stubEnv('GITHUB_OUTPUT', '');
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return () => vi.restoreAllMocks();
});

const temp = () => mkdtempSync(path.join(tmpdir(), 'shots-'));

describe('diffRatio', () => {
  it('is the share of pixels that changed', () => {
    expect(diffRatio(png(), png(), pixels)).toBe(0);
    expect(diffRatio(png(), png(10, 10, 25), pixels)).toBe(0.25);
  });

  it('counts a different size, or an empty image, as a whole change', () => {
    expect(diffRatio(png(10, 10), png(10, 20), pixels)).toBe(1);
    expect(diffRatio(png(10, 10), png(20, 10), pixels)).toBe(1);
    expect(diffRatio(png(0, 0), png(0, 0), pixels)).toBe(1);
  });
});

describe('shouldReplace', () => {
  it('writes a screenshot that has no file yet', () => {
    expect(shouldReplace(undefined, png(), pixels)).toBe(true);
  });

  it('keeps the file through changes up to 0.5%, and replaces it past', () => {
    // 1000 pixels: 5 is exactly 0.5%, 6 is over.
    expect(shouldReplace(png(100, 10), png(100, 10, 5), pixels)).toBe(false);
    expect(shouldReplace(png(100, 10), png(100, 10, 6), pixels)).toBe(true);
  });
});

describe('compare', () => {
  it('copies only the new and changed shots, sorted, leaving the README alone', () => {
    const fresh = temp();
    const docs = temp();
    const out = path.join(temp(), 'out');
    writeFileSync(path.join(fresh, 'same.png'), png(100, 10, 5));
    writeFileSync(path.join(docs, 'same.png'), png(100, 10));
    writeFileSync(path.join(fresh, 'moved.png'), png(100, 10, 50));
    writeFileSync(path.join(docs, 'moved.png'), png(100, 10));
    writeFileSync(path.join(fresh, 'added.png'), png());
    writeFileSync(path.join(fresh, 'notes.txt'), 'not a shot');
    expect(compare({ fresh, docs, out, pixels })).toEqual(['added.png', 'moved.png']);
    expect(readdirSync(out).sort()).toEqual(['added.png', 'moved.png']);
    expect(existsSync(path.join(docs, 'added.png'))).toBe(false);
  });

  it('refuses a name the bot may not write', () => {
    const fresh = temp();
    writeFileSync(path.join(fresh, '.sneaky.png'), png());
    expect(() => compare({ fresh, docs: temp(), out: temp(), pixels })).toThrow(
      'not a screenshot name: .sneaky.png',
    );
  });
});

describe('main', () => {
  it("compares with the app's screenshots folder and lists the replacements", async () => {
    const root = temp();
    mkdirSync(path.join(root, '.github'));
    writeFileSync(path.join(root, '.github', 'ci.json'), '{"readme-screenshots":{"dir":"img"}}');
    mkdirSync(path.join(root, 'img'));
    writeFileSync(path.join(root, 'img', 'a.png'), testPng());
    const fresh = temp();
    writeFileSync(path.join(fresh, 'a.png'), testPng(10, 10, 50));
    const out = path.join(temp(), 'out');
    expect(await main([fresh, out], root)).toEqual(['a.png']);
  });

  it('needs both folders', async () => {
    await expect(main(['x'], temp())).rejects.toThrow('usage');
  });
});
