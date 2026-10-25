import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { filesToRead, globToRegExp, plainWords, unreadFiles } from './coverage.mjs';

// Commands, paths and globs come from a model's tool calls, a PR's file
// list and an app's settings: anything at all.
const safeWord = fc.stringMatching(/^[A-Za-z0-9/._=:-]{1,12}$/);
const path = fc.stringMatching(/^[A-Za-z0-9_.-]{1,8}(\/[A-Za-z0-9_.-]{1,8}){0,3}$/);

describe('plainWords', () => {
  it('never throws, and gives null or a list of words', () => {
    fc.assert(
      fc.property(fc.string(), (command) => {
        const words = plainWords(command);
        expect(words === null || words.every((w) => typeof w === 'string')).toBe(true);
      }),
    );
  });

  it('reads back plain words joined by spaces', () => {
    fc.assert(
      fc.property(fc.array(safeWord, { minLength: 1, maxLength: 8 }), (words) => {
        fc.pre(words[0] !== 'cd');
        expect(plainWords(words.join(' '))).toEqual(words);
      }),
    );
  });

  it('turns away any command holding a pipe, chain or substitution outside quotes', () => {
    fc.assert(
      fc.property(
        safeWord,
        fc.constantFrom('|', ';', '&', '>', '<', '`', '$', '\n'),
        safeWord,
        (a, op, b) => {
          expect(plainWords(`git diff ${a} ${op} ${b}`)).toBeNull();
        },
      ),
    );
  });
});

describe('globToRegExp', () => {
  it('never throws, and a glob with no wildcard matches only itself', () => {
    fc.assert(
      fc.property(fc.string(), (glob) => {
        const re = globToRegExp(glob);
        if (!/[*?]/.test(glob)) {
          expect(re.test(glob)).toBe(true);
          expect(re.test(`${glob}x`)).toBe(false);
        }
      }),
    );
  });

  it('`dir/**` matches every path under the folder', () => {
    fc.assert(
      fc.property(path, path, (dir, rest) => {
        expect(globToRegExp(`${dir}/**`).test(`${dir}/${rest}`)).toBe(true);
      }),
    );
  });
});

describe('filesToRead and unreadFiles', () => {
  it('keep a subset of the changed files, in order, and never a lockfile', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(path, fc.constant('package-lock.json'))), (files) => {
        const kept = filesToRead(files);
        expect(kept.every((f) => files.includes(f) && f !== 'package-lock.json')).toBe(true);
        expect(kept).toEqual(files.filter((f) => kept.includes(f)));
      }),
    );
  });

  it('a whole PR diff reads every file; no calls read none', () => {
    fc.assert(
      fc.property(fc.uniqueArray(path), (files) => {
        const all = [
          { name: 'Bash', input: { command: 'git diff origin/main...HEAD' }, result: '' },
        ];
        expect(unreadFiles(files, all, { repoDir: '/r' })).toEqual([]);
        expect(unreadFiles(files, [], { repoDir: '/r' })).toEqual(filesToRead(files));
      }),
    );
  });
});
