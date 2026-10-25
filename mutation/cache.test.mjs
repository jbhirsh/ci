import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheKeys, filesHash, main } from './cache.mjs';

/** @param {Record<string, string>} files */
function dir(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'cache-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return root;
}

afterEach(() => {
  delete process.env.GITHUB_OUTPUT;
  vi.restoreAllMocks();
});

describe('cacheKeys', () => {
  const base = { prefix: 'stryker-incremental', hash: '', runId: '7', attempt: '2' };

  it("keys a PR's run by its number, restoring its own results, then main's", () => {
    expect(cacheKeys({ ...base, pr: 12, restoreMain: true })).toEqual({
      key: 'stryker-incremental-pr-12-7-2',
      restoreKeys: ['stryker-incremental-pr-12-', 'stryker-incremental-main-'],
    });
  });

  it("restores only the PR's own results without restoreMain, and adds the hash", () => {
    expect(cacheKeys({ ...base, pr: 12, hash: 'abc', restoreMain: false })).toEqual({
      key: 'stryker-incremental-pr-12-abc-7-2',
      restoreKeys: ['stryker-incremental-pr-12-abc-'],
    });
  });

  it("keys main's runs as its baseline", () => {
    expect(cacheKeys({ ...base, pr: null, restoreMain: true })).toEqual({
      key: 'stryker-incremental-main-7-2',
      restoreKeys: ['stryker-incremental-main-'],
    });
  });
});

describe('filesHash', () => {
  it('is empty with no globs, and changes with a matched file', () => {
    const root = dir({ 'package-lock.json': '1', 'src/test/a.ts': 'a', 'src/b.ts': 'b' });
    expect(filesHash([], root)).toBe('');
    const before = filesHash(['package-lock.json', 'src/test/**'], root);
    expect(before).toMatch(/^[0-9a-f]{16}$/);
    writeFileSync(path.join(root, 'src/b.ts'), 'changed');
    expect(filesHash(['package-lock.json', 'src/test/**'], root)).toBe(before);
    writeFileSync(path.join(root, 'src/test/a.ts'), 'changed');
    expect(filesHash(['package-lock.json', 'src/test/**'], root)).not.toBe(before);
  });
});

describe('main', () => {
  /** @param {unknown} ci */
  const app = (ci) => dir({ '.github/ci.json': JSON.stringify(ci), lock: 'x' });

  it("writes this run's key and the restore keys", () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'cache-out-')), 'out');
    writeFileSync(out, '');
    process.env.GITHUB_OUTPUT = out;
    const env = { GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '1' };
    expect(main(['pr', '5'], app({ mutation: { cache: { restartOn: ['lock'] } } }), env)).toBe(0);
    expect(readFileSync(out, 'utf8')).toMatch(
      /key<<\w+\nstryker-incremental-pr-5-[0-9a-f]{16}-9-1\n[\s\S]*restore-keys<<\w+\nstryker-incremental-pr-5-[0-9a-f]{16}-\nstryker-incremental-main-\n/,
    );
    writeFileSync(out, '');
    expect(main(['main'], app({}), {})).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('\nstryker-incremental-main-local-1\n');
  });

  it('refuses anything but a PR number or main', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [[], ['pr'], ['pr', '0'], ['pr', 'x'], ['push']]) {
      expect(main(args, app({}), {})).toBe(2);
    }
    expect(error).toHaveBeenCalledWith('Usage: cache.mjs pr <number> | main');
  });
});
