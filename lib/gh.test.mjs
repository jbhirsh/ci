import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_GH, checkGh, ghVersion } from './gh.mjs';

describe('ghVersion', () => {
  it("reads gh's first line", () => {
    expect(ghVersion('gh version 2.89.0 (2026-03-26)\nhttps://…')).toEqual([2, 89, 0]);
    expect(ghVersion('not gh')).toBe(null);
  });
});

describe('checkGh', () => {
  const at = (/** @type {string} */ v) => () => `gh version ${v} (2026-09-01)\n`;

  it.each(['2.99.0', '2.99.1', '2.103.2', '3.0.0'])('passes %s', (v) => {
    expect(() => checkGh(at(v))).not.toThrow();
  });

  it.each([
    ['2.89.0', 'yours is 2.89.0'],
    ['2.98.9', 'yours is 2.98.9'],
    ['1.200.0', 'yours is 1.200.0'],
  ])('refuses %s, saying what to install', (v, shows) => {
    expect(() => checkGh(at(v))).toThrow(
      `install gh ≥ 2.99, which can attach files to a PR (\`gh --version\` shows yours; ${shows})`,
    );
  });

  it('refuses a missing gh', () => {
    expect(() =>
      checkGh(() => {
        throw new Error('spawn gh ENOENT');
      }),
    ).toThrow('none found');
    expect(() => checkGh(() => '')).toThrow('none found');
  });

  it('names 2.99.0, the release that added --attach', () => {
    expect(MIN_GH).toBe('2.99.0');
  });
});

describe('checkGh, running gh', () => {
  /**
   * Runs checkGh with a fake gh first on PATH, printing this version (or no gh at all).
   *
   * @param {string | null} version
   */
  function withFakeGh(version) {
    const dir = mkdtempSync(path.join(tmpdir(), 'fake-gh-'));
    if (version) {
      const gh = path.join(dir, 'gh');
      writeFileSync(gh, `#!/bin/sh\necho "gh version ${version} (2026-09-01)"\n`);
      chmodSync(gh, 0o755);
    }
    const saved = process.env.PATH;
    process.env.PATH = version ? `${dir}${path.delimiter}${saved}` : dir;
    try {
      checkGh();
    } finally {
      process.env.PATH = saved;
    }
  }

  it('passes a gh at 2.99 and refuses an older one or none', () => {
    expect(() => withFakeGh('2.99.0')).not.toThrow();
    expect(() => withFakeGh('2.89.0')).toThrow('yours is 2.89.0');
    expect(() => withFakeGh(null)).toThrow('none found');
  });
});
