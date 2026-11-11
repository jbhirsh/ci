import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTHOR } from '../lib/comment.mjs';
import { explain, keepTable, main } from './comment.mjs';
import { MARKER } from './table.mjs';

const REPO = 'jbhirsh/sift';
const HEAD = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';
const BASE = 'b'.repeat(40);
const MERGE_BASE = 'a'.repeat(40);
const SHOT = 'e2e/screenshots/baselines/light-03-sift.png';

/**
 * An app checkout with these `.github/ci.json` settings.
 *
 * @param {Record<string, unknown>} config
 */
function app(config) {
  const root = mkdtempSync(path.join(tmpdir(), 'visuals-comment-'));
  mkdirSync(path.join(root, '.github'));
  writeFileSync(path.join(root, '.github', 'ci.json'), JSON.stringify(config));
  return root;
}

const SIFT = {
  visuals: { fromBaselines: true },
  'visual-baselines': {
    folders: ['e2e/screenshots/baselines'],
    columns: [
      { label: 'Light', file: 'light-{state}.png', width: 220 },
      { label: 'Dark', file: 'dark-{state}.png', width: 220 },
    ],
  },
};

/**
 * A fake API over one PR, recording each write.
 *
 * @param {{ comments?: { id: number, body: string, login?: string }[], head?: string, state?: string, mergeBase?: string, fail?: Error }} [opts]
 */
function fakeApi(opts = {}) {
  /** @type {[string, string, unknown][]} */
  const writes = [];
  /** @type {import('../lib/comment.mjs').Api} */
  const api = (method, route, body) => {
    if (opts.fail) throw opts.fail;
    if (method !== 'GET') {
      writes.push([method, route, body]);
      return null;
    }
    if (route.startsWith(`repos/${REPO}/compare/`)) {
      expect(route).toBe(`repos/${REPO}/compare/${BASE}...${HEAD}?per_page=1`);
      return { merge_base_commit: { sha: opts.mergeBase ?? MERGE_BASE } };
    }
    if (route === `repos/${REPO}/pulls/7`) {
      return { state: opts.state ?? 'open', head: { sha: opts.head ?? HEAD } };
    }
    if (route.startsWith(`repos/${REPO}/issues/7/comments`)) {
      return (opts.comments ?? []).map((c) => ({
        id: c.id,
        body: c.body,
        user: { login: c.login ?? AUTHOR },
      }));
    }
    throw new Error(`unexpected ${route}`);
  };
  return { api, writes };
}

const run = (
  /** @type {import('../lib/baselines.mjs').FileEntry[]} */ files,
  root = app(SIFT),
) => ({
  repo: REPO,
  pr: 7,
  head: HEAD,
  base: BASE,
  files,
  root,
});

describe('keepTable', () => {
  it('posts the table, before at the merge base', () => {
    const { api, writes } = fakeApi();
    expect(keepTable(run([{ filename: SHOT, status: 'modified' }]), api)).toBe(
      'PR visuals: posted the table on #7.',
    );
    expect(writes).toHaveLength(1);
    const [method, route, body] = writes[0];
    expect([method, route]).toEqual(['POST', `repos/${REPO}/issues/7/comments`]);
    const text = /** @type {{ body: string }} */ (body).body;
    expect(text.startsWith(MARKER)).toBe(true);
    expect(text).toContain(`/${MERGE_BASE}/${SHOT}`);
    expect(text).toContain(`/${HEAD}/${SHOT}`);
    expect(text).toContain('width="220"');
  });

  it("edits its own comment in place, not someone else's, and skips an unchanged one", () => {
    const files = [{ filename: SHOT, status: 'modified' }];
    const first = fakeApi();
    keepTable(run(files), first.api);
    const body = /** @type {{ body: string }} */ (first.writes[0][2]).body;

    const same = fakeApi({ comments: [{ id: 3, body }] });
    expect(keepTable(run(files), same.api)).toBe(
      'PR visuals: the table on #7 is already up to date.',
    );
    expect(same.writes).toEqual([]);

    const stale = fakeApi({
      comments: [
        { id: 2, body: `${MARKER}\nforged`, login: 'someone' },
        { id: 3, body: `${MARKER}\nold` },
      ],
    });
    expect(keepTable(run(files), stale.api)).toBe('PR visuals: updated the table on #7.');
    expect(stale.writes).toEqual([['PATCH', `repos/${REPO}/issues/comments/3`, { body }]]);
  });

  it('deletes the table once the PR changes no baselines, and posts none before', () => {
    const files = [{ filename: 'src/App.tsx', status: 'modified' }];
    const had = fakeApi({ comments: [{ id: 3, body: `${MARKER}\nold` }] });
    expect(keepTable(run(files), had.api)).toBe(
      'PR visuals: #7 no longer changes any baselines; deleted its table.',
    );
    expect(had.writes).toEqual([['DELETE', `repos/${REPO}/issues/comments/3`, undefined]]);
    const none = fakeApi();
    expect(keepTable(run(files), none.api)).toBe('PR visuals: #7 changes no baselines; no table.');
    expect(none.writes).toEqual([]);
  });

  it('writes nothing for a PR that moved on or closed, or with no merge base', () => {
    const files = [{ filename: SHOT, status: 'modified' }];
    for (const opts of [{ head: 'c'.repeat(40) }, { state: 'closed' }, { mergeBase: '' }]) {
      const { api, writes } = fakeApi(opts);
      expect(keepTable(run(files), api)).toMatch(/moved on|is closed|no merge base/);
      expect(writes).toEqual([]);
    }
  });
});

describe('main', () => {
  /**
   * main's log lines for an app with these settings, over the fake API.
   *
   * @param {Record<string, unknown>} config
   * @param {Record<string, string>} [env]
   */
  const go = (config, env = {}, api = fakeApi().api) => {
    const root = app(config);
    const files = path.join(root, 'files.jsonl');
    writeFileSync(files, `${JSON.stringify({ filename: SHOT, status: 'added' })}\n`);
    /** @type {string[]} */
    const lines = [];
    main(
      {
        APP_ROOT: root,
        GITHUB_REPOSITORY: REPO,
        PR: '7',
        HEAD_SHA: HEAD,
        BASE_SHA: BASE,
        PR_FILES: files,
        ...env,
      },
      api,
      (line) => lines.push(line),
    );
    return lines;
  };

  it('does nothing, and prints nothing, without fromBaselines', () => {
    const { api, writes } = fakeApi();
    expect(go({ visuals: {} }, {}, api)).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('keeps the table with it', () => {
    expect(go(SIFT)).toEqual(['PR visuals: posted the table on #7.']);
  });

  it('warns, never throws, on missing input or a bad setting', () => {
    expect(go(SIFT, { PR: '' })[0]).toMatch(/GITHUB_REPOSITORY and PR are needed/);
    expect(go(SIFT, { HEAD_SHA: 'main' })[0]).toMatch(/HEAD_SHA and BASE_SHA are needed/);
    expect(go({ visuals: { fromBaselines: true } })[0]).toMatch(
      /^::warning::PR visuals: no table: .*visual-baselines/,
    );
  });

  it("is a notice when the token can't comment", () => {
    const denied = new Error('gh: Forbidden (HTTP 403)');
    expect(go(SIFT, {}, fakeApi({ fail: denied }).api)).toEqual([explain(denied)]);
    expect(explain(denied)).toMatch(/^::notice::.*pull-requests: write/);
    expect(explain('boom\nmore')).toBe('::warning::PR visuals: no table: boom');
  });
});
