import { describe, expect, it } from 'vitest';
import { downloadShots, latestRun, mockupIssue, ownEdit, targets } from './find.ts';

const REPO = 'jbhirsh/app';
const HEAD = 'a'.repeat(40);
const MAIN = 'm'.repeat(40);
const own = { full_name: REPO };

/**
 * A fake API answering by "METHOD route".
 */
const api = (routes: Record<string, unknown>) => (method: string, route: string) => {
  const key = `${method} ${route}`;
  if (!(key in routes)) throw new Error(`unexpected ${key}`);
  return routes[key];
};
const runs = (sha: string) =>
  `GET repos/${REPO}/actions/workflows/visual.yml/runs?event=pull_request&head_sha=${sha}&status=completed&per_page=10`;
const pulls = `GET repos/${REPO}/commits/${HEAD}/pulls?per_page=100`;
const event = (
  payload: Record<string, unknown>,
  routes: Record<string, unknown> = {},
  name = 'workflow_run',
) => ({
  name,
  payload,
  repo: REPO,
  main: 'main',
  workflow: 'visual.yml',
  api: api(routes),
  log: () => {},
  // Run 12's shots are no mockup's; every other run by hand's are #9's.
  mockupIssue: (run: number) => (run === 12 ? null : 9),
});
const wr = (over: Record<string, unknown>) => ({
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
    ).toEqual([{ kind: 'issue', number: 9, run: 11 }]);
    expect(
      targets(
        event(wr({ id: 12, event: 'workflow_dispatch', head_branch: 'main', head_sha: MAIN })),
      ),
    ).toEqual([]);
    const logs: string[] = [];
    const broken = {
      ...event(wr({ id: 13, event: 'workflow_dispatch', head_branch: 'main', head_sha: MAIN })),
      log: (l: string) => logs.push(l),
      mockupIssue: () => {
        throw new Error('no visual-shots.json');
      },
    };
    expect(targets(broken)).toEqual([]);
    expect(logs[0]).toMatch(
      /run 13: its shots' manifest couldn't be read \(no visual-shots.json\)/,
    );
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
      { kind: 'issue', number: 9, run: 30 },
    ]);
  });

  it('skips a PR into another branch', () => {
    const into = (ref: string) => ({
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

describe('ownEdit', () => {
  const block = (inner: string) =>
    `<!-- describe:visual-review -->\n${inner}\n<!-- /describe:visual-review -->`;
  const slot = (state: string, inner: string) =>
    `<!-- describe:visual-review:${state} -->\n${inner}\n<!-- /describe:visual-review:${state} -->`;
  /**
   * An edited event's payload.
   */
  const edit = (from: string, to: string, more: Record<string, unknown> = {}) => ({
    action: 'edited',
    changes: { body: { from } },
    pull_request: { body: to },
    ...more,
  });
  const before = `Goal.\n\n${slot('trips', 'old T')}\n\n${block('old table')}\n`;

  it("is the upload's: only the block's or a slot's contents changed, or the block came", () => {
    expect(ownEdit(edit(before, before.replace('old table', 'staged pictures')))).toBe(true);
    expect(ownEdit(edit(before, before.replace('old T', 'new T')))).toBe(true);
    // An empty description comes as null.
    expect(ownEdit(edit(null as never, block('pictures')))).toBe(true);
    // The first upload adds the block at the end.
    expect(ownEdit(edit('Goal.\n', `Goal.\n\n${block('pictures')}\n`))).toBe(true);
  });

  it("is an author's for any other edit, a retarget, a title edit and an auto-merge event", () => {
    expect(ownEdit(edit(before, before.replace('Goal.', 'Goal, edited.')))).toBe(false);
    // A slot added, or removed, must be reviewed so it fills.
    expect(ownEdit(edit(before, `${before}\n${slot('cards', '')}`))).toBe(false);
    expect(ownEdit(edit(before, before.replace(slot('trips', 'old T'), '')))).toBe(false);
    expect(ownEdit(edit(before, before, { changes: { body: { from: before }, base: {} } }))).toBe(
      false,
    );
    expect(ownEdit({ action: 'edited', changes: { title: { from: 'x' } }, pull_request: {} })).toBe(
      false,
    );
    expect(ownEdit({ action: 'auto_merge_enabled', pull_request: { body: before } })).toBe(false);
    expect(ownEdit(edit(before, null as unknown as string))).toBe(false);
  });

  it("makes targets review nothing for the upload, and the PR for an author's edit", () => {
    const pr = { number: 5, state: 'open', head: { sha: HEAD, repo: own }, base: { ref: 'main' } };
    const routes = { [runs(HEAD)]: { workflow_runs: [{ id: 4 }] } };
    const upload = {
      ...edit(before, before.replace('old table', 'new')),
      pull_request: { ...pr, body: before.replace('old table', 'new') },
    };
    expect(targets(event(upload, routes, 'pull_request_target'))).toEqual([]);
    const theirs = { ...edit(before, 'x'), pull_request: { ...pr, body: 'x' } };
    expect(targets(event(theirs, routes, 'pull_request_target'))).toEqual([
      { kind: 'pr', number: 5, run: 4 },
    ]);
  });
});

describe('downloadShots and mockupIssue', () => {
  const art = (id: number) =>
    `GET repos/${REPO}/actions/runs/${id}/artifacts?name=visual-shots&per_page=100&page=1`;
  const routes = api({
    [art(1)]: { artifacts: [] },
    [art(2)]: { artifacts: [{ expired: true }] },
    [art(3)]: { artifacts: [{ expired: false }] },
  });

  it('says none or expired, and downloads with gh otherwise, letting a failure throw', () => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      return '';
    };
    expect(downloadShots({ api: routes, gh, repo: REPO, runId: 1, dir: '/d' })).toBe('none');
    expect(downloadShots({ api: routes, gh, repo: REPO, runId: 2, dir: '/d' })).toBe('expired');
    expect(downloadShots({ api: routes, gh, repo: REPO, runId: 3, dir: '/d' })).toBe('ok');
    expect(calls).toEqual([
      ['run', 'download', '3', '--repo', REPO, '--name', 'visual-shots', '--dir', '/d'],
    ]);
    const failing = () => {
      throw new Error('HTTP 502');
    };
    expect(() =>
      downloadShots({ api: routes, gh: failing, repo: REPO, runId: 3, dir: '/d' }),
    ).toThrow(/502/);
  });

  it("reads a mockup's issue from its shots' manifest, and none without shots", async () => {
    const { writeFileSync } = await import('node:fs');
    const path = await import('node:path');
    const manifest = {
      version: 1,
      sha: HEAD,
      base: HEAD,
      event: 'workflow_dispatch',
      mockupIssue: 9,
    };
    const gh = (args: string[]) => {
      writeFileSync(
        path.join(args[args.indexOf('--dir') + 1], 'visual-shots.json'),
        JSON.stringify(manifest),
      );
      return '';
    };
    expect(mockupIssue({ api: routes, gh, repo: REPO, run: 3 })).toBe(9);
    expect(mockupIssue({ api: routes, gh, repo: REPO, run: 1 })).toBeNull();
    expect(() => mockupIssue({ api: routes, gh, repo: REPO, run: 2 })).toThrow(/expired/);
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
    const { main } = await import('./find.ts');
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
          api({
            [`GET repos/${REPO}/actions/runs/11/artifacts?name=visual-shots&per_page=100&page=1`]: {
              artifacts: [],
            },
          }),
        ),
      ).toEqual([]);
      process.env.APP_ROOT = tmpdir();
      expect(() => main({}, api({}))).toThrow(/no visual-review key/);
    } finally {
      delete process.env.APP_ROOT;
    }
  });
});
