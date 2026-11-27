import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { subjects } from './scope.ts';

describe('subjects', () => {
  it('names only files that exist, each a test-free source with a subject extension', () => {
    const segment = fc.stringMatching(/^[\w.-]{1,8}$/);
    const file = fc
      .tuple(
        fc.array(fc.oneof(segment, fc.constant('__tests__')), { maxLength: 3 }),
        segment,
        fc.constantFrom(
          '.ts',
          '.tsx',
          '.mjs',
          '.js',
          '.test.ts',
          '.test.mjs',
          '.test.tsx',
          '.test.test.ts',
          '',
        ),
      )
      .map(([dirs, name, extension]) => [...dirs, name + extension].join('/'));
    fc.assert(
      fc.property(file, fc.uniqueArray(file), (changed, present) => {
        const exists = (f: string) => present.includes(f);
        const found = subjects(changed, exists);
        if (!/\.test\.[cm]?[jt]sx?$/.test(changed)) {
          expect(found).toEqual([changed]);
          return;
        }
        for (const subject of found) {
          expect(exists(subject)).toBe(true);
          expect(subject).toMatch(/\.(ts|tsx|mjs)$/);
          expect(subject).not.toMatch(/\.test\.[cm]?[jt]sx?$/);
        }
      }),
    );
  });
});
