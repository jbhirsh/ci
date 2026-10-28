import { describe, expect, it } from 'vitest';
import { decide, enable } from './enable.mjs';

const PR = {
  state: 'OPEN',
  author: { login: 'app/dependabot' },
  headRefName: 'dependabot/npm_and_yarn/all-updates-123',
  autoMergeRequest: null,
};

describe('decide', () => {
  it("turns auto-merge on for Dependabot's open npm PR that never had it", () => {
    expect(decide(PR, ['labeled', 'committed'])).toEqual({
      enable: true,
      reason: 'turning auto-merge on',
    });
    expect(decide({ ...PR, author: { login: 'dependabot[bot]' } }, []).enable).toBe(true);
  });

  it.each([
    [{ ...PR, state: 'MERGED' }, [], /not open/],
    [{ ...PR, author: { login: 'jbhirsh' } }, [], /not a Dependabot PR/],
    [{ ...PR, headRefName: 'dependabot/github_actions/x' }, [], /not an npm bump/],
    [{ ...PR, autoMergeRequest: { mergeMethod: 'REBASE' } }, [], /already on/],
    [PR, ['auto_merge_enabled', 'auto_merge_disabled'], /set on it before/],
    [PR, ['auto_merge_disabled'], /set on it before/],
    [PR, ['auto_merge_enabled'], /set on it before/],
  ])('leaves %o alone', (pr, events, reason) => {
    const verdict = decide(pr, events);
    expect(verdict.enable).toBe(false);
    expect(verdict.reason).toMatch(reason);
  });
});

/**
 * A stand-in gh: answers from `responses` by the command's first two words,
 * recording every call.
 *
 * @param {Record<string, string>} responses
 * @param {string[][]} calls
 */
const fakeGh = (responses, calls) => (/** @type {string[]} */ args) => {
  calls.push(args);
  return responses[args.slice(0, 2).join(' ')] ?? '';
};

describe('enable', () => {
  const env = { GITHUB_REPOSITORY: 'jbhirsh/sift', PR_NUMBER: '208' };

  it('turns auto-merge on, by rebase, when the PR qualifies', () => {
    /** @type {string[][]} */
    const calls = [];
    const gh = fakeGh(
      { 'pr view': JSON.stringify(PR), 'api repos/jbhirsh/sift/issues/208/timeline': '' },
      calls,
    );
    expect(enable(env, gh)).toBe('#208: turning auto-merge on');
    expect(calls.at(-1)).toEqual([
      'pr',
      'merge',
      '208',
      '--repo',
      'jbhirsh/sift',
      '--auto',
      '--rebase',
    ]);
  });

  it('leaves auto-merge alone once it was ever set', () => {
    /** @type {string[][]} */
    const calls = [];
    const gh = fakeGh(
      {
        'pr view': JSON.stringify(PR),
        'api repos/jbhirsh/sift/issues/208/timeline': 'auto_merge_enabled\nauto_merge_disabled\n',
      },
      calls,
    );
    expect(enable(env, gh)).toMatch(/set on it before/);
    expect(calls.some((args) => args[1] === 'merge')).toBe(false);
  });

  it("finds the PR by the run's branch when the run names none", () => {
    /** @type {string[][]} */
    const calls = [];
    const gh = fakeGh({ 'pr list': '7\n', 'pr view': JSON.stringify(PR) }, calls);
    expect(enable({ GITHUB_REPOSITORY: 'jbhirsh/sift', HEAD_BRANCH: PR.headRefName }, gh)).toBe(
      '#7: turning auto-merge on',
    );
    expect(calls[0]).toEqual(expect.arrayContaining(['--head', PR.headRefName]));
  });

  it('does nothing without a PR, and needs the repository', () => {
    expect(enable({ GITHUB_REPOSITORY: 'a/b' }, () => '')).toBe('no open PR for this run');
    expect(enable({ GITHUB_REPOSITORY: 'a/b', HEAD_BRANCH: 'x' }, () => '\n')).toBe(
      'no open PR for this run',
    );
    expect(() => enable({}, () => '')).toThrow(/GITHUB_REPOSITORY/);
  });
});
