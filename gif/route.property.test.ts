import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pageFile } from './route.ts';
import { builtPage } from './test-page.ts';

const { parent, dir } = builtPage();

/** Pieces of a path made to escape: dots, encoded slashes, the symlinks out. */
const piece = fc.constantFrom(
  '..',
  '.',
  '%2e%2e',
  '%2E.',
  '%2F',
  '%2f',
  '%5C',
  '\\',
  '/',
  '//',
  '%00',
  '%',
  'up',
  'out.txt',
  'other',
  'in.js',
  'assets',
  'app.js',
  'dist',
  'index.html',
  'sub',
  'secret.txt',
  parent,
  dir,
);

const inside = (file: string) => {
  const relative = path.relative(dir, file);
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
};

describe('pageFile, for any path', () => {
  it('never throws, and never names a file outside the folder', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.array(fc.oneof(piece, fc.string()), { maxLength: 8 }).map((parts) => parts.join('/')),
          fc.array(piece, { maxLength: 8 }).map((parts) => parts.join('')),
          fc.string(),
        ),
        fc.boolean(),
        (tail, rooted) => {
          const found = pageFile(dir, (rooted ? '/' : '') + tail);
          if (found !== null) expect(inside(found.file), found.file).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('finds every file it should, by any spelling of its path that stays inside', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ['index.html'],
          ['assets', 'app.js'],
          ['in.js'],
          ['up', 'dist', 'index.html'],
        ),
        fc.array(fc.constantFrom('.', 'assets/..'), { maxLength: 3 }),
        (parts, noise) => {
          const pathname = '/' + [...noise, ...parts.map(encodeURIComponent)].join('/');
          expect(pageFile(dir, pathname)).not.toBeNull();
        },
      ),
    );
  });
});
