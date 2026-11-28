import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIN_GH, MIN_GH_ISSUE, checkGh, commandIn, ghIn, ghVersion, main } from './gh.ts';
import { importOnly, runAsScript } from './test-script.ts';

describe('ghVersion', () => {
  it("reads gh's first line", () => {
    expect(ghVersion('gh version 2.89.0 (2026-03-26)\nhttps://…')).toEqual([2, 89, 0]);
    expect(ghVersion('not gh')).toBe(null);
  });

  it('reads each number whole, however many digits it has', () => {
    expect(ghVersion('gh version 12.104.13 (2030-01-01)')).toEqual([12, 104, 13]);
  });
});

describe('checkGh', () => {
  const at = (v: string) => () => `gh version ${v} (2026-09-01)\n`;

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

describe('checkGh, for an issue', () => {
  const at = (v: string) => () => `gh version ${v} (2026-11-01)\n`;
  const lists = () => 'Flags:\n  -a, --attach file   Attach a file\n  -b, --body string\n';

  it('passes 2.104.0 or newer whose gh issue edit lists --attach', () => {
    expect(() => checkGh(at('2.104.0'), { issue: true, help: lists })).not.toThrow();
    expect(() => checkGh(at('2.110.3'), { issue: true, help: lists })).not.toThrow();
  });

  it('finds --attach at the very start of the help too', () => {
    expect(() =>
      checkGh(at('2.104.0'), { issue: true, help: () => '--attach file\n' }),
    ).not.toThrow();
  });

  it('refuses an older gh, and one whose gh issue edit has no --attach', () => {
    expect(() => checkGh(at('2.103.9'), { issue: true, help: lists })).toThrow(
      'install gh ≥ 2.104, which can attach files to an issue (`gh --version` shows yours; yours is 2.103.9)',
    );
    expect(() =>
      checkGh(at('2.105.0'), { issue: true, help: () => 'Flags:\n  --add-label name\n' }),
    ).toThrow('install gh ≥ 2.104, which can attach files to an issue (yours, 2.105.0, has no');
    // A PR's check stays at 2.99, and never asks the issue's help.
    expect(() =>
      checkGh(at('2.99.0'), {
        help: () => {
          throw new Error('not asked');
        },
      }),
    ).not.toThrow();
  });

  it("names 2.104.0, the gh ci#144's V10 found it on", () => {
    expect(MIN_GH_ISSUE).toBe('2.104.0');
  });
});

describe('checkGh, running gh', () => {
  /**
   * Runs checkGh with a fake gh first on PATH, printing this version (or no gh at all).
   */
  function withFakeGh(version: string | null) {
    const dir = mkdtempSync(path.join(tmpdir(), 'fake-gh-'));
    if (version) {
      const gh = path.join(dir, 'gh');
      // The version only for `--version`, as gh prints its usage otherwise.
      writeFileSync(
        gh,
        `#!/bin/sh\n[ "$1" = --version ] && echo "gh version ${version} (2026-09-01)"\nexit 0\n`,
      );
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

  /**
   * Runs checkGh for an issue, its version given, with this gh script (or no
   * gh at all) first on PATH for `gh issue edit --help`.
   */
  function issueHelpFrom(script: string | null) {
    const dir = mkdtempSync(path.join(tmpdir(), 'fake-gh-'));
    if (script) {
      writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\n${script}\n`);
      chmodSync(path.join(dir, 'gh'), 0o755);
    }
    const saved = process.env.PATH;
    process.env.PATH = script ? `${dir}${path.delimiter}${saved}` : dir;
    try {
      checkGh(() => 'gh version 2.104.0 (2026-11-01)', { issue: true });
    } finally {
      process.env.PATH = saved;
    }
  }

  it("reads gh issue edit's help from stderr as well as stdout", () => {
    const help = '[ "$1 $2 $3" = "issue edit --help" ] && echo "  --attach file"';
    expect(() => issueHelpFrom(help)).not.toThrow();
    expect(() => issueHelpFrom(`${help} >&2`)).not.toThrow();
    expect(() => issueHelpFrom('echo "  --title string"')).toThrow(
      'has no `gh issue edit --attach`',
    );
  });

  it("throws why gh issue edit's help couldn't run, rather than call it flagless", () => {
    expect(() => issueHelpFrom(null)).toThrow(/ENOENT/);
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
      /^sh -c failed: nope$/,
    );
  });

  it("ends a failure's message with the last 800 characters of what it printed, trimmed", () => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'lib-gh-cwd-')));
    const long = `${'a'.repeat(900)}${'b'.repeat(800)}`;
    expect(() => commandIn('sh', cwd)(['-c', `echo ${long} >&2; exit 1`])).toThrow(
      new RegExp(`^sh -c failed: b{800}$`),
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
  const at = (v: string) => () => `gh version ${v} (2026-09-01)\n`;

  it('exits 0 for a gh that can attach, and 1 saying what to install', () => {
    const errors: string[] = [];
    const error = (line: string) => errors.push(line);
    expect(main(['check'], { version: at('2.99.0'), error })).toBe(0);
    expect(main(['check'], { version: at('2.89.0'), error })).toBe(1);
    expect(errors).toEqual([
      'install gh ≥ 2.99, which can attach files to a PR (`gh --version` shows yours; yours is 2.89.0)',
    ]);
  });

  it('says how to call it', () => {
    const errors: string[] = [];
    expect(main([], { error: (l) => errors.push(l) })).toBe(2);
    expect(main(['check', 'x'], { error: (l) => errors.push(l) })).toBe(2);
    expect(main(['x'], { error: (l) => errors.push(l) })).toBe(2);
    expect(main(['check', '--issue', 'x'], { error: (l) => errors.push(l) })).toBe(2);
    expect(errors).toEqual(Array(4).fill('usage: node lib/gh.ts check [--issue]'));
  });

  it('checks for an issue with --issue', () => {
    const errors: string[] = [];
    const error = (line: string) => errors.push(line);
    const help = () => '  --attach file\n';
    expect(main(['check', '--issue'], { version: at('2.104.0'), help, error })).toBe(0);
    expect(main(['check', '--issue'], { version: at('2.99.0'), help, error })).toBe(1);
    expect(errors[0]).toContain('which can attach files to an issue');
  });

  it('runs as a script, with a fake gh first on PATH', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fake-gh-'));
    writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\necho "gh version 2.89.0 (2026-03-26)"\n');
    chmodSync(path.join(dir, 'gh'), 0o755);
    const script = path.join(import.meta.dirname, 'gh.ts');
    const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
    const old = spawnSync(process.execPath, [script, 'check'], { env, encoding: 'utf8' });
    expect(old.status).toBe(1);
    expect(old.stderr).toContain('yours is 2.89.0');
    writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\necho "gh version 2.99.0 (2026-09-01)"\n');
    expect(execFileSync(process.execPath, [script, 'check'], { env, encoding: 'utf8' })).toBe('');
    // gh 2.104 whose issue edit's help lists --attach, asked as gh is.
    writeFileSync(
      path.join(dir, 'gh'),
      '#!/bin/sh\n[ "$1" = issue ] && { echo "  --attach file"; exit 0; }\necho "gh version 2.104.0 (2026-11-01)"\n',
    );
    expect(
      execFileSync(process.execPath, [script, 'check', '--issue'], { env, encoding: 'utf8' }),
    ).toBe('');
  });
});

describe('main, run as a script in this process', () => {
  // The child-process test above, in process, so coverage and Stryker see the
  // script's own lines run (lib/test-script.ts).
  const script = path.join(import.meta.dirname, 'gh.ts');
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs as a script, with a fake gh first on PATH', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // The child test's empty stdout: neither console.log nor a write to it.
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const dir = mkdtempSync(path.join(tmpdir(), 'fake-gh-'));
    writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\necho "gh version 2.89.0 (2026-03-26)"\n');
    chmodSync(path.join(dir, 'gh'), 0o755);
    const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
    expect(await runAsScript(script, ['check'], env)).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('yours is 2.89.0');
    error.mockClear();
    writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\necho "gh version 2.99.0 (2026-09-01)"\n');
    expect(await runAsScript(script, ['check'], env)).toBe(0);
    // gh 2.104 whose issue edit's help lists --attach, asked as gh is.
    writeFileSync(
      path.join(dir, 'gh'),
      '#!/bin/sh\n[ "$1" = issue ] && { echo "  --attach file"; exit 0; }\necho "gh version 2.104.0 (2026-11-01)"\n',
    );
    expect(await runAsScript(script, ['check', '--issue'], env)).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('runs no command line when imported', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await importOnly(script)).toBe(undefined);
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
