import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPS,
  companionProblem,
  loadManifest,
  manifestProblems,
  parseManifest,
  pathProblem,
  resolve,
} from './manifest.ts';

const all = ['BoardGames', 'fog-and-frontier', 'sift'];
const entry = (/** @type {Record<string, unknown>} */ more = {}) => ({
  path: '.github/workflows/a.yml',
  source: 'sync/callers/a.yml',
  apps: all,
  ...more,
});
const manifest = (
  /** @type {Record<string, unknown>[]} */ files = [entry()],
  /** @type {unknown[]} */ unsynced = [],
) => ({
  files,
  unsynced,
});

describe('pathProblem', () => {
  it('accepts ordinary relative paths', () => {
    for (const ok of ['a', '.github/ci.json', 'sync/callers/a.yml', '.hidden/x.y']) {
      expect(pathProblem(ok)).toBeNull();
    }
  });

  it('refuses what could leave a checkout, or isn’t a path', () => {
    for (const bad of [
      '',
      '/etc/passwd',
      'C:/x',
      'a/../b',
      '../a',
      'a//b',
      'a/',
      './a',
      'a/./b',
      'a\\b',
      'a\0b',
      'a\nb',
      'a\u202Eb',
      'a\u200Bb',
      '.git/hooks/pre-push',
      '.GIT/config',
      '.Git',
    ]) {
      expect(pathProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    expect(pathProblem(undefined)).not.toBeNull();
    expect(pathProblem(3)).not.toBeNull();
  });
});

describe('manifestProblems', () => {
  it('passes a manifest with every part', () => {
    expect(
      manifestProblems(
        manifest(
          [
            entry({
              variants: { sift: { source: 'sync/callers/a-sift.yml', why: 'sift records in CI' } },
              companions: [{ key: ['autofix', 'exempt', 'A'], value: 'reads data' }],
            }),
          ],
          [{ source: 'gif/callers/pr-gif.yml', why: 'the copies differ' }],
        ),
      ),
    ).toEqual([]);
  });

  it('refuses a manifest that is not an object, or has unknown or missing parts', () => {
    expect(manifestProblems(null)).toEqual(['the manifest must be an object']);
    expect(manifestProblems([])).toEqual(['the manifest must be an object']);
    expect(manifestProblems({ files: [], unsynced: [], extra: 1 })).toEqual([
      'manifest: unknown key "extra"',
    ]);
    expect(manifestProblems({})).toEqual(['files must be an array', 'unsynced must be an array']);
  });

  it('refuses a file entry that is not whole', () => {
    expect(
      manifestProblems(
        manifest([/** @type {Record<string, unknown>} */ (/** @type {unknown} */ ('a'))]),
      ),
    ).toEqual(['files[0] must be an object']);
    const found = manifestProblems(
      manifest([{ path: '../x', source: '', apps: [], variant: {} }]),
    ).join('\n');
    expect(found).toMatch(/files\[0\]: unknown key "variant"/);
    expect(found).toMatch(/files\[0\]\.path must have no empty/);
    expect(found).toMatch(/files\[0\]\.source must be a non-empty string/);
    expect(found).toMatch(/files\[0\]\.apps must be a non-empty array/);
  });

  it('refuses an app that is unknown or repeated', () => {
    const found = manifestProblems(manifest([entry({ apps: ['sift', 'sift', 'nope'] })])).join(
      '\n',
    );
    expect(found).toMatch(/"nope" is not an app/);
    expect(found).toMatch(/repeats an app/);
  });

  it('refuses the app’s own settings as a synced path', () => {
    expect(manifestProblems(manifest([entry({ path: '.github/ci.json' })]))[0]).toMatch(
      /never synced/,
    );
  });

  it('refuses two entries for one path', () => {
    expect(manifestProblems(manifest([entry(), entry({ source: 'x.yml' })]))).toEqual([
      'files[1].path ".github/workflows/a.yml" is already files[0].path (case aside)',
    ]);
  });

  it('refuses two entries whose paths differ only by case', () => {
    expect(
      manifestProblems(manifest([entry({ path: 'A/b.yml' }), entry({ path: 'a/B.yml' })])),
    ).toEqual(['files[1].path "a/B.yml" is already files[0].path (case aside)']);
  });

  it('refuses a path that is a folder another entry is inside, either way round', () => {
    const inner = entry({ path: 'a/b/c.yml' });
    expect(manifestProblems(manifest([entry({ path: 'a/b' }), inner]))).toEqual([
      'files[1].path is inside files[0].path, a file',
    ]);
    expect(manifestProblems(manifest([inner, entry({ path: 'A/B' })]))).toEqual([
      'files[0].path is inside files[1].path, a file',
    ]);
    expect(manifestProblems(manifest([entry({ path: 'a/b' }), entry({ path: 'a/bc' })]))).toEqual(
      [],
    );
  });

  it('holds a variant to its app, its reason and a difference', () => {
    const variants = (/** @type {unknown} */ v) =>
      manifestProblems(manifest([entry({ apps: ['sift'], variants: v })])).join('\n');
    expect(variants({ fog: { source: 'x.yml', why: 'w' } })).toMatch(
      /"fog" is not one of this file's apps/,
    );
    expect(variants({ sift: { source: 'sync/callers/a.yml', why: 'w' } })).toMatch(
      /is the canonical source: a variant must differ/,
    );
    expect(variants({ sift: { source: 'x.yml', why: ' ' } })).toMatch(/must say why/);
    expect(variants({ sift: { source: '../x', why: 'w', more: 1 } })).toMatch(/unknown key "more"/);
    expect(variants({ sift: 'x.yml' })).toMatch(/must be an object with a source and a why/);
    expect(variants([])).toMatch(/must be an object of app → variant/);
  });

  it('holds a companion to a key path and a string', () => {
    const companions = (/** @type {unknown} */ c) =>
      manifestProblems(manifest([entry({ companions: c })])).join('\n');
    expect(companions({})).toMatch(/must be an array/);
    expect(companions(['x'])).toMatch(/\[0\] must be an object/);
    expect(companions([{ key: [], value: 'v' }])).toMatch(/key must be a non-empty array/);
    expect(companions([{ key: ['a', ''], value: 'v' }])).toMatch(/key must be a non-empty array/);
    expect(companions([{ key: ['a'], value: '' }])).toMatch(/value must be a non-empty string/);
    expect(companions([{ key: ['a', '__proto__'], value: 'v' }])).toMatch(/may not use/);
    expect(
      companions([
        { key: ['a'], value: 'v' },
        { key: ['a'], value: 'w' },
      ]),
    ).toMatch(/repeats an earlier companion/);
    expect(companions([{ key: ['a'], value: 'v', more: 1 }])).toMatch(/unknown key "more"/);
  });

  it('holds an unsynced entry to a path, a reason and being unsynced', () => {
    const unsynced = (/** @type {unknown[]} */ u) =>
      manifestProblems({ files: [entry()], unsynced: u }).join('\n');
    expect(unsynced(['x'])).toMatch(/unsynced\[0\] must be an object/);
    expect(unsynced([{ source: 'a', why: '' }])).toMatch(/why must say why/);
    expect(unsynced([{ source: 'a', why: 'w', more: 1 }])).toMatch(/unknown key "more"/);
    expect(
      unsynced([
        { source: 'a', why: 'w' },
        { source: 'a', why: 'w' },
      ]),
    ).toMatch(/is listed twice/);
    expect(unsynced([{ source: 'sync/callers/a.yml', why: 'w' }])).toMatch(
      /is synced by a file above/,
    );
    expect(unsynced([{ source: '../a', why: 'w' }])).toMatch(/source must have no empty/);
  });

  it('counts a variant’s source as synced', () => {
    const files = [entry({ variants: { sift: { source: 'v.yml', why: 'w' } } })];
    expect(manifestProblems({ files, unsynced: [{ source: 'v.yml', why: 'w' }] })[0]).toMatch(
      /is synced by a file above/,
    );
  });
});

describe('parseManifest', () => {
  it('fills in the optional parts', () => {
    expect(parseManifest(JSON.stringify(manifest())).files[0]).toEqual({
      ...entry(),
      variants: {},
      companions: [],
    });
  });

  it('says what is wrong, naming the file, for text that is not JSON or not a manifest', () => {
    expect(() => parseManifest('{')).toThrow(/^sync\/manifest\.json:\n {2}- is not JSON/);
    expect(() => parseManifest('{"files":[],"unsynced":[],"x":1}')).toThrow(
      /sync\/manifest\.json:\n {2}- manifest: unknown key "x"/,
    );
  });
});

/**
 * A throwaway checkout of this repo with the files given.
 *
 * @param {Record<string, string>} files
 * @returns {string}
 */
function repo(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

describe('loadManifest', () => {
  it('loads a manifest whose sources exist and whose variants differ', () => {
    const files = [entry({ variants: { sift: { source: 'v.yml', why: 'w' } } })];
    const root = repo({
      'sync/manifest.json': JSON.stringify({
        files,
        unsynced: [{ source: 'u.yml', why: 'w' }],
      }),
      'sync/callers/a.yml': 'a',
      'v.yml': 'b',
      'u.yml': 'u',
    });
    expect(loadManifest(root).files[0].variants.sift.source).toBe('v.yml');
  });

  it('names each source that is not a file, a link or a folder included', () => {
    const root = repo({
      'sync/manifest.json': JSON.stringify({
        files: [entry({ variants: { sift: { source: 'v.yml', why: 'w' } } })],
        unsynced: [{ source: 'u', why: 'w' }],
      }),
      'u/x': 'folder',
    });
    writeFileSync(path.join(root, 'target'), 'x');
    symlinkSync(path.join(root, 'target'), path.join(root, 'v.yml'));
    expect(() => loadManifest(root)).toThrow(
      /files\[0\]\.source "sync\/callers\/a\.yml" is not a file/,
    );
    expect(() => loadManifest(root)).toThrow(/variants\.sift\.source "v\.yml" is not a file/);
    expect(() => loadManifest(root)).toThrow(/unsynced\[0\]\.source "u" is not a file/);
  });

  it('refuses a variant that is the canonical’s bytes', () => {
    const root = repo({
      'sync/manifest.json': JSON.stringify(
        manifest([entry({ variants: { sift: { source: 'v.yml', why: 'w' } } })]),
      ),
      'sync/callers/a.yml': 'same',
      'v.yml': 'same',
    });
    expect(() => loadManifest(root)).toThrow(/"v\.yml" is identical to the canonical/);
  });
});

describe('resolve', () => {
  const loaded = parseManifest(
    JSON.stringify(
      manifest([
        entry({
          variants: { sift: { source: 'v.yml', why: 'sift records in CI' } },
          companions: [{ key: ['a'], value: 'v' }],
        }),
        entry({ path: 'only-fog', source: 'f', apps: ['fog-and-frontier'] }),
      ]),
    ),
  );

  it('lists the files an app holds, with its variant and the reason', () => {
    expect(resolve(loaded, 'sift')).toEqual([
      {
        path: '.github/workflows/a.yml',
        source: 'v.yml',
        why: 'sift records in CI',
        companions: [{ key: ['a'], value: 'v' }],
      },
    ]);
  });

  it('gives another app the canonical, and only its own files', () => {
    expect(resolve(loaded, 'fog-and-frontier').map((r) => [r.path, r.source, r.why])).toEqual([
      ['.github/workflows/a.yml', 'sync/callers/a.yml', undefined],
      ['only-fog', 'f', undefined],
    ]);
    expect(resolve(loaded, 'BoardGames')).toHaveLength(1);
  });

  it('refuses an app it does not know', () => {
    expect(() => resolve(loaded, 'nope')).toThrow(/unknown app "nope"/);
    expect(() => resolve(loaded, '__proto__')).toThrow(/unknown app/);
    expect(APPS).toEqual(all);
  });
});

describe('companionProblem', () => {
  const key = ['autofix', 'exempt', 'PR changes'];

  it('allows a key where the folders are objects or missing, and the key may exist', () => {
    expect(companionProblem({}, key)).toBeNull();
    expect(companionProblem({ autofix: {} }, key)).toBeNull();
    expect(companionProblem({ autofix: { exempt: {} } }, key)).toBeNull();
    expect(companionProblem({ autofix: { exempt: { 'PR changes': 'kept' } } }, key)).toBeNull();
    expect(companionProblem({ other: 1 }, ['top'])).toBeNull();
  });

  it('names the folder that is not an object', () => {
    expect(companionProblem({ autofix: 'on' }, key)).toBe(
      '.github/ci.json: "autofix" is not an object, so "autofix.exempt.PR changes" can\'t be set',
    );
    expect(companionProblem({ autofix: { exempt: [] } }, key)).toMatch(/"autofix\.exempt" is not/);
    expect(companionProblem({ autofix: null }, key)).toMatch(/"autofix" is not an object/);
  });
});
