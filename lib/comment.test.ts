import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTHOR, PAGES, findComment, ghApi, statusOf } from './comment.ts';

describe('statusOf', () => {
  it("reads an error's status, or the one gh's message names", () => {
    expect(statusOf(Object.assign(new Error('x'), { status: 404 }))).toBe(404);
    expect(statusOf({ stderr: 'gh: Forbidden (HTTP 403)' })).toBe(403);
    expect(statusOf(new Error('timeout'))).toBeNull();
    expect(statusOf(null)).toBeNull();
  });
});

describe('findComment', () => {
  const marker = '<!-- tool -->';

  it("finds the marked comment AUTHOR wrote, not anyone else's", () => {
    /** @type {import('./comment.ts').Api} */
    const api = () => [
      { id: 1, body: `${marker} x`, user: { login: 'someone' } },
      { id: 2, body: 'other', user: { login: AUTHOR } },
      { id: 3, body: `${marker}\nmine`, user: { login: AUTHOR } },
    ];
    expect(findComment(api, 'o/r', 5, marker)).toEqual({ id: 3, body: `${marker}\nmine` });
    expect(findComment(api, 'o/r', 5, '<!-- other -->')).toBeNull();
    expect(findComment(() => null, 'o/r', 5, marker)).toBeNull();
  });

  it('pages until a short page, at most PAGES', () => {
    /** @type {string[]} */
    const routes = [];
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i, body: '', user: null }));
    /** @type {import('./comment.ts').Api} */
    const api = (_method, route) => (routes.push(route), full);
    expect(findComment(api, 'o/r', 5, marker)).toBeNull();
    expect(routes).toHaveLength(PAGES);
    expect(routes[1]).toBe('repos/o/r/issues/5/comments?per_page=100&page=2');
  });
});

describe('ghApi', () => {
  it('gives a call its own token, and the next call GH_TOKEN as before', () => {
    // A stand-in `gh` that answers with the token it was run with.
    const dir = mkdtempSync(path.join(tmpdir(), 'gh-'));
    const script = '#!/bin/sh\nprintf \'{"token":"%s"}\' "$GH_TOKEN"\n';
    writeFileSync(path.join(dir, 'gh'), script, { mode: 0o755 });
    const saved = { token: process.env.GH_TOKEN, path: process.env.PATH };
    process.env.GH_TOKEN = 'actions';
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
    try {
      expect(ghApi('GET', 'user', undefined, { token: 'person' })).toEqual({ token: 'person' });
      expect(ghApi('GET', 'user')).toEqual({ token: 'actions' });
      expect(process.env.GH_TOKEN).toBe('actions');
    } finally {
      process.env.PATH = saved.path;
      if (saved.token === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved.token;
    }
  });
});
