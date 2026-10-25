import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_IGNORE, DEFAULT_SHOWS, isShotName, settings } from './settings.mjs';

describe('settings', () => {
  it('fills in the defaults', () => {
    expect(settings({})).toEqual({
      dir: 'docs/screenshots',
      shows: DEFAULT_SHOWS,
      ignore: DEFAULT_IGNORE,
      source: 'a fresh capture of the app',
    });
  });

  it('takes what the app sets, a trailing slash aside', () => {
    expect(settings({ dir: 'img/', shows: ['src/**'], ignore: [], source: 'x' })).toEqual({
      dir: 'img',
      shows: ['src/**'],
      ignore: [],
      source: 'x',
    });
  });

  it.each([{ dir: '' }, { dir: '/abs' }, { dir: 'a/../..' }, { dir: 3 }])(
    'refuses a folder outside the checkout: %j',
    (config) => {
      expect(() => settings(config)).toThrow('dir must be a folder in the checkout');
    },
  );

  it('refuses a source that is not text, and globs that are not a list', () => {
    expect(() => settings({ source: '' })).toThrow('source must be text');
    expect(() => settings({ shows: 'src' })).toThrow('readme-screenshots.shows must be a list');
  });
});

describe('isShotName', () => {
  it('takes a PNG name and nothing with a path', () => {
    expect(isShotName('home-split.png')).toBe(true);
    expect(isShotName('a_b.c.png')).toBe(true);
    expect(isShotName('../x.png')).toBe(false);
    expect(isShotName('a/b.png')).toBe(false);
    expect(isShotName('.hidden.png')).toBe(false);
    expect(isShotName('x.jpg')).toBe(false);
  });

  it('never takes a name with a slash, for any input', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        if (isShotName(name)) expect(/[/\\]/.test(name) || name.startsWith('.')).toBe(false);
      }),
    );
  });
});
