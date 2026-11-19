import { readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PIXELS } from '../lib/pixels.mjs';
import { testPng } from '../lib/test-pixels.mjs';
import { SECTION, uploadMarker } from '../describe/describe.mjs';
import { BOT, checkBase, review } from './review.mjs';
import { settings } from './settings.mjs';

const REPO = 'jbhirsh/app';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MB = 'c'.repeat(40);
const s = /** @type {import('./settings.mjs').Settings} */ (
  settings({ workflow: 'visual.yml', job: 'visual', folders: ['shots'] })
);

/**
 * A fake GitHub: routes answer by "METHOD route", the shots each run's
 * artifact holds, and a record of what was posted.
 *
 * @param {{ routes?: Record<string, unknown>, shots?: Record<number, Record<string, Buffer> | null>,
 *   manifest?: Record<string, unknown>, author?: string, typename?: string, autoMerge?: unknown,
 *   headRef?: string, conclusion?: string, prHead?: string,
 *   statuses?: unknown[], expired?: boolean }} [o]
 */
function fake(o = {}) {
  /** @type {{ method: string, route: string, body?: unknown }[]} */
  const calls = [];
  /** @type {{ kind: string, number: number, body: string, files: string[] }[]} */
  const uploads = [];
  /** @type {{ id: number, body: string }[]} */
  const edits = [];
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
    [`GET repos/${REPO}/pulls/5`]: { head: { sha: o.prHead ?? HEAD } },
    [`GET repos/${REPO}/compare/${BASE}...main`]: { status: 'ahead' },
    [`GET repos/${REPO}/compare/main...${HEAD}`]: { merge_base_commit: { sha: MB } },
    [`GET repos/${REPO}/compare/${MB}...${BASE}`]: { status: 'ahead' },
    [`GET repos/${REPO}/actions/workflows/visual.yml/runs?event=push&branch=main&head_sha=${BASE}&per_page=10`]:
      { workflow_runs: [{ id: 2, status: 'completed' }] },
    [`GET repos/${REPO}/issues/5/comments?per_page=100&page=1`]: [],
    [`GET repos/${REPO}/commits/${HEAD}/statuses?per_page=100&page=1`]: o.statuses ?? [],
    [`GET repos/${REPO}/issues/comments/77`]: {
      body: `${uploadMarker(BOT, HEAD)}\n![after:shots/a.png](https://github.com/user-attachments/assets/0000aaaa-1111)`,
    },
    [`POST repos/${REPO}/statuses/${HEAD}`]: {},
    ...o.routes,
  };
  /** @type {import('./review.mjs').Io} */
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
    upload: (kind, number, body, files) => {
      uploads.push({ kind, number, body, files });
      return 77;
    },
    editComment: (id, body) => edits.push({ id, body }),
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
  return { io, calls, uploads, edits, enabled, posted };
}

const PR = /** @type {const} */ ({ kind: 'pr', number: 5, run: 1 });

describe('review', () => {
  it('compares, uploads the table, and passes a change a person will merge', () => {
    const f = fake();
    expect(review(PR, { s, io: f.io })).toBe(5);
    expect(f.uploads).toHaveLength(1);
    expect(f.uploads[0].body).toMatch(/^<!-- describe-upload:visual-review:a{40} -->/);
    expect(f.uploads[0].body).toMatch(/fingerprint: [0-9a-f]{8}/);
    expect(f.uploads[0].files).toHaveLength(3);
    expect(f.edits[0].body).toContain(SECTION);
    expect(f.edits[0].body).toContain('Visual changes: 1 screen changed');
    expect(f.edits[0].body).toContain('https://github.com/user-attachments/assets/0000aaaa-1111');
    expect(f.posted()).toEqual({
      state: 'success',
      context: 'Visual changes',
      description: expect.stringMatching(
        /^1 screen changed: see the table \[vr:[0-9a-f]{8}@1000\]$/,
      ),
    });
    expect(f.enabled).toEqual([]);
  });

  it('uploads where a small change is and a zoom of it, not the screens', () => {
    const f = fake({
      shots: {
        1: { 'shots/a.png': testPng(200, 100) },
        2: { 'shots/a.png': testPng(200, 100, 3) },
      },
    });
    review(PR, { s, io: f.io });
    // Each upload is a real PNG: the zoom's crop, 30x30 pixels, enlarged 7 times.
    const sizes = f.uploads[0].files.map((file) => {
      const png = PIXELS.read(readFileSync(file));
      return [png.width, png.height];
    });
    expect(sizes).toContainEqual([642, 210]);
    expect(sizes).toContainEqual([160, 80]);
    expect(f.edits[0].body).toContain('<!-- describe-part:fold:open -->');
    expect(f.edits[0].body).toContain('| Screen | Where | Zoom: before, after, diff |');
  });

  it('uploads nothing again for the same result, even on a new head', () => {
    const first = fake();
    review(PR, { s, io: first.io });
    const hash = /fingerprint: ([0-9a-f]{8})/.exec(first.uploads[0].body)?.[1];
    const layout = /layout: ([0-9a-f]{8})/.exec(first.uploads[0].body)?.[1];
    const f = fake({
      routes: {
        [`GET repos/${REPO}/issues/5/comments?per_page=100&page=1`]: [
          {
            id: 70,
            node_id: 'N',
            user: { login: 'jbhirsh' },
            body: `${uploadMarker(BOT, MB)}\nfingerprint: ${hash}\nformat: 3\nlayout: ${layout}\n\n${SECTION}\ntable`,
          },
        ],
        [`GET repos/${REPO}/commits/${MB}/statuses?per_page=100&page=1`]: [],
      },
    });
    review(PR, { s, io: f.io });
    expect(f.uploads).toEqual([]);
    expect(f.posted()?.state).toBe('success');
  });

  it('uploads once more in the new form for a result whose last upload was in the old one', () => {
    const first = fake();
    review(PR, { s, io: first.io });
    expect(first.uploads[0].body).toMatch(/^format: 3$/m);
    const hash = /fingerprint: ([0-9a-f]{8})/.exec(first.uploads[0].body)?.[1];
    const f = fake({
      routes: {
        [`GET repos/${REPO}/issues/5/comments?per_page=100&page=1`]: [
          {
            id: 70,
            node_id: 'N',
            user: { login: 'jbhirsh' },
            // No `format:` line: an upload from before sections came in parts.
            body: `${uploadMarker(BOT, MB)}\nfingerprint: ${hash}\n\n${SECTION}\ntable`,
          },
        ],
        [`GET repos/${REPO}/commits/${MB}/statuses?per_page=100&page=1`]: [],
      },
    });
    review(PR, { s, io: f.io });
    expect(f.uploads).toHaveLength(1);
  });

  it('uploads again when the app changes what counts as minor, and trims a table too long', () => {
    const first = fake();
    review(PR, { s, io: first.io });
    const hash = /fingerprint: ([0-9a-f]{8})/.exec(first.uploads[0].body)?.[1];
    const layout = /layout: ([0-9a-f]{8})/.exec(first.uploads[0].body)?.[1];
    const previous = (/** @type {string} */ l) => ({
      routes: {
        [`GET repos/${REPO}/issues/5/comments?per_page=100&page=1`]: [
          {
            id: 70,
            node_id: 'N',
            user: { login: 'jbhirsh' },
            body: `${uploadMarker(BOT, MB)}\nfingerprint: ${hash}\nformat: 3\nlayout: ${l}\n\n${SECTION}\ntable`,
          },
        ],
        [`GET repos/${REPO}/commits/${MB}/statuses?per_page=100&page=1`]: [],
      },
    });
    const same = fake(previous(String(layout)));
    review(PR, { s, io: same.io });
    expect(same.uploads).toEqual([]);
    const other = fake(previous('00000000'));
    review(PR, { s, io: other.io });
    expect(other.uploads).toHaveLength(1);
  });

  it("keeps the owner's acceptance from an earlier head with the same result", () => {
    const first = fake();
    review(PR, { s, io: first.io });
    const hash = /fingerprint: ([0-9a-f]{8})/.exec(first.uploads[0].body)?.[1];
    const mark = `1 screen changed: see the table [vr:${hash}@500]`;
    const f = fake({
      autoMerge: { enabledAt: '1970-01-01T00:10:00Z', enabledBy: { login: 'jbhirsh' } },
      routes: {
        [`GET repos/${REPO}/issues/5/comments?per_page=100&page=1`]: [
          {
            id: 70,
            node_id: 'N',
            user: { login: 'jbhirsh' },
            body: `${uploadMarker(BOT, MB)}\nfingerprint: ${hash}\nformat: 3\nlayout: ${/layout: ([0-9a-f]{8})/.exec(first.uploads[0].body)?.[1]}\n\n${SECTION}\ntable`,
          },
        ],
        [`GET repos/${REPO}/commits/${MB}/statuses?per_page=100&page=1`]: [
          {
            id: 1,
            context: 'Visual changes',
            state: 'success',
            description: mark,
            creator: { login: 'github-actions[bot]' },
          },
        ],
      },
    });
    review(PR, { s, io: f.io });
    expect(f.posted()?.description).toMatch(/accepted by turning on auto-merge/);
  });

  it('takes no mark from a status anyone else posted', () => {
    const first = fake();
    review(PR, { s, io: first.io });
    const hash = /fingerprint: ([0-9a-f]{8})/.exec(first.uploads[0].body)?.[1];
    const f = fake({
      autoMerge: { enabledAt: '1970-01-01T00:10:00Z', enabledBy: { login: 'jbhirsh' } },
      statuses: [
        {
          id: 1,
          context: 'Visual changes',
          state: 'success',
          description: `x [vr:${hash}@0]`,
          creator: { login: 'jbhirsh' },
        },
      ],
    });
    review(PR, { s, io: f.io });
    // Shown now (1000), so auto-merge turned on at 600 came before it.
    expect(f.posted()?.state).toBe('failure');
  });

  it('posts nothing for a head the PR has moved on from', () => {
    const f = fake({ prHead: MB });
    expect(review(PR, { s, io: f.io })).toBe(5);
    expect(f.uploads).toEqual([]);
    expect(f.posted()).toBeUndefined();
  });

  it('posts no upload when nothing changed and nothing was shown before', () => {
    const same = { 'shots/a.png': testPng() };
    const f = fake({ shots: { 1: same, 2: same } });
    review(PR, { s, io: f.io });
    expect(f.uploads).toEqual([]);
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
    expect(f.uploads).toEqual([]);
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
    expect(f.uploads).toHaveLength(1);
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

  it("puts a mockup's table on its issue, with no status", () => {
    const f = fake({
      manifest: { version: 1, sha: HEAD, base: HEAD, event: 'workflow_dispatch', mockupIssue: 9 },
      routes: {
        [`GET repos/${REPO}/issues/9`]: { state: 'open' },
        [`GET repos/${REPO}/compare/${HEAD}...main`]: { status: 'identical' },
        [`GET repos/${REPO}/actions/workflows/visual.yml/runs?event=push&branch=main&head_sha=${HEAD}&per_page=10`]:
          { workflow_runs: [{ id: 2, status: 'completed' }] },
        [`GET repos/${REPO}/issues/9/comments?per_page=100&page=1`]: [],
      },
    });
    expect(review({ kind: 'issue', run: 1 }, { s, io: f.io })).toBe(9);
    expect(f.uploads[0]).toMatchObject({ kind: 'issue', number: 9 });
    expect(f.posted()).toBeUndefined();
  });

  it('refuses a mockup for a closed issue or a PR, and skips a run by hand that is no mockup', () => {
    const m = { version: 1, sha: HEAD, base: HEAD, event: 'workflow_dispatch', mockupIssue: 9 };
    expect(() =>
      review(
        { kind: 'issue', run: 1 },
        {
          s,
          io: fake({
            manifest: m,
            routes: { [`GET repos/${REPO}/issues/9`]: { state: 'open', pull_request: {} } },
          }).io,
        },
      ),
    ).toThrow(/isn't an open issue/);
    const none = fake({ manifest: { ...m, mockupIssue: null } });
    expect(review({ kind: 'issue', run: 1 }, { s, io: none.io })).toBeNull();
  });
});

describe('checkBase', () => {
  it('needs only main for a mockup', () => {
    const f = fake();
    expect(() => checkBase(f.io, BASE, null)).not.toThrow();
    expect(f.calls).toHaveLength(1);
  });
});
