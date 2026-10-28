// A throwaway app checkout for the tests: these files committed on branch
// `topic`, with a bare remote to push to. Not part of the tool.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A checkout holding these files, committed, with a bare remote to push to.
 *
 * @param {Record<string, string>} files
 */
export function repo(files) {
  const base = mkdtempSync(path.join(tmpdir(), 'baselines-'));
  const remote = path.join(base, 'remote.git');
  const root = path.join(base, 'app');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  mkdirSync(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@b.c', ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  git('init', '-q', '-b', 'topic');
  git('remote', 'add', 'origin', remote);
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('push', '-q', 'origin', 'topic');
  return { root, remote, git };
}

/**
 * Stand-ins for pixelmatch and pngjs in the app's node_modules: a "PNG" is
 * JSON `{w, h, px}`, and pixelmatch counts the positions where two differ.
 *
 * @param {string} root
 */
export function withPixels(root) {
  for (const [name, code] of Object.entries({
    pngjs:
      'export const PNG = { sync: { read: (b) => { const { w, h, px } = JSON.parse(b.toString()); return { width: w, height: h, data: Uint8Array.from(px) }; }, write: (i) => Buffer.from(JSON.stringify({ w: i.width, h: i.height, px: [...i.data] })) } };',
    pixelmatch: 'export default (a, b) => a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0);',
  })) {
    const dir = path.join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, type: 'module', main: 'index.js' }),
    );
    writeFileSync(path.join(dir, 'index.js'), code);
  }
  writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

/** A fake PNG `width`×`height` for withPixels, its first `marked` pixels set. */
export function fakePng(width = 10, height = 10, marked = 0) {
  return JSON.stringify({
    w: width,
    h: height,
    px: Array.from({ length: width * height }, (_, i) => (i < marked ? 1 : 0)),
  });
}
