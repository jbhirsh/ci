import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { testPng as png } from '../lib/test-pixels.mjs';
import { cli, selftest } from './selftest.mjs';

/**
 * A git checkout holding these files, with two commits.
 *
 * @param {Record<string, string | Buffer>} files
 */
function app(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'readme-app-'));
  const write = (/** @type {string} */ file, /** @type {string | Buffer} */ text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  write('package.json', '{}');
  for (const [file, text] of Object.entries(files)) write(file, text);
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
    const lines = await selftest(app(SHOTS));
    expect(lines[0]).toBe('readme-screenshots: 2 screenshots in docs/screenshots.');
    expect(lines[1]).toMatch(
      /^readme-screenshots: over the last 1 commits: what they show changed since \w{7}\.$/,
    );
    expect(lines[2]).toBe('readme-screenshots: compared 2 screenshots with pixelmatch.');
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
      "a screenshot pngjs can't read",
      { ...SHOTS, 'docs/screenshots/c.png': 'not a png' },
      'docs/screenshots/c.png is not a PNG pngjs reads',
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
