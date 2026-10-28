import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { matchingFolders } from './baselines.mjs';
import { isShotName, settings, singleFolder } from './settings.mjs';

// An app's `visual-baselines` setting is whatever its ci.json holds.
const json = fc.jsonValue({ maxDepth: 4 });

describe('settings, for any JSON', () => {
  it('either refuses it with a ci.json message or returns settings that hold', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), json), (config) => {
        let s;
        try {
          s = settings(config);
        } catch (error) {
          expect(String(error)).toMatch(/\.github\/ci\.json: visual-baselines/);
          return;
        }
        expect(s.folders.length).toBeGreaterThan(0);
        for (const folder of s.folders) {
          expect(folder.startsWith('/') || folder.split('/').includes('..')).toBe(false);
        }
        expect(s.ratio >= 0 && s.ratio < 1).toBe(true);
        if (s.artifact) expect(s.artifact.workflow).toMatch(/\.ya?ml$/);
      }),
    );
  });

  it('keeps the one folder a comparison uses inside the checkout', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (folder) => {
        let one;
        try {
          one = singleFolder(settings({ folders: [folder] }));
        } catch {
          return;
        }
        expect(path.posix.normalize(one).startsWith('..')).toBe(false);
        expect(path.isAbsolute(one)).toBe(false);
      }),
    );
  });
});

describe('isShotName, for any name', () => {
  it('passes only a bare PNG name, which stays in its folder', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        if (!isShotName(name)) return;
        expect(name.endsWith('.png')).toBe(true);
        expect(name.includes('/') || name.includes('\\') || name.startsWith('.')).toBe(false);
        expect(path.posix.join('shots', name).startsWith('shots/')).toBe(true);
      }),
    );
  });
});

describe('matchingFolders, for any paths', () => {
  const segment = fc.stringMatching(/^[a-z0-9._-]{1,6}$/);
  const file = fc.array(segment, { minLength: 1, maxLength: 4 }).map((s) => s.join('/'));

  it('returns sorted, distinct ancestors of the files that match a glob', () => {
    fc.assert(
      fc.property(fc.array(file), fc.array(segment, { maxLength: 2 }), (files, globs) => {
        const folders = matchingFolders(files, globs);
        expect([...folders].sort()).toEqual(folders);
        expect(new Set(folders).size).toBe(folders.length);
        for (const folder of folders) {
          expect(files.some((f) => f.startsWith(`${folder}/`))).toBe(true);
          expect(globs.some((g) => path.posix.matchesGlob(folder, g))).toBe(true);
        }
      }),
    );
  });
});
