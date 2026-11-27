import { describe, expect, it } from 'vitest';
import { pullOfRun } from './run-pr.ts';

const REPO = 'jbhirsh/app';
const SHA = 'a'.repeat(40);
const run = { head_sha: SHA, event: 'pull_request' };
/**
 * @param {number} number
 * @param {Partial<{ state: string, sha: string, repo: string | null }>} [over]
 */
const pr = (number, { state = 'open', sha = SHA, repo = REPO } = {}) => ({
  number,
  state,
  head: { sha, repo: repo ? { full_name: repo } : null },
});
/** @param {unknown} answer */
const api = (answer) => () => answer;

describe('pullOfRun', () => {
  it('finds the open same-repository PR whose head is the run', () => {
    const got = pullOfRun(run, REPO, api([pr(1, { state: 'closed' }), pr(2)]));
    expect(got).toEqual({ pull: pr(2) });
  });

  it('says why there is none: moved on, a fork, or nothing', () => {
    expect(pullOfRun(run, REPO, api([pr(3, { sha: 'b'.repeat(40) })]))).toEqual({
      why: "#3's head has moved on from aaaaaaa",
    });
    expect(pullOfRun(run, REPO, api([pr(4, { repo: 'someone/app' })]))).toEqual({
      why: "#4 is a fork's PR",
    });
    expect(pullOfRun(run, REPO, api([pr(5, { repo: null })]))).toEqual({
      why: "#5 is a fork's PR",
    });
    expect(pullOfRun(run, REPO, api([]))).toEqual({ why: 'no open PR has aaaaaaa' });
  });

  it('refuses an answer that is not a list', () => {
    expect(() => pullOfRun(run, REPO, api({}))).toThrow(/expected a list/);
  });
});
