import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOLS, findSelftests } from './selftests.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** @type {string[]} */
const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A checkout holding these files (empty), and lib/selftests.ts itself.
 *
 * @param {string[]} files
 */
function checkout(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'selftests-'));
  made.push(dir);
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), '');
  }
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  copyFileSync(path.join(root, 'lib', 'selftests.ts'), path.join(dir, 'lib', 'selftests.ts'));
  return dir;
}

describe('findSelftests', () => {
  it("finds every listed tool's self-test in this repo, and nothing unlisted", () => {
    const { files, problems } = findSelftests(root);
    expect(problems).toEqual([]);
    expect(files).toHaveLength(TOOLS.length);
    expect(files).toContain('sync/selftest.ts');
  });

  it('takes either extension', () => {
    const dir = checkout(['a/selftest.mjs', 'b/selftest.ts']);
    expect(findSelftests(dir, ['a', 'b'])).toEqual({
      files: ['a/selftest.mjs', 'b/selftest.ts'],
      problems: [],
    });
  });

  it('names a listed tool with no self-test, or both, and one the list misses', () => {
    const dir = checkout([
      'a/selftest.mjs',
      'a/selftest.ts',
      'b/selftest.test.mjs',
      'c/selftest.mjs',
      'd/selftest.mts',
      'a/sub/selftest.ts',
      'selftest.mjs',
      '.hidden/selftest.mjs',
      'node_modules/x/selftest.mjs',
    ]);
    const { files, problems } = findSelftests(dir, ['a', 'b']);
    expect(files).toEqual(['a/selftest.mjs', 'a/selftest.ts']);
    expect(problems).toEqual([
      'a: both a/selftest.mjs and a/selftest.ts: keep one',
      'b: no selftest.mjs or selftest.ts, so CI would run no self-test for it: restore it, or take b out of TOOLS in lib/selftests.ts',
      "a/sub/selftest.ts: CI runs only a tool's own <tool>/selftest.mjs or .ts: move it there",
      'c/selftest.mjs: c is not in TOOLS in lib/selftests.ts: add it, so CI runs it',
      'd/selftest.mts: CI runs only selftest.mjs or selftest.ts: rename it',
    ]);
  });
});

describe('the command line, as CI runs it', () => {
  /** @param {string} dir */
  const run = (dir) =>
    spawnSync(process.execPath, [path.join(dir, 'lib', 'selftests.ts')], { encoding: 'utf8' });

  it('prints the self-tests to run', () => {
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(findSelftests(root).files);
  });

  it('fails, printing nothing to run, when a listed self-test is missing', () => {
    // Every tool's self-test but sync's, as after a rename the list missed.
    const dir = checkout(TOOLS.filter((t) => t !== 'sync').map((t) => `${t}/selftest.mjs`));
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^selftests: sync: no selftest\.mjs or selftest\.ts/);
  });
});
