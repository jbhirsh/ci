// Fakes for migrate-pictures' tests: GitHub's REST API and attachment host
// as one fetch, and an app's repository with an orphan picture branch.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * @typedef {Record<string, unknown> & { id: number; body: string | null }} Item
 * @typedef {{ issues: Item[]; 'issues/comments': Item[]; 'pulls/comments': Item[]; comments: Item[]; releases: Item[]; reviews: Record<number, Item[]> }} RepoData
 */

/** @returns {RepoData} */
export const emptyRepo = () => ({
  issues: [],
  'issues/comments': [],
  'pulls/comments': [],
  comments: [],
  releases: [],
  reviews: {},
});

/**
 * A fake GitHub over in-memory repos. `refuse` holds paths whose edits
 * answer 403; `dead` attachment URLs that answer 404.
 *
 * @param {Record<string, RepoData>} repos
 */
export function fakeGitHub(repos) {
  /** @type {Set<string>} */
  const refuse = new Set();
  /** @type {Set<string>} */
  const dead = new Set();
  /** @type {{ method: string; path: string; body?: unknown }[]} */
  const writes = [];
  let clock = 0;

  /**
   * @param {number} status
   * @param {unknown} body
   */
  const json = (status, body) => new Response(JSON.stringify(body), { status });

  /** @type {typeof globalThis.fetch} */
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.host === 'github.com') {
      return dead.has(url.href)
        ? new Response('no', { status: 404, headers: { 'content-type': 'text/html' } })
        : new Response('png', { status: 200, headers: { 'content-type': 'image/png' } });
    }
    const method = init.method ?? 'GET';
    const m = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(url.pathname);
    if (!m) return json(404, {});
    const [, name, rest] = m;
    const data = repos[name];
    if (!data) return json(404, {});
    const page = Number(url.searchParams.get('page') ?? 1);
    const per = Number(url.searchParams.get('per_page') ?? 30);
    /** @param {Item[]} items */
    const paged = (items) => json(200, items.slice((page - 1) * per, page * per));
    if (method === 'GET' && rest in data && rest !== 'reviews') {
      return paged(/** @type {Item[]} */ (data[/** @type {keyof RepoData} */ (rest)]));
    }
    const reviews = /^pulls\/(\d+)\/reviews(?:\/(\d+))?$/.exec(rest);
    if (reviews && !reviews[2] && method === 'GET')
      return paged(data.reviews[Number(reviews[1])] ?? []);
    /** @type {Item | undefined} */
    let item;
    const one = /^(issues|issues\/comments|pulls\/comments|comments|releases)\/(\d+)$/.exec(rest);
    if (one) {
      const list = /** @type {Item[]} */ (data[/** @type {keyof RepoData} */ (one[1])]);
      const id = Number(one[2]);
      item = list.find((it) => (one[1] === 'issues' ? it.number : it.id) === id);
    } else if (reviews) {
      item = (data.reviews[Number(reviews[1])] ?? []).find((it) => it.id === Number(reviews[2]));
    }
    if (!item) return json(404, { message: 'Not Found' });
    if (method === 'GET') return json(200, item);
    const key = `${name}/${rest}`;
    if (refuse.has(key))
      return json(403, { message: 'Resource not accessible by personal access token' });
    const { body } = JSON.parse(String(init.body));
    writes.push({ method, path: key, body });
    item.body = body;
    item.updated_at = `2026-11-13T00:00:${String(++clock).padStart(2, '0')}Z`;
    return json(200, item);
  };
  return { fetch, refuse, dead, writes };
}

/**
 * An issue or PR as the issues API lists it.
 *
 * @param {string} repo
 * @param {number} number
 * @param {string} body
 * @param {{ pr?: boolean; author?: string }} [options]
 * @returns {Item}
 */
export function issue(repo, number, body, { pr = true, author = 'jbhirsh' } = {}) {
  return {
    id: 1000 + number,
    number,
    body,
    user: { login: author },
    html_url: `https://github.com/${repo}/${pr ? 'pull' : 'issues'}/${number}`,
    updated_at: '2026-01-01T00:00:00Z',
    ...(pr ? { pull_request: {} } : {}),
  };
}

/**
 * A comment, review or release.
 *
 * @param {string} repo
 * @param {number} id
 * @param {string | null} body
 * @param {string} [author]
 * @returns {Item}
 */
export function comment(repo, id, body, author = 'jbhirsh') {
  return {
    id,
    body,
    user: { login: author },
    html_url: `https://github.com/${repo}/c/${id}`,
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/**
 * @param {string} dir
 * @param {string[]} args
 */
export function git(dir, args) {
  const result = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    // Never a hook's GIT_DIR or GIT_INDEX_FILE, which would aim git at
    // the repository running the tests.
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** A PNG's first bytes, enough for a picture. */
export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/**
 * An app's repository: `main`, and an orphan `screenshots` branch whose
 * first commit has `carousel/a.png` and `199/old.png`, and whose tip has
 * `carousel/a.png`, `199/before.png` and a `vercel.json`.
 *
 * @returns {{ dir: string; main: string; first: string; tip: string }}
 */
export function pictureRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-pictures-origin-'));
  git(dir, ['init', '--quiet', '-b', 'main']);
  writeFileSync(path.join(dir, 'README.md'), '# app\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '--quiet', '-m', 'main']);
  const main = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['checkout', '--quiet', '--orphan', 'screenshots']);
  git(dir, ['rm', '--quiet', '-r', '-f', '.']);
  mkdirSync(path.join(dir, 'carousel'));
  mkdirSync(path.join(dir, '199'));
  writeFileSync(path.join(dir, 'carousel/a.png'), Buffer.concat([PNG, Buffer.from('a')]));
  writeFileSync(path.join(dir, '199/old.png'), Buffer.concat([PNG, Buffer.from('old')]));
  git(dir, ['add', 'carousel/a.png', '199/old.png']);
  git(dir, ['commit', '--quiet', '-m', 'first']);
  const first = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['rm', '--quiet', '199/old.png']);
  mkdirSync(path.join(dir, '199'), { recursive: true });
  writeFileSync(path.join(dir, '199/before.png'), Buffer.concat([PNG, Buffer.from('before')]));
  writeFileSync(path.join(dir, 'vercel.json'), '{}\n');
  git(dir, ['add', '199/before.png', 'vercel.json']);
  git(dir, ['commit', '--quiet', '-m', 'tip']);
  const tip = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['checkout', '--quiet', 'main']);
  return { dir, main, first, tip };
}
