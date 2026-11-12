import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { globList, matchesAny, pick } from './match.mjs';

describe('globList', () => {
  it('takes a list of globs, or the fallback when absent', () => {
    expect(globList(['src/**'], 'x', [])).toEqual(['src/**']);
    expect(globList(undefined, 'x', ['a'])).toEqual(['a']);
  });

  it.each([['src/**'], [[1]], [['']], [null]])('refuses %j', (value) => {
    expect(() => globList(value, 'visuals.ui', [])).toThrow('visuals.ui must be a list of globs');
  });
});

describe('matchesAny', () => {
  it('matches segments, any depth, and alternatives', () => {
    expect(matchesAny('src/a/b/C.tsx', ['src/**/*.{ts,tsx}'])).toBe(true);
    expect(matchesAny('src/C.tsx', ['src/**/*.tsx'])).toBe(true);
    expect(matchesAny('src/fooClasses.ts', ['src/**/*Classes.ts'])).toBe(true);
    expect(matchesAny('index.html', ['index.html'])).toBe(true);
    expect(matchesAny('api/x.ts', ['src/**'])).toBe(false);
  });

  it('needs a dot segment named outright', () => {
    expect(matchesAny('.github/x.mjs', ['**/*.mjs'])).toBe(false);
    expect(matchesAny('.github/x.mjs', ['.github/*.mjs'])).toBe(true);
  });
});

describe('pick', () => {
  it('keeps what matches include and not exclude, in order', () => {
    expect(
      pick(['src/b.tsx', 'src/a.test.tsx', 'api/c.ts', 'src/a.css'], {
        include: ['src/**/*.{tsx,css}'],
        exclude: ['**/*.test.*'],
      }),
    ).toEqual(['src/b.tsx', 'src/a.css']);
  });

  it('only ever narrows the list, keeping its order', () => {
    const file = fc.stringMatching(/^[a-z]{1,4}(\/[a-z.]{1,6}){0,3}$/);
    fc.assert(
      fc.property(fc.array(file), (files) => {
        const picked = pick(files, { include: ['**'], exclude: ['**/*.md'] });
        expect(files.filter((f) => picked.includes(f))).toEqual(picked);
        expect(picked.every((f) => !f.endsWith('.md'))).toBe(true);
      }),
    );
  });
});
