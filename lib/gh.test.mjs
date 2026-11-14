import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_GH, checkGh, commandIn, ghIn, ghVersion, main } from './gh.mjs';

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

describe('commandIn and ghIn', () => {
  it('run in the folder given, and throw on a failure unless allowed', () => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'lib-gh-cwd-')));
    expect(commandIn('pwd', cwd)([]).stdout).toBe(`${cwd}\n`);
    expect(commandIn('sh', cwd)(['-c', 'echo nope >&2; exit 3'], { allowFail: true })).toEqual({
      status: 3,
      stdout: '',
      stderr: 'nope\n',
    });
    expect(() => commandIn('sh', cwd)(['-c', 'echo nope >&2; exit 3'])).toThrow(
      'sh -c failed: nope',
    );
  });

  it('runs gh in the given directory', () => {
    // A fake gh first on PATH: it prints where it ran, and fails on "fail".
    const bin = mkdtempSync(path.join(tmpdir(), 'lib-gh-bin-'));
    const fake = path.join(bin, 'gh');
    writeFileSync(fake, '#!/bin/sh\n[ "$1" = fail ] && { echo nope >&2; exit 1; }\npwd\n');
    chmodSync(fake, 0o755);
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'lib-gh-cwd-')));
    const saved = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${saved}`;
    try {
      expect(ghIn(cwd)(['pr', 'view'])).toEqual({ status: 0, stdout: `${cwd}\n`, stderr: '' });
      expect(ghIn(cwd)(['fail'], { allowFail: true })).toEqual({
        status: 1,
        stdout: '',
        stderr: 'nope\n',
      });
      expect(() => ghIn(cwd)(['fail'])).toThrow('gh fail failed: nope');
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('main, the command line', () => {
  const at = (/** @type {string} */ v) => () => `gh version ${v} (2026-09-01)\n`;

  it('exits 0 for a gh that can attach, and 1 saying what to install', () => {
    /** @type {string[]} */
    const errors = [];
    const error = (/** @type {string} */ line) => errors.push(line);
    expect(main(['check'], { version: at('2.99.0'), error })).toBe(0);
    expect(main(['check'], { version: at('2.89.0'), error })).toBe(1);
    expect(errors).toEqual([
      'install gh ≥ 2.99, which can attach files to a PR (`gh --version` shows yours; yours is 2.89.0)',
    ]);
  });

  it('says how to call it', () => {
    /** @type {string[]} */
    const errors = [];
    expect(main([], { error: (l) => errors.push(l) })).toBe(2);
    expect(main(['check', 'x'], { error: (l) => errors.push(l) })).toBe(2);
    expect(errors).toEqual(['usage: node lib/gh.mjs check', 'usage: node lib/gh.mjs check']);
  });

  it('runs as a script, with a fake gh first on PATH', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fake-gh-'));
    writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\necho "gh version 2.89.0 (2026-03-26)"\n');
    chmodSync(path.join(dir, 'gh'), 0o755);
    const script = path.join(import.meta.dirname, 'gh.mjs');
    const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
    const old = spawnSync(process.execPath, [script, 'check'], { env, encoding: 'utf8' });
    expect(old.status).toBe(1);
    expect(old.stderr).toContain('yours is 2.89.0');
    writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\necho "gh version 2.99.0 (2026-09-01)"\n');
    expect(execFileSync(process.execPath, [script, 'check'], { env, encoding: 'utf8' })).toBe('');
  });
});
