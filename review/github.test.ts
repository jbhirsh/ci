import { describe, expect, it } from 'vitest';
import { fakeFetch } from './fakeFetch.ts';
import { github, nextLink } from './github.ts';

describe('github', () => {
  it('needs a token', () => {
    expect(() => github('')).toThrow('no GitHub token');
  });
  it('gets, sends and follows every page of a list', async () => {
    const calls: {
      url: string;
      method?: string;
      body?: string;
      headers?: Record<string, string>;
    }[] = [];
    const api = github(
      't0k',
      fakeFetch(
        {
          'GET https://api.github.com/repos/o/r': [200, { name: 'r' }],
          'GET https://api.github.com/x?per_page=100': [
            200,
            [1, 2],
            '<https://api.github.com/x?per_page=100&page=2>; rel="next"',
          ],
          'GET https://api.github.com/x?per_page=100&page=2': [200, [3]],
          'POST https://api.github.com/c': [201, { id: 9 }],
        },
        calls,
      ),
    );
    expect(await api.get('/repos/o/r')).toEqual({ name: 'r' });
    expect(await api.list('/x')).toEqual([1, 2, 3]);
    expect(await api.send('POST', '/c', { body: 'hi' })).toEqual({ id: 9 });
    expect(calls[0].headers?.authorization).toBe('Bearer t0k');
    expect(calls.at(-1)?.body).toBe('{"body":"hi"}');
  });
  it('throws on a failed call, saying which', async () => {
    const api = github('t', fakeFetch({}));
    await expect(api.get('/nope')).rejects.toThrow('GitHub GET /nope failed: 404');
  });
});

describe('nextLink', () => {
  it('finds the next page, or none', () => {
    expect(nextLink('<https://a/2>; rel="next", <https://a/9>; rel="last"')).toBe('https://a/2');
    expect(nextLink('<https://a/1>; rel="prev"')).toBeNull();
    expect(nextLink(null)).toBeNull();
  });
});
