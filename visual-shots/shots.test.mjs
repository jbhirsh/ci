import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { settings } from '../visual-review/settings.mjs';
import {
  decodePatch,
  main,
  MANIFEST,
  MAX_PATCH_CHARS,
  mockupIssue,
  numstatFiles,
  parseManifest,
  patchProblem,
  shotsUnder,
} from './shots.mjs';

const SHA = 'a'.repeat(40);
const s = /** @type {import('../visual-review/settings.mjs').Settings} */ (
  settings({ workflow: 'v.yml', job: 'v', folders: ['shots/*-snapshots'], mockupPaths: ['src/**'] })
);

/**
 * An app checkout: a git repo with these files committed, and its settings.
 *
 * @param {Record<string, string>} files
 */
function app(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'app-'));
  const all = {
    '.github/ci.json': JSON.stringify({
      'visual-review': {
        workflow: 'v.yml',
        job: 'v',
        folders: ['shots/*-snapshots'],
        mockupPaths: ['src/**'],
      },
    }),
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  const git = (/** @type {string[]} */ args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one']);
  return { root, git };
}

describe('parseManifest', () => {
  it('reads what visual-shots writes', () => {
    const m = { version: 1, sha: SHA, base: SHA, event: 'push', mockupIssue: null };
    expect(parseManifest(m)).toEqual(m);
    expect(parseManifest({ ...m, event: 'workflow_dispatch', mockupIssue: 7 }).mockupIssue).toBe(7);
  });

  it('refuses anything else', () => {
    const m = { version: 1, sha: SHA, base: SHA, event: 'push', mockupIssue: null };
    for (const bad of [
      null,
      [],
      { ...m, version: 2 },
      { ...m, sha: 'HEAD' },
      { ...m, base: 1 },
      { ...m, event: 'schedule' },
      { ...m, mockupIssue: 0 },
      { ...m, mockupIssue: '7' },
    ]) {
      expect(() => parseManifest(bad)).toThrow(/isn't one visual-shots wrote/);
    }
  });
});

describe('mockupIssue', () => {
  it('reads digits, and nothing else', () => {
    expect(mockupIssue(undefined)).toBeNull();
    expect(mockupIssue('')).toBeNull();
    expect(mockupIssue('42')).toBe(42);
    for (const bad of ['0', '-1', '4 2', '#4', '1e3']) {
      expect(() => mockupIssue(bad)).toThrow(/issue number/);
    }
  });
});

describe('decodePatch', () => {
  it('decodes base64, spaces aside', () => {
    expect(decodePatch(Buffer.from('diff').toString('base64') + '\n').toString()).toBe('diff');
  });

  it('refuses what is not base64, or too big', () => {
    expect(() => decodePatch('not base64!')).toThrow(/must be base64/);
    expect(() => decodePatch('')).toThrow(/must be base64/);
    expect(() => decodePatch('A'.repeat(MAX_PATCH_CHARS + 4))).toThrow(/at most/);
  });
});

describe('numstatFiles', () => {
  it('reads plain entries and both sides of a rename', () => {
    expect(numstatFiles('1\t2\tsrc/a.ts\0-\t-\timg.png\0')).toEqual(['src/a.ts', 'img.png']);
    expect(numstatFiles('0\t0\t\0src/old.ts\0src/new.ts\0')).toEqual(['src/old.ts', 'src/new.ts']);
  });
});

describe('patchProblem', () => {
  it('lets a patch inside mockupPaths through', () => {
    expect(patchProblem({ files: ['src/App.tsx'], summary: '', s })).toBeNull();
  });

  it('refuses an empty patch, a rename, a mode change, and paths outside', () => {
    expect(patchProblem({ files: [], summary: '', s })).toMatch(/changes nothing/);
    expect(patchProblem({ files: ['src/a'], summary: ' rename src/{a => b} (100%)', s })).toMatch(
      /renames/,
    );
    expect(patchProblem({ files: ['src/a'], summary: ' create mode 120000 src/a', s })).toMatch(
      /link/,
    );
    expect(
      patchProblem({ files: ['src/a'], summary: ' mode change 100644 => 100755 src/a', s }),
    ).toMatch(/mode/);
    expect(patchProblem({ files: ['.github/workflows/ci.yml'], summary: '', s })).toMatch(
      /may not: \.github\/workflows\/ci\.yml/,
    );
  });
});

describe('shotsUnder', () => {
  it('lists the PNGs under the folders, ignored ones too', () => {
    const { root } = app({
      'shots/a-snapshots/x.png': 'x',
      'shots/a-snapshots/n.txt': 'n',
      'other/y.png': 'y',
    });
    expect(shotsUnder(root, s.folders)).toEqual(['shots/a-snapshots/x.png']);
  });
});

describe('main', () => {
  it("collects the shots with a PR's manifest: its head and the main it merges into", () => {
    const { root, git } = app({ 'shots/a-snapshots/x.png': 'x' });
    const id = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
    const first = git(['rev-parse', 'HEAD']).trim();
    git(['checkout', '-q', '-b', 'pr']);
    git([...id, 'commit', '-q', '--allow-empty', '-m', 'pr']);
    const head = git(['rev-parse', 'HEAD']).trim();
    git(['checkout', '-q', '-']);
    git([...id, 'commit', '-q', '--allow-empty', '-m', 'main moved']);
    const moved = git(['rev-parse', 'HEAD']).trim();
    // What actions/checkout gives a PR's run: the merge commit.
    git([...id, 'merge', '-q', '--no-ff', '-m', 'merge', 'pr']);
    const out = mkdtempSync(path.join(tmpdir(), 'out-'));
    expect(first).not.toBe(moved);
    expect(main(['collect', out], { GITHUB_EVENT_NAME: 'pull_request' }, root)).toMatch(/1 shot/);
    expect(readFileSync(path.join(out, 'shots/a-snapshots/x.png'), 'utf8')).toBe('x');
    const m = parseManifest(JSON.parse(readFileSync(path.join(out, MANIFEST), 'utf8')));
    expect(m).toMatchObject({ sha: head, base: moved, event: 'pull_request' });
    const push = mkdtempSync(path.join(tmpdir(), 'out-'));
    main(['collect', push], { GITHUB_EVENT_NAME: 'push' }, root);
    const p = parseManifest(JSON.parse(readFileSync(path.join(push, MANIFEST), 'utf8')));
    expect(p.sha).toBe(p.base);
  });

  it('applies a mockup patch inside mockupPaths, and refuses one outside', () => {
    const { root, git } = app({ 'src/a.txt': 'one\n', 'README.md': 'r\n' });
    writeFileSync(path.join(root, 'src/a.txt'), 'two\n');
    const ok = Buffer.from(git(['diff', '--binary'])).toString('base64');
    git(['checkout', '-q', '--', '.']);
    expect(main(['mockup'], { MOCKUP_PATCH: ok, MOCKUP_ISSUE: '3' }, root)).toMatch(/applied/);
    expect(readFileSync(path.join(root, 'src/a.txt'), 'utf8')).toBe('two\n');
    git(['checkout', '-q', '--', '.']);
    writeFileSync(path.join(root, 'README.md'), 'changed\n');
    const bad = Buffer.from(git(['diff', '--binary'])).toString('base64');
    git(['checkout', '-q', '--', '.']);
    expect(() => main(['mockup'], { MOCKUP_PATCH: bad }, root)).toThrow(/may not: README\.md/);
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('r\n');
  });

  it('needs the settings and a known command', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'none-'));
    expect(() => main(['collect', 'x'], {}, root)).toThrow(/no visual-review key/);
    const { root: r } = app({});
    expect(() => main(['nope'], {}, r)).toThrow(/usage/);
    expect(() => main(['collect'], {}, r)).toThrow(/usage/);
    expect(existsSync(path.join(r, MANIFEST))).toBe(false);
  });
});
