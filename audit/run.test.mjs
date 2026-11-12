import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TITLES, drawGraph, knipConfig, main, runJscpd, runKnip, settings } from './run.mjs';
import { cli, selftest } from './selftest.mjs';

/**
 * A git checkout holding these files (each `{}` unless given), staged, and a
 * package.json with the `jscpd` script unless one is given.
 *
 * @param {string[] | Record<string, string>} files
 */
function root(files = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-app-'));
  const given = Array.isArray(files) ? Object.fromEntries(files.map((f) => [f, '{}'])) : files;
  const all = { 'package.json': '{"scripts":{"jscpd":"jscpd"}}', ...given };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  return dir;
}

/**
 * Deps for main, with a spawn that answers each tool.
 *
 * @param {Partial<import('./run.mjs').Deps>} overrides
 */
function deps(overrides = {}) {
  const out = { summary: /** @type {string[]} */ ([]), outputs: /** @type {string[][]} */ ([]) };
  const gh = vi.fn((/** @type {string[]} */ args) =>
    args[1] === 'list' ? '[{"number":4,"title":"Dead code (weekly audit)","state":"OPEN"}]' : '',
  );
  /** @type {import('./run.mjs').Deps} */
  const d = {
    root: root(['knip.jsonc']),
    env: { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '7' },
    spawn: () => ({
      status: 1,
      stdout: '{"issues":[{"file":"a.ts","exports":[{"name":"x"}]}]}',
      stderr: '',
    }),
    gh,
    summary: (markdown) => out.summary.push(markdown),
    setOutput: (name, value) => out.outputs.push([name, value]),
    now: new Date('2026-10-26T06:00:00Z'),
    ...overrides,
  };
  return { d, out, gh };
}

describe('knipConfig', () => {
  it("names the app's knip config, or says so", () => {
    expect(knipConfig(root(['knip.jsonc']))).toBe('knip.jsonc');
    expect(knipConfig(root(['knip.json', 'knip.jsonc']))).toBe('knip.json');
    expect(knipConfig(root())).toBe('knip’s config');
  });
});

describe('runKnip', () => {
  it("runs the app's knip, taking exit 1 as findings", () => {
    const spawn = vi.fn(() => ({ status: 1, stdout: '{"issues":[]}', stderr: '' }));
    expect(runKnip('/app', spawn)).toEqual({ issues: [] });
    expect(spawn).toHaveBeenCalledWith(
      'npx',
      ['--no-install', 'knip', '--reporter', 'json', '--no-progress'],
      '/app',
    );
  });

  it('fails when knip breaks', () => {
    expect(() => runKnip('/app', () => ({ status: 2, stdout: '', stderr: 'boom\n' }))).toThrow(
      'knip failed (exit 2): boom',
    );
  });
});

describe('runJscpd', () => {
  it("runs the app's jscpd script and reads the JSON report it wrote, whatever its exit code", () => {
    /** @type {string[][]} */
    const calls = [];
    const report = runJscpd(root(), (command, args) => {
      calls.push([command, ...args]);
      writeFileSync(
        path.join(args[args.indexOf('--output') + 1], 'jscpd-report.json'),
        '{"duplicates":[]}',
      );
      return { status: 1, stdout: '', stderr: '' };
    });
    expect(report).toEqual({ duplicates: [] });
    expect(calls[0].slice(0, 7)).toEqual([
      'npm',
      'run',
      '--silent',
      'jscpd',
      '--',
      '--reporters',
      'json',
    ]);
  });

  it('fails when jscpd wrote no report', () => {
    expect(() => runJscpd(root(), () => ({ status: 0, stdout: '', stderr: 'nope' }))).toThrow(
      'jscpd wrote no report (exit 0): nope',
    );
  });

  it.each([['{}'], ['{"scripts":{"jscpd":"jscpd --min-lines 3"}}']])(
    'fails, saying what to add, when package.json is %s',
    (pkg) => {
      const spawn = vi.fn();
      expect(() => runJscpd(root({ 'package.json': pkg }), spawn)).toThrow(
        'package.json needs the script `"jscpd": "jscpd"`',
      );
      expect(spawn).not.toHaveBeenCalled();
    },
  );
});

describe('main', () => {
  it('reports knip, sets the count and rewrites the open issue', () => {
    const { d, out, gh } = deps();
    expect(main(['knip'], d)).toBe('Dead code (weekly audit): update (#4).');
    expect(out.summary[0]).toMatch(/^## Dead code \(weekly audit\)\n\n\[knip\]/);
    expect(out.summary[0]).toContain(
      'make their file an `entry` in `knip.jsonc`: an ignore fails the audit',
    );
    expect(out.outputs).toEqual([['findings', '1']]);
    expect(gh.mock.calls[1][0]).toEqual(['issue', 'edit', '4', '--body-file', '-']);
  });

  it('leaves the issue alone on a dry run', () => {
    const { d, gh } = deps();
    expect(main(['knip', '--dry-run'], d)).toBe(
      'Dead code (weekly audit): 1 found (dry run, issue left alone).',
    );
    expect(gh).not.toHaveBeenCalled();
  });

  it('reports jscpd, clean, closing nothing that is not open', () => {
    const { d, out } = deps({
      spawn: (_, args) => {
        writeFileSync(path.join(args[args.indexOf('--output') + 1], 'jscpd-report.json'), '{}');
        return { status: 0, stdout: '', stderr: '' };
      },
      gh: () => '[]',
    });
    expect(main(['jscpd'], d)).toBe('Duplicated code (weekly audit): none.');
    expect(out.summary[0]).toBe('## Duplicated code (weekly audit)\n\nNothing found.');
  });

  it("reports lychee from its report, if lychee didn't break", () => {
    const dir = root();
    const report = path.join(dir, 'lychee.json');
    writeFileSync(
      report,
      JSON.stringify({ error_map: { 'a.md': [{ url: 'u', status: 'gone' }] } }),
    );
    const { d, out } = deps({ gh: () => '[]' });
    expect(main(['lychee', report, '2', '--dry-run'], d)).toBe(
      `${TITLES.lychee}: 1 found (dry run, issue left alone).`,
    );
    expect(out.summary[0]).toContain('- u — gone');
    expect(() => main(['lychee', report, '1'], d)).toThrow('lychee failed (exit 1)');
    expect(() => main(['lychee'], d)).toThrow('lychee <report.json> <exit code>');
  });

  it("fails on a lychee report that has no error_map, whatever lychee's exit", () => {
    const dir = root();
    const report = path.join(dir, 'lychee.json');
    const { d } = deps({ gh: () => '[]' });
    writeFileSync(report, JSON.stringify({ broken_links: { 'a.md': [{ url: 'u' }] } }));
    expect(() => main(['lychee', report, '2', '--dry-run'], d)).toThrow('has no error_map');
    expect(() => main(['lychee', report, '0', '--dry-run'], d)).toThrow('has no error_map');
    writeFileSync(report, 'null');
    expect(() => main(['lychee', report, '0', '--dry-run'], d)).toThrow('has no error_map');
    // An unknown status (LinkedIn's 999) exits 2 with nothing in error_map.
    writeFileSync(report, JSON.stringify({ unknown: 1, error_map: {} }));
    expect(main(['lychee', report, '2', '--dry-run'], d)).toBe(
      `${TITLES.lychee}: 0 found (dry run, issue left alone).`,
    );
  });

  it('refuses an unknown check', () => {
    expect(() => main(['eslint'], deps().d)).toThrow('usage');
  });
});

describe('settings', () => {
  it('draws src by default, or the folders given', () => {
    expect(settings({})).toEqual({ graph: ['src'] });
    expect(settings({ graph: ['src', 'api'] })).toEqual({ graph: ['src', 'api'] });
  });

  it.each([[[]], ['src'], [['']], [['--output-type']], [[1]]])('refuses %j', (graph) => {
    expect(() => settings({ graph })).toThrow('audit.graph must be a list of folders');
  });
});

describe('graph', () => {
  it('draws the folders the app names, by folder and module, and the HTML report', () => {
    const app = root();
    mkdirSync(path.join(app, '.github'));
    writeFileSync(path.join(app, '.github', 'ci.json'), '{"audit":{"graph":["src","api"]}}');
    const calls = /** @type {string[][]} */ ([]);
    const { d } = deps({
      root: app,
      spawn: (command, args, _cwd, input) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stdout: command === 'dot' ? `<svg>${input}</svg>` : (args.at(-1) ?? ''),
          stderr: '',
        };
      },
    });
    const out = path.join(app, 'out');
    expect(main(['graph', out], d)).toBe(
      'Architecture graph of src, api: architecture.svg, modules.svg, report.html.',
    );
    expect(calls[0]).toEqual([
      'npx',
      '--no-install',
      'depcruise',
      'src',
      'api',
      '--output-type',
      'archi',
    ]);
    expect(readFileSync(path.join(out, 'architecture.svg'), 'utf8')).toBe('<svg>archi</svg>');
    expect(readFileSync(path.join(out, 'modules.svg'), 'utf8')).toBe('<svg>dot</svg>');
    expect(readFileSync(path.join(out, 'report.html'), 'utf8')).toBe('html');
  });

  it('fails when depcruise or dot does, and needs somewhere to draw', () => {
    const { d } = deps({ spawn: () => ({ status: 1, stdout: '', stderr: 'bad rule' }) });
    expect(() => drawGraph(d.root, ['src'], path.join(d.root, 'o'), d.spawn)).toThrow(
      'depcruise archi failed (exit 1): bad rule',
    );
    expect(() => main(['graph'], d)).toThrow('graph <out dir>');
  });
});

describe('selftest', () => {
  /** @type {import('./run.mjs').Spawn} */
  const tools = (_, args) => {
    if (args.includes('jscpd')) {
      writeFileSync(path.join(args[args.indexOf('--output') + 1], 'jscpd-report.json'), '{}');
    }
    return { status: 0, stdout: '{"issues":[]}', stderr: '' };
  };

  it('runs knip and jscpd dry, with the graph folders checked', () => {
    const app = root();
    mkdirSync(path.join(app, 'src'));
    expect(selftest(app, tools)).toEqual([
      'audit: the graph would draw src.',
      'audit: Dead code (weekly audit): 0 found (dry run, issue left alone).',
      'audit: Duplicated code (weekly audit): 0 found (dry run, issue left alone).',
    ]);
  });

  it('fails on a graph folder that is not there', () => {
    expect(() => selftest(root(), tools)).toThrow("audit.graph names what isn't there: src");
  });
});

describe('cli', () => {
  it('prints the self-test and returns its exit code', () => {
    const lines = /** @type {string[]} */ ([]);
    expect(cli([root()], (l) => lines.push(l))).toBe(1);
    expect(lines.at(-1)).toBe("audit self-test failed: audit.graph names what isn't there: src");
  });
});
