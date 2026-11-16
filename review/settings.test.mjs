import { describe, expect, it } from 'vitest';
import { reviewSettings } from './settings.mjs';
import { testApp } from './testApp.mjs';

describe('reviewSettings', () => {
  it('defaults to no guide and no skip globs', () => {
    expect(reviewSettings({ root: testApp({}) })).toEqual({
      instructions: null,
      guide: '',
      skip: [],
      engine: 'action',
      advisor: null,
      skipBots: [],
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
        engine: 'action',
        advisor: null,
        skipBots: [],
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
  it('reads the engine, the advisor and the bots to skip', () => {
    const root = testApp({
      '.github/ci.json': JSON.stringify({
        review: { engine: 'sdk', advisor: 'opus', skipBots: ['dependabot[bot]'] },
      }),
    });
    expect(reviewSettings({ root })).toMatchObject({
      engine: 'sdk',
      advisor: 'opus',
      skipBots: ['dependabot[bot]'],
    });
    const off = testApp({ '.github/ci.json': '{"review": {"engine": "sdk", "advisor": null}}' });
    expect(reviewSettings({ root: off }).advisor).toBeNull();
  });
  it('fails on an unknown engine, a bad advisor or bad bots', () => {
    /** @param {unknown} review */
    const with_ = (review) => testApp({ '.github/ci.json': JSON.stringify({ review }) });
    expect(() => reviewSettings({ root: with_({ engine: 'managed' }) })).toThrow(
      '"review.engine" must be one of action, sdk',
    );
    for (const advisor of ['', 'Opus 5', 3, ['opus']]) {
      expect(() => reviewSettings({ root: with_({ advisor }) })).toThrow('"review.advisor"');
    }
    expect(() => reviewSettings({ root: with_({ skipBots: 'dependabot[bot]' }) })).toThrow(
      '"review.skipBots" must be a list',
    );
  });
});
