import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REVIEW_MARKER, countThreads, counts } from './threads.mjs';

/**
 * @param {string} typename
 * @param {string} login
 * @param {string} [body]
 * @param {boolean} [isResolved]
 */
const thread = (typename, login, body = 'Fix this.', isResolved = false) => ({
  isResolved,
  comments: { nodes: [{ body, author: { __typename: typename, login } }] },
});

describe('counts', () => {
  it("counts Claude Review's threads, claude[bot]'s and marked ones, and the owner's", () => {
    expect(counts(thread('Bot', 'claude'), 'jb')).toBe(true);
    expect(counts(thread('Bot', 'github-actions', `Bug.\n\n${REVIEW_MARKER}`), 'jb')).toBe(true);
    expect(counts(thread('User', 'jb'), 'jb')).toBe(true);
  });
  it("leaves out everyone else's, an unmarked github-actions[bot] one, and resolved ones", () => {
    expect(counts(thread('User', 'stranger'), 'jb')).toBe(false);
    expect(counts(thread('Bot', 'github-actions', 'Job report'), 'jb')).toBe(false);
    expect(counts(thread('Bot', 'jb'), 'jb')).toBe(false);
    expect(counts(thread('User', 'claude', REVIEW_MARKER), 'jb')).toBe(false);
    expect(counts(thread('Bot', 'claude', 'x', true), 'jb')).toBe(false);
    expect(counts({ isResolved: false, comments: { nodes: [] } }, 'jb')).toBe(false);
    expect(counts(null, 'jb')).toBe(false);
  });
});

describe('countThreads', () => {
  it('counts the threads of a page that count', () => {
    const page = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [thread('Bot', 'claude'), thread('User', 'x'), thread('User', 'jb')],
            },
          },
        },
      },
    };
    expect(countThreads(page, 'jb')).toBe(2);
    expect(countThreads({}, 'jb')).toBe(0);
  });
  it('never throws, and never counts a stranger, for any page', () => {
    fc.assert(
      fc.property(fc.anything(), fc.string(), (page, body) => {
        expect(countThreads(page, 'jb')).toBeGreaterThanOrEqual(0);
        expect(counts(thread('User', 'mallory', body), 'jb')).toBe(false);
      }),
    );
  });
});
