import { describe, expect, it } from 'vitest';
import { isReason, notes } from './reason.mjs';

describe('isReason', () => {
  it('takes a few words', () => {
    expect(isReason('TS 7 has no JS API')).toBe(true);
    expect(isReason('Apollo does not accept graphql 17 yet')).toBe(true);
  });

  it('turns away a version label, a commit or a word or two', () => {
    for (const text of [
      'v2.9.0',
      ' v7.0.11',
      'e7477775783ea5526144ba13e8db5eec57747ce8 v2',
      'pinned',
      'keep it',
      '',
    ]) {
      expect(isReason(text)).toBe(false);
    }
  });
});

describe('notes', () => {
  it('reads a string or a list of strings', () => {
    expect(notes('a')).toEqual(['a']);
    expect(notes(['a', 1, 'b'])).toEqual(['a', 'b']);
    expect(notes(undefined)).toEqual([]);
    expect(notes({ a: 'b' })).toEqual([]);
  });
});
