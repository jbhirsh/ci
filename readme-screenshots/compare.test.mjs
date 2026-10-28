import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appPixels, compare, diffRatio, main, shouldReplace } from './compare.mjs';

// Outputs print instead of reaching the real job's, should these run in Actions.
beforeEach(() => {
  vi.stubEnv('GITHUB_OUTPUT', '');
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return () => vi.restoreAllMocks();
});

/**
 * Fake pixels: a "PNG" is JSON `{w, h, px}`, and `match` counts the
 * positions where the two pixel lists differ.
 *
 * @type {import('./compare.mjs').Pixels}
 */
const pixels = {
  read: (png) => {
    const { w, h, px } = JSON.parse(png.toString());
    return { width: w, height: h, data: Uint8Array.from(px) };
  },
  write: (image) =>
    Buffer.from(JSON.stringify({ w: image.width, h: image.height, px: [...image.data] })),
  match: (a, b) => a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0),
};

/** A fake PNG `width`×`height`, its first `marked` pixels set. */
const png = (width = 10, height = 10, marked = 0) =>
  Buffer.from(
    JSON.stringify({
      w: width,
      h: height,
      px: Array.from({ length: width * height }, (_, i) => (i < marked ? 1 : 0)),
    }),
  );

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

/** A fake app whose node_modules hold stand-ins for pixelmatch and pngjs. */
function fakeApp() {
  const root = temp();
  writeFileSync(path.join(root, 'package.json'), '{}');
  const pkg = (/** @type {string} */ name, /** @type {string} */ code) => {
    mkdirSync(path.join(root, 'node_modules', name), { recursive: true });
    writeFileSync(
      path.join(root, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, type: 'module', main: 'index.js' }),
    );
    writeFileSync(path.join(root, 'node_modules', name, 'index.js'), code);
  };
  pkg(
    'pngjs',
    'export const PNG = { sync: { read: (b) => { const { w, h, px } = JSON.parse(b.toString()); return { width: w, height: h, data: Uint8Array.from(px) }; } } };',
  );
  pkg('pixelmatch', 'export default (a, b) => a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0);');
  return root;
}

describe('appPixels', () => {
  it("compares with the app's pixelmatch and pngjs", async () => {
    const real = await appPixels(fakeApp());
    expect(diffRatio(png(), png(10, 10, 10), real)).toBe(0.1);
  });
});

describe('main', () => {
  it("compares with the app's screenshots folder and lists the replacements", async () => {
    const root = fakeApp();
    mkdirSync(path.join(root, '.github'));
    writeFileSync(path.join(root, '.github', 'ci.json'), '{"readme-screenshots":{"dir":"img"}}');
    mkdirSync(path.join(root, 'img'));
    writeFileSync(path.join(root, 'img', 'a.png'), png());
    const fresh = temp();
    writeFileSync(path.join(fresh, 'a.png'), png(10, 10, 50));
    const out = path.join(temp(), 'out');
    expect(await main([fresh, out], root)).toEqual(['a.png']);
  });

  it('needs both folders', async () => {
    await expect(main(['x'], fakeApp())).rejects.toThrow('usage');
  });
});
