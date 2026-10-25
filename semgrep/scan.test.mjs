import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXCLUDED_RULES, main, missingPaths, semgrepArgs, settings } from './scan.mjs';
import { cli, selftest } from './selftest.mjs';

function app(/** @type {unknown} */ semgrep) {
  const root = mkdtempSync(path.join(tmpdir(), 'semgrep-'));
  mkdirSync(path.join(root, '.github'));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, '.github', 'ci.json'), JSON.stringify({ semgrep }));
  return root;
}

describe('settings', () => {
  it('defaults to the whole tree', () => {
    expect(settings({})).toEqual({ paths: [] });
  });

  it('takes a list of paths in the checkout', () => {
    expect(settings({ paths: ['src', 'index.ts'] })).toEqual({ paths: ['src', 'index.ts'] });
  });

  it.each([['src'], [['']], [[3]], [['/etc']], [['../x']], [['a/../../b']]])(
    'refuses %j',
    (paths) => {
      expect(() => settings({ paths })).toThrow(/semgrep\.paths/);
    },
  );
});

describe('semgrepArgs', () => {
  it('scans with the registry rules, failing on findings, minus the shared allowlist', () => {
    const args = semgrepArgs({ paths: [] });
    expect(args.slice(0, 4)).toEqual(['scan', '--config', 'auto', '--error']);
    expect(args.filter((a) => a === '--exclude-rule')).toHaveLength(EXCLUDED_RULES.length);
    expect(args.at(-1)).toBe('.');
  });

  it('scans only the paths given', () => {
    expect(semgrepArgs({ paths: ['src', 'modules'] }).slice(-2)).toEqual(['src', 'modules']);
  });
});

describe('missingPaths', () => {
  it('names the paths that are not there', () => {
    expect(missingPaths({ paths: ['src', 'gone'] }, app({}))).toEqual(['gone']);
  });
});

describe('selftest', () => {
  it('prints the command for good settings', () => {
    expect(selftest(app({ paths: ['src'] }))[0]).toMatch(
      /^semgrep: would run semgrep scan .* src$/,
    );
  });

  it('fails on a path that is not there', () => {
    expect(() => selftest(app({ paths: ['nope'] }))).toThrow('nope');
  });
});

describe('main', () => {
  it("runs semgrep in the app's checkout and passes on its exit code", () => {
    const root = app({ paths: ['src'] });
    /** @type {[string, string[], string][]} */
    const calls = [];
    expect(main(root, (command, args, cwd) => (calls.push([command, args, cwd]), 1))).toBe(1);
    expect(calls[0][0]).toBe('semgrep');
    expect(calls[0][1].at(-1)).toBe('src');
    expect(calls[0][2]).toBe(root);
    expect(main(root, () => null)).toBe(1);
    expect(main(root, () => 0)).toBe(0);
  });

  it('fails without running semgrep when a path is missing', () => {
    const lines = /** @type {string[]} */ ([]);
    const run = () => 0;
    expect(main(app({ paths: ['gone'] }), run, (l) => lines.push(l))).toBe(1);
    expect(lines[0]).toContain("names what isn't there: gone");
  });
});

describe('cli', () => {
  it('prints the self-test and returns its exit code', () => {
    const lines = /** @type {string[]} */ ([]);
    expect(cli([app({})], (l) => lines.push(l))).toBe(0);
    expect(cli([app({ paths: ['gone'] })], (l) => lines.push(l))).toBe(1);
    expect(lines.at(-1)).toMatch(/^semgrep self-test failed: .*gone/);
  });
});
