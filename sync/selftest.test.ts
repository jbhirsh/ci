import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFiles } from '../review/testApp.ts';
import { CI_ROOT, loadManifest, parseManifest, resolve } from './manifest.ts';
import { appName, cli, selftest } from './selftest.ts';

const app = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(tmpdir(), 'app-'));
  writeFiles(root, files);
  return root;
};

describe("this repo's manifest", () => {
  it('loads, and holds the first five files', () => {
    expect(loadManifest().files.map((f) => f.path)).toEqual([
      '.github/pull_request_template.md',
      '.github/workflows/pr-changes.yml',
      '.github/workflows/pr-description.yml',
      '.github/workflows/pr-gif.yml',
      '.github/workflows/pr-gif-attach.yml',
    ]);
  });
});

describe('appName', () => {
  it('is APP_NAME, else the repository’s own name when that is an app’s', () => {
    expect(appName({ APP_NAME: 'sift', GITHUB_REPOSITORY: 'jbhirsh/BoardGames' })).toBe('sift');
    expect(appName({ GITHUB_REPOSITORY: 'jbhirsh/BoardGames' })).toBe('BoardGames');
  });

  it('is none where CI runs in this repo, or by hand', () => {
    expect(appName({ GITHUB_REPOSITORY: 'jbhirsh/ci' })).toBeUndefined();
    expect(appName({ GITHUB_REPOSITORY: 'jbhirsh' })).toBeUndefined();
    expect(appName({})).toBeUndefined();
  });

  it('refuses an APP_NAME that is no app', () => {
    expect(() => appName({ APP_NAME: 'nope' })).toThrow(/APP_NAME "nope" is not one of/);
  });
});

describe('selftest', () => {
  it('passes an app that holds none of the files, or has no settings', () => {
    expect(selftest(app({}))[0]).toBe(
      'sync: 5 synced files (no app named, so every entry) fit this checkout.',
    );
    expect(selftest(app({}), 'BoardGames')[0]).toBe(
      'sync: BoardGames holds 5 synced files; they fit this checkout.',
    );
  });

  it('passes an app whose files and settings differ from this repo’s: that is the sync’s job', () => {
    const root = app({
      '.github/pull_request_template.md': 'an old template',
      '.github/workflows/pr-changes.yml': 'name: something else',
      '.github/ci.json': JSON.stringify({
        autofix: { exempt: { 'PR changes': 'its own reason' } },
      }),
    });
    expect(() => selftest(root, 'sift')).not.toThrow();
  });

  it('fails an app whose ci.json is not JSON, or not an object', () => {
    expect(() => selftest(app({ '.github/ci.json': '{' }))).toThrow(/ci\.json is not JSON/);
    expect(() => selftest(app({ '.github/ci.json': '[]' }))).toThrow(
      /ci\.json must hold an object/,
    );
  });

  it('fails an app where a companion could not be set', () => {
    const root = app({ '.github/ci.json': JSON.stringify({ autofix: 'on' }) });
    expect(() => selftest(root)).toThrow(/"autofix" is not an object/);
  });

  it('fails an app where a synced path is a folder or a link, not a file', () => {
    const root = app({ '.github/pull_request_template.md/keep': 'a folder' });
    expect(() => selftest(root)).toThrow(/pull_request_template\.md is not a regular file/);
    const link = app({});
    mkdirSync(path.join(link, '.github/workflows'), { recursive: true });
    symlinkSync(path.join(link, 'nowhere'), path.join(link, '.github/workflows/pr-changes.yml'));
    expect(() => selftest(link)).toThrow(/pr-changes\.yml is not a regular file/);
  });

  it('fails an app where a folder on the way to a synced path is a link or a file', () => {
    const elsewhere = app({ 'x/workflows/keep': '' });
    const linked = app({});
    symlinkSync(path.join(elsewhere, 'x'), path.join(linked, '.github'));
    expect(() => selftest(linked)).toThrow(
      /\.github is a link in the app, on the way to \.github\/pull_request_template\.md/,
    );
    const file = app({ '.github': 'a file where the folder belongs' });
    expect(() => selftest(file)).toThrow(/\.github is a file in the app, on the way to/);
    const half = app({ '.github/workflows': 'a file' });
    expect(() => selftest(half)).toThrow(/\.github\/workflows is a file in the app/);
  });

  it('checks only the entries that name the app', () => {
    const manifest = parseManifest(
      JSON.stringify({
        files: [
          { path: 'a.yml', source: 'sync/callers/pr-description.yml', apps: ['sift'] },
          { path: 'b.yml', source: 'sync/callers/pr-description.yml', apps: ['fog-and-frontier'] },
        ],
        unsynced: [],
      }),
    );
    const root = app({ 'b.yml/keep': 'a folder where fog would write a file' });
    expect(selftest(root, 'sift', manifest)[0]).toMatch(/sift holds 1 synced files/);
    expect(() => selftest(root, 'fog-and-frontier', manifest)).toThrow(/b\.yml is not a regular/);
    expect(() => selftest(root, undefined, manifest)).toThrow(/b\.yml is not a regular/);
  });
});

describe("the self-test's report of what the next sync would change", () => {
  const ours = (file: string) => readFileSync(path.join(CI_ROOT, file), 'utf8');
  /** The files sift holds when in step: the canonical, or sift's variant. */
  const inStep = () =>
    Object.fromEntries(
      resolve(loadManifest(), 'sift').map((file) => [file.path, ours(file.source)]),
    );

  it('says an app in step needs no PR', () => {
    expect(selftest(app(inStep()), 'sift').slice(1)).toEqual([
      'sync: sift: every synced file matches jbhirsh/ci; no PR.',
    ]);
  });

  it('names exactly the file that drifted, and never fails on it', () => {
    const files = inStep();
    files['.github/workflows/pr-gif.yml'] += '# a hand edit\n';
    expect(selftest(app(files), 'sift').slice(1)).toEqual([
      'sync: sift: would open or update one PR from bot/sync-files, "Sync shared files with jbhirsh/ci", with 1 commit(s):',
      'sync:   - Sync .github/workflows/pr-gif.yml with jbhirsh/ci (updated, +0 −1, variant)',
    ]);
  });
});

describe('cli', () => {
  it('prints the self-test and returns its exit code', () => {
    const out: string[] = [];
    expect(cli([app({})], (l) => out.push(l), { APP_NAME: 'sift' })).toBe(0);
    expect(out[0]).toBe('sync: sift holds 5 synced files; they fit this checkout.');
    expect(out[1]).toMatch(/^sync: sift: would open or update one PR .* with 5 commit\(s\):$/);
    expect(cli([app({ '.github/ci.json': '{' })], (l) => out.push(l), {})).toBe(1);
    expect(out.at(-1)).toMatch(/^sync self-test failed: .*ci\.json is not JSON/);
    expect(cli([app({})], (l) => out.push(l), { APP_NAME: 'nope' })).toBe(1);
    expect(out.at(-1)).toMatch(/APP_NAME "nope"/);
  });
});
