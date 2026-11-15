import { describe, expect, it } from 'vitest';
import { SECTION, uploadMarker } from './describe.mjs';
import { gitHubIo, main } from './run.mjs';

const REPO = 'jbhirsh/app';
const A = 'a'.repeat(40);

/**
 * A fake REST API.
 *
 * @param {Record<string, unknown>} routes answers by "METHOD route"
 */
function fakeApi(routes) {
  /** @type {{ method: string, route: string, body?: unknown }[]} */
  const calls = [];
  /** @type {import('../lib/comment.mjs').Api} */
  const api = (method, route, body) => {
    calls.push({ method, route, body });
    const key = `${method} ${route}`;
    if (!(key in routes)) throw new Error(`unexpected ${key}`);
    return routes[key];
  };
  return { api, calls };
}

const upload = {
  id: 7,
  node_id: 'N7',
  user: { login: 'jbhirsh' },
  body: `${uploadMarker('visual-review', A)}\n${SECTION}\ntable`,
};

describe('gitHubIo', () => {
  it("reads a PR's description and comments, and writes the description", () => {
    const { api, calls } = fakeApi({
      [`GET repos/${REPO}/issues/5`]: { body: 'Mine.', pull_request: {} },
      [`GET repos/${REPO}/issues/5/comments?per_page=100&page=1`]: [upload],
      [`PATCH repos/${REPO}/issues/5`]: {},
    });
    const io = gitHubIo({
      api,
      repo: REPO,
      number: 5,
      hide: () => {},
      log: () => {},
    });
    expect(io.body()).toBe('Mine.');
    expect(io.comments()).toEqual([upload]);
    io.write('new');
    expect(calls.at(-1)).toEqual({
      method: 'PATCH',
      route: `repos/${REPO}/issues/5`,
      body: { body: 'new' },
    });
  });

  it('refuses an answer that is not a list', () => {
    const { api } = fakeApi({ [`GET repos/${REPO}/issues/5/comments?per_page=100&page=1`]: {} });
    const io = gitHubIo({ api, repo: REPO, number: 5, hide: () => {}, log: () => {} });
    expect(() => io.comments()).toThrow(/expected a list/);
  });
});

describe('main', () => {
  it('checks its environment', () => {
    expect(() => main({ GITHUB_REPOSITORY: REPO, NUMBER: '0', BOT_LOGIN: 'x' })).toThrow(/needs/);
    expect(() => main({ GITHUB_REPOSITORY: 'bad repo', NUMBER: '1', BOT_LOGIN: 'x' })).toThrow(
      /needs/,
    );
    expect(() => main({ GITHUB_REPOSITORY: REPO, NUMBER: '1' })).toThrow(/needs/);
  });
});
