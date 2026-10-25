import { describe, expect, it } from 'vitest';
import { reviewSettings } from './settings.mjs';
import { testApp } from './testApp.mjs';

describe('reviewSettings', () => {
  it('defaults to no guide and no skip globs', () => {
    expect(reviewSettings({ root: testApp({}) })).toEqual({
      instructions: null,
      guide: '',
      skip: [],
    });
  });
  it('reads the guide the settings name, trimmed', () => {
    const root = testApp({
      '.github/ci.json': JSON.stringify({
        review: { instructions: '.github/claude-review.md', skip: ['src/gql/**'] },
      }),
      '.github/claude-review.md': '\n## Auth\n\nGates.\n\n',
    });
    for (const ref of [undefined, 'origin/main']) {
      expect(reviewSettings({ root, ref })).toEqual({
        instructions: '.github/claude-review.md',
        guide: '## Auth\n\nGates.',
        skip: ['src/gql/**'],
      });
    }
  });
  it('fails on a guide that is missing, a bad path or an unknown key', () => {
    const missing = testApp({ '.github/ci.json': '{"review": {"instructions": "x.md"}}' });
    expect(() => reviewSettings({ root: missing })).toThrow(
      "x.md, which the checkout doesn't hold",
    );
    expect(() => reviewSettings({ root: missing, ref: 'origin/main' })).toThrow(
      "x.md, which origin/main doesn't hold",
    );
    const bad = testApp({ '.github/ci.json': '{"review": {"instructions": 3}}' });
    expect(() => reviewSettings({ root: bad })).toThrow('must be a file path');
    const typo = testApp({ '.github/ci.json': '{"review": {"guide": "x.md"}}' });
    expect(() => reviewSettings({ root: typo })).toThrow('"review.guide" is not a setting');
  });
});
