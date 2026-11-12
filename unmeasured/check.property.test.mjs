import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classify, isSource, measuredFiles, readEntries } from './check.mjs';

const segment = fc.stringMatching(/^[A-Za-z0-9._ -]{1,8}$/).filter((s) => s !== '.' && s !== '..');
const repoPath = fc
  .array(segment, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join('/'))
  .chain((dir) =>
    fc.constantFrom('.ts', '.tsx', '.mjs', '.test.ts', '.d.ts', '.md').map((ext) => dir + ext),
  );
const glob = fc.oneof(
  repoPath,
  segment.map((s) => `${s}/**`),
  fc.constantFrom('**/*.ts', 'src/**', '*.mjs', '**', '[', '{a,b}/*'),
);

// A report key as a test runner might write it: inside the root, relative,
// or reaching out of it.
const key = fc
  .tuple(fc.constantFrom('', '/r/app/', '../', '/', './'), fc.string())
  .map(([prefix, rest]) => prefix + rest);

describe('measuredFiles', () => {
  it('never throws, and never yields a path outside the root', () => {
    fc.assert(
      fc.property(fc.dictionary(key, fc.constant({})), (report) => {
        for (const file of measuredFiles(report, '/r/app')) {
          expect(file === '' || path.isAbsolute(file)).toBe(false);
          expect(path.relative('/r/app', path.resolve('/r/app', file)).split(path.sep)[0]).not.toBe(
            '..',
          );
        }
      }),
    );
  });
});

describe('readEntries', () => {
  it('never throws on a list of strings, and keeps or rejects each entry', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (files) => {
        const { entries, malformed } = readEntries({ files });
        expect(entries.length + malformed.length).toBe(files.length);
      }),
    );
  });
});

describe('classify', () => {
  it('puts every source file in exactly one group, and finds a glob stale exactly when it matches nothing unmeasured', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(repoPath, { maxLength: 15 }),
        fc.func(fc.boolean()),
        fc.array(glob, { maxLength: 4 }),
        (tracked, isMeasured, globs) => {
          const measured = new Set(tracked.filter((f) => isMeasured(f)));
          const entries = globs.map((g) => ({ glob: g, text: `${g}: some reason here` }));
          const result = classify(tracked, measured, entries);
          const sources = tracked.filter(isSource);
          const groups = [...result.measured, ...result.listed, ...result.unmeasured];
          expect(groups.sort()).toEqual([...sources].sort());
          expect(new Set(groups).size).toBe(groups.length);
          const missing = sources.filter((f) => !measured.has(f));
          for (const entry of entries) {
            const matchesMissing = missing.some((f) => path.posix.matchesGlob(f, entry.glob));
            expect(result.stale.includes(entry)).toBe(!matchesMissing);
          }
        },
      ),
    );
  });
});
