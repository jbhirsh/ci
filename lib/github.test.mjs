import { describe, expect, it } from 'vitest';
import { PAGES, newest, pages, prTarget, statusFrom } from './github.mjs';

describe('pages', () => {
  it('reads until a short page, adding the page to any query', () => {
    /** @type {string[]} */
    const routes = [];
    const full = Array.from({ length: 100 }, (_, i) => i);
    const got = pages((_, route) => {
      routes.push(route);
      return routes.length === 1 ? full : [100];
    }, 'repos/a/b/pulls?state=open');
    expect(got).toHaveLength(101);
    expect(routes).toEqual([
      'repos/a/b/pulls?state=open&per_page=100&page=1',
      'repos/a/b/pulls?state=open&per_page=100&page=2',
    ]);
  });

  it('says when it stops at PAGES with the last page still full', () => {
    const full = Array.from({ length: 100 }, (_, i) => i);
    let said = 0;
    expect(
      pages(
        () => full,
        'x',
        undefined,
        () => said++,
      ),
    ).toHaveLength(PAGES * 100);
    expect(said).toBe(1);
    let short = 0;
    pages(
      () => [1],
      'x',
      undefined,
      () => short++,
    );
    expect(short).toBe(0);
  });

  it('reads a list under a key, and refuses anything else', () => {
    expect(pages(() => ({ artifacts: [1] }), 'x', 'artifacts')).toEqual([1]);
    expect(() => pages(() => ({}), 'x')).toThrow(/expected a list from x/);
    expect(() => pages(() => null, 'x', 'artifacts')).toThrow(/expected a list/);
  });
});

describe('newest', () => {
  it('takes the highest id', () => {
    expect(newest([{ id: 2 }, { id: 9 }, { id: 4 }])).toEqual({ id: 9 });
    expect(newest([])).toBeUndefined();
  });
});

describe('statusFrom', () => {
  it('takes the newest status of that name from the Actions bot only', () => {
    const list = [
      {
        id: 1,
        context: 'V',
        state: 'pending',
        description: 'old',
        creator: { login: 'github-actions[bot]' },
      },
      {
        id: 3,
        context: 'V',
        state: 'success',
        description: 'forged',
        creator: { login: 'someone' },
      },
      {
        id: 2,
        context: 'V',
        state: 'success',
        description: null,
        creator: { login: 'github-actions[bot]' },
      },
      {
        id: 4,
        context: 'W',
        state: 'failure',
        description: 'other',
        creator: { login: 'github-actions[bot]' },
      },
    ];
    expect(statusFrom(() => list, 'a/b', 'sha', 'V')).toEqual({
      state: 'success',
      description: '',
    });
    expect(statusFrom(() => [], 'a/b', 'sha', 'V')).toBeNull();
  });
});

describe('prTarget', () => {
  it('reads the repository and the number', () => {
    expect(prTarget({ GITHUB_REPOSITORY: 'a/b', NUMBER: '7' })).toEqual({ repo: 'a/b', number: 7 });
  });

  it.each([
    [{ NUMBER: '7' }],
    [{ GITHUB_REPOSITORY: 'a/b' }],
    [{ GITHUB_REPOSITORY: 'a/b', NUMBER: '0' }],
    [{ GITHUB_REPOSITORY: 'a/b', NUMBER: '1.5' }],
    [{ GITHUB_REPOSITORY: 'a b/c', NUMBER: '1' }],
  ])('refuses %j', (env) => {
    expect(() => prTarget(env)).toThrow('GITHUB_REPOSITORY and NUMBER');
  });
});
