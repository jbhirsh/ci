import { describe, expect, it } from 'vitest';
import { loadConfig, onlyKnownKeys, readAppFile, stringList } from './config.mjs';
import { testApp, writeFiles } from './testApp.mjs';

describe('readAppFile', () => {
  it('reads the working tree without a ref, and the ref with one', () => {
    const root = testApp({ 'a.md': 'committed' });
    writeFiles(root, { 'a.md': 'edited' });
    expect(readAppFile('a.md', { root })).toBe('edited');
    expect(readAppFile('a.md', { root, ref: 'origin/main' })).toBe('committed');
  });
  it('is null for a file that is not there', () => {
    const root = testApp({});
    expect(readAppFile('nope.md', { root })).toBeNull();
    expect(readAppFile('nope.md', { root, ref: 'origin/main' })).toBeNull();
    expect(readAppFile('package.json', { root, ref: 'origin/gone' })).toBeNull();
  });
});

describe('loadConfig', () => {
  it("reads the tool's key from the ref, not from the PR's edit", () => {
    const root = testApp({ '.github/ci.json': '{"review": {"skip": ["a/**"]}}' });
    writeFiles(root, { '.github/ci.json': '{"review": {"skip": ["evil/**"]}}' });
    expect(loadConfig('review', { root, ref: 'origin/main' })).toEqual({ skip: ['a/**'] });
    expect(loadConfig('review', { root })).toEqual({ skip: ['evil/**'] });
  });
  it('is empty when the ref has no ci.json or no key', () => {
    expect(loadConfig('review', { root: testApp({}), ref: 'origin/main' })).toEqual({});
    const root = testApp({ '.github/ci.json': '{"mutation": {}}' });
    expect(loadConfig('review', { root, ref: 'origin/main' })).toEqual({});
  });
});

describe('onlyKnownKeys', () => {
  it('names a key the tool does not read', () => {
    expect(() => onlyKnownKeys('review', { skip: [] }, ['skip'])).not.toThrow();
    expect(() => onlyKnownKeys('review', { skp: [] }, ['skip'])).toThrow(
      '"review.skp" is not a setting (skip)',
    );
  });
});

describe('stringList', () => {
  it('takes a list of strings, or the default', () => {
    expect(stringList('x', undefined, ['d'])).toEqual(['d']);
    expect(stringList('x', ['a', 'b'], [])).toEqual(['a', 'b']);
  });
  it('refuses anything else', () => {
    for (const bad of ['a', [1], [''], ['  '], null, {}]) {
      expect(() => stringList('review.skip', bad, [])).toThrow('"review.skip" must be a list');
    }
  });
});
