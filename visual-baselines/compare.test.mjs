import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appPixels } from '../lib/pixels.mjs';
import { compare, main, report } from './compare.mjs';
import { fakePng, withPixels } from './test-repo.mjs';

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const temp = () => mkdtempSync(path.join(tmpdir(), 'compare-'));

/**
 * A folder holding these fake PNGs.
 *
 * @param {Record<string, string>} files
 */
function folder(files) {
  const dir = temp();
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

describe('compare', async () => {
  const pixels = await appPixels(withPixels(temp()));

  it('passes screenshots that match their baselines', () => {
    const out = temp();
    const shots = { 'a.png': fakePng(), 'b.png': fakePng(4, 4) };
    expect(
      compare({ fresh: folder(shots), baselines: folder(shots), out, ratio: 0, pixels }),
    ).toEqual({ changed: [], added: [], missing: [] });
    expect(readdirSync(out)).toEqual([]);
  });

  it('finds changed, new and missing screenshots, and keeps them for upload', () => {
    const out = temp();
    const result = compare({
      fresh: folder({
        'a.png': fakePng(10, 10, 5),
        'b.png': fakePng(10, 20),
        'new.png': fakePng(),
      }),
      baselines: folder({ 'a.png': fakePng(), 'b.png': fakePng(), 'gone.png': fakePng() }),
      out,
      ratio: 0,
      pixels,
    });
    expect(result).toEqual({
      changed: [
        { name: 'a.png', ratio: 0.05 },
        { name: 'b.png', ratio: 1, resized: true },
      ],
      added: ['new.png'],
      missing: ['gone.png'],
    });
    expect(readdirSync(out).sort()).toEqual([
      'a.actual.png',
      'a.diff.png',
      'b.actual.png',
      'new.actual.png',
    ]);
  });

  it('lets through a difference within the ratio', () => {
    const result = compare({
      fresh: folder({ 'a.png': fakePng(10, 10, 5) }),
      baselines: folder({ 'a.png': fakePng() }),
      out: temp(),
      ratio: 0.05,
      pixels,
    });
    expect(result.changed).toEqual([]);
  });

  it('refuses a name that is not a screenshot', () => {
    expect(() =>
      compare({
        fresh: folder({ 'a b.png': '' }),
        baselines: temp(),
        out: temp(),
        ratio: 0,
        pixels,
      }),
    ).toThrow(/not a screenshot name: a b.png/);
  });
});

describe('report', () => {
  it('is empty when everything matched', () => {
    expect(report({ changed: [], added: [], missing: [] }, 0)).toBe('');
  });

  it('lists each problem and how to fix an intended change', () => {
    const text = report(
      {
        changed: [
          { name: 'a.png', ratio: 0.0123 },
          { name: 'b.png', ratio: 1, resized: true },
          { name: 'c.png', ratio: 1 },
          { name: 'd.png', ratio: 0.000001 },
        ],
        added: ['n.png'],
        missing: ['g.png'],
      },
      0.001,
    );
    expect(text).toContain('`a.png` changed: 1.230% of its pixels');
    expect(text).toContain('`c.png` changed: 100.000% of its pixels');
    expect(text).toContain('`d.png` changed: <0.001% of its pixels');
    expect(text).toContain('`b.png` changed: a different size');
    expect(text).toContain('`n.png` is new: it has no baseline');
    expect(text).toContain("`g.png` wasn't taken");
    expect(text).toContain('Allowed: 0.100%');
    expect(text).toContain('run visual-baselines.yml on this branch');
  });
});

describe('main', () => {
  /** An app whose baselines folder holds a.png. */
  function app(/** @type {Record<string, unknown>} */ config) {
    const root = withPixels(temp());
    mkdirSync(path.join(root, '.github'));
    writeFileSync(
      path.join(root, '.github/ci.json'),
      JSON.stringify({ 'visual-baselines': config }),
    );
    mkdirSync(path.join(root, 'shots'));
    writeFileSync(path.join(root, 'shots/a.png'), fakePng());
    return root;
  }

  it('compares with the folder the settings name and reports', async () => {
    const root = app({ folders: ['shots'], artifact: { workflow: 'ci.yml', name: 'x' } });
    const out = path.join(temp(), 'out');
    expect((await main([folder({ 'a.png': fakePng() }), out], root)).text).toBe('');
    const changed = await main([folder({ 'a.png': fakePng(10, 10, 1) }), out], root);
    expect(changed.text).toContain('`a.png` changed');
    expect(existsSync(path.join(out, 'a.diff.png'))).toBe(true);
  });

  it('needs both folders', async () => {
    await expect(main(['x'], temp())).rejects.toThrow(/usage/);
  });
});
