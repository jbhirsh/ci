import { describe, expect, it } from 'vitest';
import { fakeFetch } from './fakeFetch.mjs';
import { allByBots, main } from './skip.mjs';

const dependabot = { author: { login: 'dependabot[bot]' } };
const claude = { author: { login: 'claude[bot]' } };

describe('allByBots', () => {
  it('is true only when every commit is one of the bots', () => {
    expect(allByBots([dependabot, dependabot], ['dependabot[bot]'])).toBe(true);
    expect(allByBots([dependabot, claude], ['dependabot[bot]'])).toBe(false);
    expect(allByBots([dependabot], ['Dependabot[bot]'])).toBe(true);
  });
  it("falls back to the committer, and counts a commit with neither as a person's", () => {
    expect(
      allByBots([{ author: null, committer: { login: 'dependabot[bot]' } }], ['dependabot[bot]']),
    ).toBe(true);
    expect(allByBots([{ author: null, committer: null }], ['dependabot[bot]'])).toBe(false);
    expect(allByBots([null, 'x'], ['dependabot[bot]'])).toBe(false);
  });
  it('is false with no bots or no commits', () => {
    expect(allByBots([dependabot], [])).toBe(false);
    expect(allByBots([], ['dependabot[bot]'])).toBe(false);
  });
});

describe('main', () => {
  const env = { REPO: 'o/r', PR: '5', GH_TOKEN: 't' };
  const commits = 'GET https://api.github.com/repos/o/r/pulls/5/commits?per_page=100';
  const pull = 'GET https://api.github.com/repos/o/r/pulls/5';

  it("skips a bot's own PR when every commit is a bot's", async () => {
    const fetchImpl = fakeFetch({
      [pull]: [200, { user: { login: 'dependabot[bot]' } }],
      [commits]: [200, [dependabot]],
    });
    expect(await main({ ...env, BOTS: 'dependabot[bot]\n' }, fetchImpl)).toBe(true);
  });
  it("reviews a person's PR whose commits claim to be a bot's", async () => {
    const fetchImpl = fakeFetch({
      [pull]: [200, { user: { login: 'mallory' } }],
      [commits]: [200, [dependabot]],
    });
    expect(await main({ ...env, BOTS: 'dependabot[bot]' }, fetchImpl)).toBe(false);
  });
  it('asks GitHub nothing with no bots, and needs the PR', async () => {
    expect(await main({ ...env, BOTS: '' }, fakeFetch({}))).toBe(false);
    await expect(main({ BOTS: 'x' }, fakeFetch({}))).rejects.toThrow('REPO and PR must be set');
  });
});
