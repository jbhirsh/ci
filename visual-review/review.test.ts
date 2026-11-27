import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PIXELS } from '../lib/pixels.mjs';
import { testPng } from '../lib/test-pixels.mjs';
import { blocks, SECTION, uploadMarker } from '../describe/describe.ts';
import { recordLine } from './record.ts';
import {
  BOT,
  checkBase,
  earlierResult,
  growth,
  HEADS_LOOKED_AT,
  review,
  UPLOAD_FORMAT,
} from './review.ts';
import { settings } from './settings.ts';

const REPO = 'jbhirsh/app';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MB = 'c'.repeat(40);
const s = /** @type {import('./settings.ts').Settings} */ (
  settings({ workflow: 'visual.yml', job: 'visual', folders: ['shots'] })
);

/**
 * A fake GitHub: routes answer by "METHOD route", the shots each run's
 * artifact holds, and a record of what was posted.
 *
 * @param {{ routes?: Record<string, unknown>, shots?: Record<number, Record<string, Buffer> | null>,
 *   manifest?: Record<string, unknown>, author?: string, typename?: string, autoMerge?: unknown,
 *   headRef?: string, conclusion?: string, prHead?: string, body?: string,
 *   pushed?: { beforeCommit?: { oid: string }, afterCommit?: { oid: string } }[],
 *   statuses?: unknown[], expired?: boolean }} [o]
 */
function fake(o = {}) {
  /** @type {{ method: string, route: string, body?: unknown }[]} */
  const calls = [];
  /** @type {{ handoff: import('./review.ts').Handoff, files: { name: string, bytes: Buffer }[] }[]} */
  const handoffs = [];
  /** @type {number[]} */
  const enabled = [];
  const shots = o.shots ?? {
    1: { 'shots/a.png': testPng(10, 10, 5), 'shots/b.png': testPng() },
    2: { 'shots/a.png': testPng(), 'shots/b.png': testPng() },
  };
  const manifest = o.manifest ?? {
    version: 1,
    sha: HEAD,
    base: BASE,
    event: 'pull_request',
    mockupIssue: null,
  };
  /** @type {Record<string, unknown>} */
  const routes = {
    [`GET repos/${REPO}/actions/runs/1`]: {
      id: 1,
      head_sha: HEAD,
      conclusion: o.conclusion ?? 'success',
    },
    [`GET repos/${REPO}/pulls/5`]: { head: { sha: o.prHead ?? HEAD }, body: o.body ?? 'Mine.' },
    [`GET repos/${REPO}/pulls/5/commits?per_page=100&page=1`]: [{ sha: HEAD }],
    [`GET repos/${REPO}/compare/${BASE}...main`]: { status: 'ahead' },
    [`GET repos/${REPO}/compare/main...${HEAD}`]: { merge_base_commit: { sha: MB } },
    [`GET repos/${REPO}/compare/${MB}...${BASE}`]: { status: 'ahead' },
    [`GET repos/${REPO}/actions/workflows/visual.yml/runs?event=push&branch=main&head_sha=${BASE}&per_page=10`]:
      { workflow_runs: [{ id: 2, status: 'completed' }] },
    [`GET repos/${REPO}/issues/5/comments?per_page=100&page=1`]: [],
    [`GET repos/${REPO}/commits/${HEAD}/statuses?per_page=100&page=1`]: o.statuses ?? [],
    [`POST repos/${REPO}/statuses/${HEAD}`]: {},
    ...o.routes,
  };
  /** @type {import('./review.ts').Io} */
  const io = {
    repo: REPO,
    owner: 'jbhirsh',
    main: 'main',
    api: (method, route, body) => {
      calls.push({ method, route, body });
      const key = `${method} ${route}`;
      if (!(key in routes)) throw new Error(`unexpected ${key}`);
      return routes[key];
    },
    graphql: () => ({
      repository: {
        pullRequest: {
          author: { login: o.author ?? 'jbhirsh', __typename: o.typename ?? 'User' },
          headRefName: o.headRef ?? 'claude/x',
          state: 'OPEN',
          autoMergeRequest: o.autoMerge ?? null,
          timelineItems: { nodes: o.pushed ?? [] },
        },
      },
    }),
    artifact: (runId, dir) => {
      const tree = shots[runId];
      if (!tree) return o.expired ? 'expired' : 'none';
      for (const [file, bytes] of Object.entries(tree)) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), bytes);
      }
      if (runId === 1) writeFileSync(path.join(dir, 'visual-shots.json'), JSON.stringify(manifest));
      return 'ok';
    },
    handoff: (handoff, files) => handoffs.push({ handoff, files }),
    uploader: 'jbhirsh',
    enable: (number) => {
      enabled.push(number);
      return 'enabled';
    },
    pixels: PIXELS,
    now: () => 1000,
    log: () => {},
  };
  const posted = () =>
    /** @type {{ state: string, description: string } | undefined} */ (
      calls.find((c) => c.method === 'POST')?.body
    );
  return { io, calls, handoffs, enabled, posted };
}

const PR = /** @type {const} */ ({ kind: 'pr', number: 5, run: 1 });

/** A status of the Actions token's. */
const actions = (/** @type {string} */ state, /** @type {string} */ description) => ({
  id: 1,
  context: 'Visual changes',
  state,
  description,
  creator: { login: 'github-actions[bot]' },
});

/**
 * A description whose visual-review block holds a record.
 *
 * @param {Partial<import('./record.ts').Record>} record
 */
const recorded = (record) =>
  blocks.write(
    'Mine.',
    BOT,
    `${recordLine({ sha: MB, fingerprint: '00000000', format: UPLOAD_FORMAT, layout: '00000000', run: 1, assets: [], ...record })}\ntable`,
  );

/** The first review's hand-off, for a record of the same result. */
function firstResult() {
  const first = fake();
  review(PR, { s, io: first.io });
  const { record, pictures } = first.handoffs[0].handoff;
  return { ...record, assets: pictures.map((_, i) => `000${i}aaaa-1111`) };
}

describe('review', () => {
  it('compares, hands off the pictures and the table, and passes a change a person will merge', () => {
    const f = fake();
    expect(review(PR, { s, io: f.io })).toBe(5);
    expect(f.handoffs).toHaveLength(1);
    const { handoff, files } = f.handoffs[0];
    expect(handoff).toMatchObject({
      version: 1,
      kind: 'pr',
      number: 5,
      head: HEAD,
      run: 1,
      record: { sha: HEAD, format: UPLOAD_FORMAT, run: 1 },
      pictures: ['01.png', '02.png', '03.png'],
      assets: [],
      legacy: [],
    });
    expect(handoff.record.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(files.map((x) => x.name)).toEqual(handoff.pictures);
    expect(handoff.section).toContain('Visual changes: 1 screen changed');
    // Each picture by its local path, for attach to swap for its link.
    for (const p of handoff.pictures) expect(handoff.section).toContain(`src="./${p}"`);
    expect(f.posted()).toEqual({
      state: 'success',
      context: 'Visual changes',
      description: expect.stringMatching(
        /^1 screen changed: see the table \[vr:[0-9a-f]{8}@1000\]$/,
      ),
    });
    expect(f.enabled).toEqual([]);
  });

  it('hands off where a small change is and a zoom of it, not the screens', () => {
    const f = fake({
      shots: {
        1: { 'shots/a.png': testPng(200, 100) },
        2: { 'shots/a.png': testPng(200, 100, 3) },
      },
    });
    review(PR, { s, io: f.io });
    // Each picture is a real PNG: the zoom's crop, 30x30 pixels, enlarged 7 times.
    const sizes = f.handoffs[0].files.map(({ bytes }) => {
      const png = PIXELS.read(bytes);
      return [png.width, png.height];
    });
    expect(sizes).toContainEqual([642, 210]);
    expect(sizes).toContainEqual([160, 80]);
    expect(f.handoffs[0].handoff.section).toContain('<!-- describe-part:fold:open -->');
    expect(f.handoffs[0].handoff.section).toContain(
      '| Screen | Where | Zoom: before, after, diff |',
    );
  });

  it("uploads nothing for the record's result, even on a new head, and renders it from the record's links", () => {
    const record = firstResult();
    const f = fake({
      body: recorded(record),
      routes: { [`GET repos/${REPO}/commits/${MB}/statuses?per_page=100&page=1`]: [] },
    });
    review(PR, { s, io: f.io });
    const { handoff, files } = f.handoffs[0];
    expect(files).toEqual([]);
    expect(handoff.pictures).toEqual([]);
    expect(handoff.assets).toEqual(record.assets);
    expect(handoff.record).toEqual({ ...record, assets: undefined, run: 1 });
    expect(handoff.section).toContain('https://github.com/user-attachments/assets/0000aaaa-1111');
    expect(handoff.section).not.toContain('./0');
    expect(f.posted()?.state).toBe('success');
  });

  it('uploads again for a record that lost its links, an old format or another layout', () => {
    const record = firstResult();
    for (const other of [
      { assets: [] },
      { format: 3 },
      // The app changed what counts as minor.
      { layout: 'ffffffff' },
    ]) {
      const f = fake({ body: recorded({ ...record, ...other }) });
      review(PR, { s, io: f.io });
      expect(f.handoffs[0].handoff.pictures).toHaveLength(3);
    }
  });

  it('uploads once in the new form for a PR whose table came from an upload comment, which attach hides', () => {
    const record = firstResult();
    const f = fake({
      routes: {
        [`GET repos/${REPO}/issues/5/comments?per_page=100&page=1`]: [
          {
            id: 70,
            node_id: 'N',
            user: { login: 'jbhirsh' },
            body: `${uploadMarker(BOT, MB)}\nfingerprint: ${record.fingerprint}\nformat: 3\nlayout: ${record.layout}\n\n${SECTION}\ntable`,
          },
          // Not BOT_PR_TOKEN's: it doesn't count.
          {
            id: 71,
            node_id: 'X',
            user: { login: 'someone' },
            body: `${uploadMarker(BOT, MB)}\n\n${SECTION}\ntable`,
          },
        ],
      },
    });
    review(PR, { s, io: f.io });
    expect(f.handoffs[0].handoff).toMatchObject({ legacy: ['N'], record: { format: 4 } });
    expect(f.handoffs[0].files).toHaveLength(3);
  });

  it('hands off the summary alone when the screens went back to how main has them', () => {
    const same = { 'shots/a.png': testPng() };
    const f = fake({ shots: { 1: same, 2: same }, body: recorded(firstResult()) });
    review(PR, { s, io: f.io });
    const { handoff, files } = f.handoffs[0];
    expect(files).toEqual([]);
    expect(handoff.pictures).toEqual([]);
    expect(handoff.section).toMatch(/^Visual changes: none/);
  });

  it('trims a table too long for the description, counting its links at their full length', () => {
    const section = '<img src="./01.png"> <img src="./02.png"> <img src="./01.png">';
    // Two ids and commas, and each of three paths grown into a 79-character link.
    expect(growth(section, 2)).toBe(2 * 37 + 3 * (79 - 8));
  });

  it("keeps the owner's acceptance from an earlier head with the same result", () => {
    const record = firstResult();
    const mark = `1 screen changed: see the table [vr:${record.fingerprint}@500]`;
    const f = fake({
      autoMerge: { enabledAt: '1970-01-01T00:10:00Z', enabledBy: { login: 'jbhirsh' } },
      routes: {
        [`GET repos/${REPO}/pulls/5/commits?per_page=100&page=1`]: [{ sha: MB }, { sha: HEAD }],
        [`GET repos/${REPO}/commits/${MB}/statuses?per_page=100&page=1`]: [
          actions('success', mark),
        ],
      },
    });
    review(PR, { s, io: f.io });
    expect(f.posted()?.description).toMatch(/accepted by turning on auto-merge/);
  });

  it('takes no mark from a status anyone else posted', () => {
    const record = firstResult();
    const f = fake({
      autoMerge: { enabledAt: '1970-01-01T00:10:00Z', enabledBy: { login: 'jbhirsh' } },
      statuses: [
        {
          id: 1,
          context: 'Visual changes',
          state: 'success',
          description: `x [vr:${record.fingerprint}@0]`,
          creator: { login: 'jbhirsh' },
        },
      ],
    });
    review(PR, { s, io: f.io });
    // Shown now (1000), so auto-merge turned on at 600 came before it.
    expect(f.posted()?.state).toBe('failure');
  });

  it("never reads the earlier result from the description's record", () => {
    const record = firstResult();
    // A record naming a commit whose status accepted this result: not one of the PR's heads.
    const f = fake({
      autoMerge: { enabledAt: '1970-01-01T00:10:00Z', enabledBy: { login: 'jbhirsh' } },
      body: recorded({ ...record, sha: MB }),
      routes: {
        [`GET repos/${REPO}/commits/${MB}/statuses?per_page=100&page=1`]: [
          actions('success', `x [vr:${record.fingerprint}@0]`),
        ],
      },
    });
    review(PR, { s, io: f.io });
    expect(f.posted()?.state).toBe('failure');
  });

  it('posts nothing for a head the PR has moved on from', () => {
    const f = fake({ prHead: MB });
    expect(review(PR, { s, io: f.io })).toBe(5);
    expect(f.handoffs).toEqual([]);
    expect(f.posted()).toBeUndefined();
  });

  it('hands off nothing when nothing changed and nothing was shown before', () => {
    const same = { 'shots/a.png': testPng() };
    const f = fake({ shots: { 1: same, 2: same } });
    review(PR, { s, io: f.io });
    expect(f.handoffs).toEqual([]);
    expect(f.posted()?.description).toBe('No visual changes');
  });

  it("blocks a bot's PR with auto-merge on, and leaves turning it on to enable.mjs", () => {
    const f = fake({
      typename: 'Bot',
      author: 'dependabot',
      headRef: 'dependabot/npm_and_yarn/x',
      autoMerge: { enabledAt: '2026-01-01T00:00:00Z', enabledBy: { login: 'github-actions' } },
    });
    review(PR, { s, io: f.io });
    expect(f.posted()?.state).toBe('failure');
    expect(f.enabled).toEqual([5]);
  });

  it("waits for main's shots", () => {
    const f = fake({
      routes: {
        [`GET repos/${REPO}/actions/workflows/visual.yml/runs?event=push&branch=main&head_sha=${BASE}&per_page=10`]:
          { workflow_runs: [{ id: 2, status: 'in_progress' }] },
      },
    });
    review(PR, { s, io: f.io });
    expect(f.posted()).toMatchObject({ state: 'pending' });
    expect(f.handoffs).toEqual([]);
  });

  it("fails when main's run has no shots", () => {
    const f = fake({ shots: { 1: { 'shots/a.png': testPng() }, 2: null } });
    review(PR, { s, io: f.io });
    expect(f.posted()?.description).toMatch(/^Main has no screenshots/);
  });

  it('passes "no screens taken" only from a run that succeeded with no artifact', () => {
    const none = fake({ shots: { 1: null } });
    review(PR, { s, io: none.io });
    expect(none.posted()?.description).toBe('No screens taken');
    const failed = fake({ shots: { 1: null }, conclusion: 'failure' });
    review(PR, { s, io: failed.io });
    expect(failed.posted()?.description).toBe('No screenshots: visual failed');
    const expired = fake({ shots: { 1: null }, expired: true });
    review(PR, { s, io: expired.io });
    expect(expired.posted()?.state).toBe('failure');
  });

  it('fails when main has no push run for the base at all', () => {
    const f = fake({
      routes: {
        [`GET repos/${REPO}/actions/workflows/visual.yml/runs?event=push&branch=main&head_sha=${BASE}&per_page=10`]:
          { workflow_runs: [] },
      },
    });
    review(PR, { s, io: f.io });
    expect(f.posted()?.description).toMatch(/^Main has no screenshots/);
  });

  it('looks again once after posting "waiting", in case main\'s run just finished', () => {
    let reads = 0;
    const route = `GET repos/${REPO}/actions/workflows/visual.yml/runs?event=push&branch=main&head_sha=${BASE}&per_page=10`;
    const f = fake();
    const api = f.io.api;
    f.io.api = (method, r, body) => {
      if (`${method} ${r}` === route) {
        reads++;
        return { workflow_runs: [{ id: 2, status: reads === 1 ? 'in_progress' : 'completed' }] };
      }
      return api(method, r, body);
    };
    review(PR, { s, io: f.io });
    const posts = f.calls
      .filter((c) => c.method === 'POST')
      .map((c) => /** @type {{ state: string }} */ (c.body).state);
    expect(posts).toEqual(['pending', 'success']);
    expect(f.handoffs).toHaveLength(1);
  });

  it("logs, and doesn't fail, when auto-merge can't be turned on", () => {
    const f = fake({ headRef: 'dependabot/npm_and_yarn/x' });
    f.io.enable = () => {
      throw new Error('403');
    };
    expect(review(PR, { s, io: f.io })).toBe(5);
  });

  it("refuses shots of another commit, and a base that isn't on main or is too old", () => {
    expect(() =>
      review(PR, {
        s,
        io: fake({
          manifest: { version: 1, sha: MB, base: BASE, event: 'pull_request', mockupIssue: null },
        }).io,
      }),
    ).toThrow(/not the run's commit/);
    expect(() =>
      review(PR, {
        s,
        io: fake({
          routes: { [`GET repos/${REPO}/compare/${BASE}...main`]: { status: 'diverged' } },
        }).io,
      }),
    ).toThrow(/isn't on main/);
    expect(() =>
      review(PR, {
        s,
        io: fake({
          routes: { [`GET repos/${REPO}/compare/${MB}...${BASE}`]: { status: 'behind' } },
        }).io,
      }),
    ).toThrow(/older than the PR's merge base/);
  });

  /** A mockup's fake GitHub, for issue 9. */
  const mockup = (/** @type {Record<string, unknown>} */ routes = {}) =>
    fake({
      manifest: { version: 1, sha: HEAD, base: HEAD, event: 'workflow_dispatch', mockupIssue: 9 },
      routes: {
        [`GET repos/${REPO}/issues/9`]: { state: 'open', body: 'Plan.' },
        [`GET repos/${REPO}/compare/${HEAD}...main`]: { status: 'identical' },
        [`GET repos/${REPO}/actions/workflows/visual.yml/runs?event=push&branch=main&head_sha=${HEAD}&per_page=10`]:
          { workflow_runs: [{ id: 2, status: 'completed' }] },
        [`GET repos/${REPO}/issues/9/comments?per_page=100&page=1`]: [],
        ...routes,
      },
    });

  it("hands off a mockup's table for its issue, with no status", () => {
    const f = mockup();
    expect(review({ kind: 'issue', number: 9, run: 1 }, { s, io: f.io })).toBe(9);
    expect(f.handoffs[0].handoff).toMatchObject({ kind: 'issue', number: 9, run: 1 });
    expect(f.posted()).toBeUndefined();
  });

  it("keeps the newer run in a mockup's record when it renders the same result again", () => {
    const first = mockup();
    review({ kind: 'issue', number: 9, run: 1 }, { s, io: first.io });
    const { record, pictures } = first.handoffs[0].handoff;
    const assets = pictures.map((_, i) => `000${i}aaaa-1111`);
    const body = blocks.write('Plan.', BOT, recordLine({ ...record, run: 1, assets }));
    const f = mockup({ [`GET repos/${REPO}/issues/9`]: { state: 'open', body } });
    review({ kind: 'issue', number: 9, run: 1 }, { s, io: f.io });
    expect(f.handoffs[0].handoff.pictures).toEqual([]);
    // A later mockup run (4) whose shots are the same.
    const later = mockup({
      [`GET repos/${REPO}/issues/9`]: { state: 'open', body },
      [`GET repos/${REPO}/actions/runs/4`]: { id: 1, head_sha: HEAD, conclusion: 'success' },
    });
    review({ kind: 'issue', number: 9, run: 4 }, { s, io: later.io });
    expect(later.handoffs[0].handoff.record.run).toBe(4);
  });

  it('refuses a mockup for a closed issue, a PR or another issue, and skips a run by hand that is no mockup', () => {
    const m = { version: 1, sha: HEAD, base: HEAD, event: 'workflow_dispatch', mockupIssue: 9 };
    const issue = /** @type {const} */ ({ kind: 'issue', number: 9, run: 1 });
    expect(() =>
      review(issue, {
        s,
        io: fake({
          manifest: m,
          routes: { [`GET repos/${REPO}/issues/9`]: { state: 'open', pull_request: {} } },
        }).io,
      }),
    ).toThrow(/isn't an open issue/);
    expect(() => review({ ...issue, number: 8 }, { s, io: fake({ manifest: m }).io })).toThrow(
      /are for #9, not #8/,
    );
    const none = fake({ manifest: { ...m, mockupIssue: null } });
    expect(review(issue, { s, io: none.io })).toBeNull();
  });
});

describe('earlierResult', () => {
  const sha = (/** @type {number} */ n) => String(n).padStart(40, '0');
  /**
   * The io for a PR with these commits (oldest first), force-pushed heads and statuses.
   *
   * @param {{ commits: string[], pushed?: [string, string][], statuses: Record<string, unknown[]> }} o
   */
  const io = ({ commits, pushed = [], statuses }) => {
    /** @type {string[]} */
    const asked = [];
    const f = fake({
      // Each force-push oldest first, as GraphQL lists them: it replaced `before`, made `after`.
      pushed: pushed.map(([before, after]) => ({
        beforeCommit: { oid: before },
        afterCommit: { oid: after },
      })),
      routes: {
        [`GET repos/${REPO}/pulls/5/commits?per_page=100&page=1`]: commits.map((c) => ({ sha: c })),
      },
    });
    const api = f.io.api;
    f.io.api = (method, route, body) => {
      const m = /commits\/([0-9a-f]{40})\/statuses/.exec(route);
      if (m) {
        asked.push(m[1]);
        return statuses[m[1]] ?? [];
      }
      return api(method, route, body);
    };
    return { io: f.io, asked };
  };

  it("walks the PR's heads newest first, past a pending or failed status, to the first result", () => {
    const f = io({
      commits: [sha(1), sha(2), sha(3), HEAD],
      statuses: {
        [sha(3)]: [actions('pending', "Waiting for main's screenshots of abc1234")],
        [sha(2)]: [actions('failure', 'Visual review failed: HTTP 502')],
        [sha(1)]: [actions('success', 'x [vr:12345678@5]')],
      },
    });
    expect(earlierResult(f.io, 5, HEAD)).toBe('x [vr:12345678@5]');
    expect(f.asked).toEqual([HEAD, sha(3), sha(2), sha(1)]);
  });

  it('stops at a result with no mark, so one that went away and came back is shown afresh', () => {
    const f = io({
      commits: [sha(1), sha(2), HEAD],
      statuses: {
        [sha(2)]: [actions('success', 'No visual changes')],
        [sha(1)]: [actions('success', 'x [vr:12345678@5]')],
      },
    });
    expect(earlierResult(f.io, 5, HEAD)).toBe('No visual changes');
  });

  it('reads the heads force-pushes made and replaced, newest first, so a rebase keeps a result', () => {
    const f = io({
      commits: [HEAD],
      pushed: [
        [sha(6), sha(7)],
        [sha(7), sha(8)],
      ],
      statuses: { [sha(6)]: [actions('failure', 'merges itself [vr:12345678@5]')] },
    });
    // A failure with a mark is a result too.
    expect(earlierResult(f.io, 5, HEAD)).toBe('merges itself [vr:12345678@5]');
    expect(f.asked).toEqual([HEAD, sha(8), sha(7), sha(6)]);
  });

  it("starts at the head's own status, past one that is pending", () => {
    const f = io({
      commits: [sha(1), HEAD],
      statuses: {
        [HEAD]: [actions('pending', "Waiting for main's screenshots of abc1234")],
        [sha(1)]: [actions('success', 'x [vr:12345678@5]')],
      },
    });
    expect(earlierResult(f.io, 5, HEAD)).toBe('x [vr:12345678@5]');
  });

  it(`looks at no more than ${HEADS_LOOKED_AT} heads, and finds nothing on a new PR`, () => {
    const commits = Array.from({ length: HEADS_LOOKED_AT + 5 }, (_, i) => sha(i + 1));
    const f = io({ commits: [...commits, HEAD], statuses: {} });
    expect(earlierResult(f.io, 5, HEAD)).toBeNull();
    expect(f.asked).toHaveLength(HEADS_LOOKED_AT + 1);
  });
});

describe('checkBase', () => {
  it('needs only main for a mockup', () => {
    const f = fake();
    expect(() => checkBase(f.io, BASE, null)).not.toThrow();
    expect(f.calls).toHaveLength(1);
  });
});
