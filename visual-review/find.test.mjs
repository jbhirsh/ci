import { describe, expect, it } from 'vitest';
import { latestRun, targets } from './find.mjs';

const REPO = 'jbhirsh/app';
const HEAD = 'a'.repeat(40);
const MAIN = 'm'.repeat(40);
const own = { full_name: REPO };

/**
 * A fake API answering by "METHOD route".
 *
 * @param {Record<string, unknown>} routes
 */
const api = (routes) => (/** @type {string} */ method, /** @type {string} */ route) => {
  const key = `${method} ${route}`;
  if (!(key in routes)) throw new Error(`unexpected ${key}`);
  return routes[key];
};
const runs = (/** @type {string} */ sha) =>
  `GET repos/${REPO}/actions/workflows/visual.yml/runs?event=pull_request&head_sha=${sha}&status=completed&per_page=10`;
const pulls = `GET repos/${REPO}/commits/${HEAD}/pulls?per_page=100`;
/**
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown>} [routes]
 * @param {string} [name]
 */
const event = (payload, routes = {}, name = 'workflow_run') => ({
  name,
  payload,
  repo: REPO,
  main: 'main',
  workflow: 'visual.yml',
  api: api(routes),
  log: () => {},
});
const wr = (/** @type {Record<string, unknown>} */ over) => ({
  workflow_run: {
    id: 11,
    event: 'pull_request',
    head_sha: HEAD,
    head_branch: 'x',
    path: '.github/workflows/visual.yml',
    ...over,
  },
});

describe('targets', () => {
  it("reviews a PR's own screenshot run", () => {
    const got = targets(
      event(wr({}), {
        [pulls]: [
          { number: 5, state: 'open', head: { sha: HEAD, repo: own }, base: { ref: 'main' } },
        ],
      }),
    );
    expect(got).toEqual([{ kind: 'pr', number: 5, run: 11 }]);
  });

  it('reviews a PR again from its newest screenshot run when another workflow (the GIFs) finished', () => {
    const got = targets(
      event(wr({ path: '.github/workflows/pr-gif.yml' }), {
        [pulls]: [
          { number: 5, state: 'open', head: { sha: HEAD, repo: own }, base: { ref: 'main' } },
        ],
        [runs(HEAD)]: { workflow_runs: [{ id: 3 }, { id: 9 }] },
      }),
    );
    expect(got).toEqual([{ kind: 'pr', number: 5, run: 9 }]);
  });

  it('finds nothing for a fork, a moved head, or before any screenshot run', () => {
    expect(
      targets(
        event(wr({}), {
          [pulls]: [
            {
              number: 5,
              state: 'open',
              head: { sha: HEAD, repo: { full_name: 'x/y' } },
              base: { ref: 'main' },
            },
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      targets(
        event(wr({ path: '.github/workflows/pr-gif.yml' }), {
          [pulls]: [
            { number: 5, state: 'open', head: { sha: HEAD, repo: own }, base: { ref: 'main' } },
          ],
          [runs(HEAD)]: { workflow_runs: [] },
        }),
      ),
    ).toEqual([]);
  });

  it('reviews a PR again when its description or auto-merge changed', () => {
    const got = targets(
      event(
        {
          pull_request: {
            number: 5,
            state: 'open',
            head: { sha: HEAD, repo: own },
            base: { ref: 'main' },
          },
        },
        { [runs(HEAD)]: { workflow_runs: [{ id: 4 }] } },
        'pull_request_target',
      ),
    );
    expect(got).toEqual([{ kind: 'pr', number: 5, run: 4 }]);
    expect(
      targets(
        event(
          {
            pull_request: {
              number: 5,
              state: 'closed',
              head: { sha: HEAD, repo: own },
              base: { ref: 'main' },
            },
          },
          {},
          'pull_request_target',
        ),
      ),
    ).toEqual([]);
  });

  it('reviews a mockup run by hand on main', () => {
    expect(
      targets(event(wr({ event: 'workflow_dispatch', head_branch: 'main', head_sha: MAIN }))),
    ).toEqual([{ kind: 'issue', run: 11 }]);
  });

  it("settles the PRs and mockups waiting on main's shots of a commit", () => {
    const got = targets(
      event(wr({ event: 'push', head_branch: 'main', head_sha: MAIN }), {
        [`GET repos/${REPO}/pulls?state=open&base=main&per_page=100&page=1`]: [
          { number: 5, head: { sha: HEAD, repo: own }, base: { ref: 'main' } },
          { number: 6, head: { sha: 'b'.repeat(40), repo: own } },
          { number: 7, head: { sha: 'c'.repeat(40), repo: { full_name: 'x/y' } } },
        ],
        [`GET repos/${REPO}/commits/${HEAD}/statuses?per_page=100&page=1`]: [
          {
            id: 1,
            context: 'Visual changes',
            state: 'pending',
            description: `Waiting for main's screenshots of mmmmmmm`,
            creator: { login: 'github-actions[bot]' },
          },
        ],
        [`GET repos/${REPO}/commits/${'b'.repeat(40)}/statuses?per_page=100&page=1`]: [
          {
            id: 2,
            context: 'Visual changes',
            state: 'pending',
            description: `Waiting for main's screenshots of mmmmmmm`,
            creator: { login: 'someone' },
          },
        ],
        [runs(HEAD)]: { workflow_runs: [{ id: 21 }] },
        [`GET repos/${REPO}/actions/workflows/visual.yml/runs?event=workflow_dispatch&head_sha=${MAIN}&status=completed&per_page=20`]:
          { workflow_runs: [{ id: 30 }] },
      }),
    );
    expect(got).toEqual([
      { kind: 'pr', number: 5, run: 21 },
      { kind: 'issue', run: 30 },
    ]);
  });

  it('skips a PR into another branch', () => {
    const into = (/** @type {string} */ ref) => ({
      number: 5,
      state: 'open',
      head: { sha: HEAD, repo: own },
      base: { ref },
    });
    expect(targets(event(wr({}), { [pulls]: [into('release')] }))).toEqual([]);
    expect(targets(event({ pull_request: into('release') }, {}, 'pull_request_target'))).toEqual(
      [],
    );
  });

  it('ignores runs elsewhere, and refuses an event it was not made for', () => {
    expect(targets(event(wr({ event: 'push', head_branch: 'feature' })))).toEqual([]);
    expect(targets(event(wr({ event: 'schedule', head_branch: 'main' })))).toEqual([]);
    expect(() => targets(event({}, {}, 'push'))).toThrow(/doesn't run on push/);
  });
});

describe('latestRun', () => {
  it('is null with no finished run', () => {
    expect(latestRun(api({ [runs(HEAD)]: {} }), REPO, 'visual.yml', HEAD)).toBeNull();
  });
});

describe('main', () => {
  it("reads the event and the app's settings, and writes the matrix", async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { main } = await import('./find.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'app-'));
    mkdirSync(path.join(root, '.github'));
    writeFileSync(
      path.join(root, '.github/ci.json'),
      JSON.stringify({ 'visual-review': { workflow: 'visual.yml', job: 'v', folders: ['f'] } }),
    );
    const file = path.join(root, 'event.json');
    writeFileSync(file, JSON.stringify(wr({ event: 'workflow_dispatch', head_branch: 'main' })));
    process.env.APP_ROOT = root;
    try {
      expect(
        main(
          { GITHUB_EVENT_PATH: file, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: REPO },
          api({}),
        ),
      ).toEqual([{ kind: 'issue', run: 11 }]);
      process.env.APP_ROOT = tmpdir();
      expect(() => main({}, api({}))).toThrow(/no visual-review key/);
    } finally {
      delete process.env.APP_ROOT;
    }
  });
});
