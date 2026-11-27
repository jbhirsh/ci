import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mockupMayChange, settings } from '../visual-review/settings.ts';
import { decodePatch, parseManifest, patchProblem } from './shots.mjs';

const s = /** @type {import('../visual-review/settings.ts').Settings} */ (
  settings({ workflow: 'v.yml', job: 'v', folders: ['f'], mockupPaths: ['src/**', 'public/**'] })
);
const segment = fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/);
const repoPath = fc.array(segment, { minLength: 1, maxLength: 5 }).map((p) => p.join('/'));

describe('parseManifest, for any JSON', () => {
  it('either refuses it plainly or returns a checked manifest', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        let m;
        try {
          m = parseManifest(value);
        } catch (error) {
          expect(String(error)).toMatch(/isn't one visual-shots wrote/);
          return;
        }
        expect(m.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(m.base).toMatch(/^[0-9a-f]{40}$/);
      }),
    );
  });
});

describe('patchProblem, for any paths', () => {
  it('never lets through a path outside mockupPaths, or a lockfile', () => {
    fc.assert(
      fc.property(fc.array(repoPath, { minLength: 1, maxLength: 6 }), (files) => {
        const problem = patchProblem({ files, summary: '', s });
        if (problem === null) {
          for (const f of files) expect(mockupMayChange(f, s)).toBe(true);
        }
        if (files.some((f) => f.endsWith('package-lock.json'))) expect(problem).not.toBeNull();
      }),
    );
  });
});

describe('decodePatch, for any text', () => {
  it('decodes or refuses with a message, never anything else', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        try {
          expect(decodePatch(text)).toBeInstanceOf(Buffer);
        } catch (error) {
          expect(String(error)).toMatch(/mockup_patch/);
        }
      }),
    );
  });
});
