import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, selftest } from './selftest.mjs';

/** A fake "PNG" the stand-in pngjs below reads. */
const png = (/** @type {number} */ w, /** @type {number} */ h) =>
  JSON.stringify({ w, h, px: Array.from({ length: w * h }, () => 0) });

/**
 * A git checkout holding these files, with two commits, and (when asked)
 * stand-ins for pixelmatch and pngjs installed.
 *
 * @param {Record<string, string>} files
 * @param {{ pixels?: boolean }} [options]
 */
function app(files, { pixels = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'readme-app-'));
  const write = (/** @type {string} */ file, /** @type {string} */ text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  write('package.json', '{}');
  write('.gitignore', 'node_modules\n');
  for (const [file, text] of Object.entries(files)) write(file, text);
  if (pixels) {
    for (const [name, code] of Object.entries({
      pngjs:
        'export const PNG = { sync: { read: (b) => { const { w, h, px } = JSON.parse(b.toString()); return { width: w, height: h, data: Uint8Array.from(px) }; } } };',
      pixelmatch: 'export default (a, b) => a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0);',
    })) {
      write(
        `node_modules/${name}/package.json`,
        JSON.stringify({ name, type: 'module', main: 'index.js' }),
      );
      write(`node_modules/${name}/index.js`, code);
    }
  }
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@b.c', ...args], { cwd: root });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  git('add', '.');
  git('commit', '-q', '-m', 'second');
  return root;
}

const SHOTS = {
  'docs/screenshots/a.png': png(2, 2),
  'docs/screenshots/b.png': png(3, 2),
  'src/App.tsx': '',
};

describe('selftest', () => {
  it('runs decide over the history and compares each screenshot', async () => {
    const lines = await selftest(app(SHOTS, { pixels: true }));
    expect(lines[0]).toBe('readme-screenshots: 2 screenshots in docs/screenshots.');
    expect(lines[1]).toMatch(
      /^readme-screenshots: over the last 1 commits: what they show changed since \w{7}\.$/,
    );
    expect(lines[2]).toBe("readme-screenshots: compared 2 screenshots with the app's pixelmatch.");
  });

  it('skips the comparison for an app that neither installs it nor has settings', async () => {
    expect((await selftest(app(SHOTS))).at(-1)).toBe(
      'readme-screenshots: no pixelmatch and pngjs installed yet; comparison skipped.',
    );
  });

  it('fails an app that has settings but no pixelmatch', async () => {
    const root = app({ ...SHOTS, '.github/ci.json': '{"readme-screenshots":{"source":"x"}}' });
    await expect(selftest(root)).rejects.toThrow('installs no pixelmatch and pngjs');
  });

  it.each([
    ['no screenshots folder', { 'src/App.tsx': '' }, 'no docs/screenshots'],
    ['no PNGs', { 'docs/screenshots/x.txt': '', 'src/App.tsx': '' }, 'no PNGs in docs/screenshots'],
    [
      'a name it cannot write',
      { 'docs/screenshots/a b.png': png(1, 1) },
      "names the bot can't write",
    ],
    [
      'a shows glob that names nothing',
      { ...SHOTS, '.github/ci.json': '{"readme-screenshots":{"shows":["gone/**"]}}' },
      'shows names no tracked file: gone/**',
    ],
  ])('fails %s', async (_, files, error) => {
    await expect(selftest(app(files))).rejects.toThrow(error);
  });
});

describe('cli', () => {
  it('prints the self-test and returns its exit code', async () => {
    const lines = /** @type {string[]} */ ([]);
    expect(await cli([app(SHOTS)], (l) => lines.push(l))).toBe(0);
    expect(await cli([app({ 'src/App.tsx': '' })], (l) => lines.push(l))).toBe(1);
    expect(lines.at(-1)).toBe(
      'readme-screenshots self-test failed: readme-screenshots.dir: no docs/screenshots',
    );
  });
});
