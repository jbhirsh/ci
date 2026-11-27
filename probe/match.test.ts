import { describe, expect, it } from 'vitest';
import {
  addedHeaders,
  findListed,
  hostMatches,
  isListed,
  operationOf,
  readsByMethod,
  sameOrigin,
} from './match.ts';

const TARGET = 'https://app-abc.vercel.app/';
const GAMES = { path: '/api/graphql', operation: 'Games' };
const get = (url: string) => ({ url, method: 'GET', body: null });
const post = (url: string, body: unknown) => ({
  url,
  method: 'POST',
  body: JSON.stringify(body),
});

describe('sameOrigin', () => {
  it('holds only for the same scheme, host and port', () => {
    expect(sameOrigin('https://app-abc.vercel.app/api', TARGET)).toBe(true);
    expect(sameOrigin('https://app-abc.vercel.app:443/x', TARGET)).toBe(true);
    expect(sameOrigin('http://app-abc.vercel.app/x', TARGET)).toBe(false);
    expect(sameOrigin('https://app-abc.vercel.app:8443/x', TARGET)).toBe(false);
    expect(sameOrigin('https://app-abc.vercel.app.evil.example/x', TARGET)).toBe(false);
    expect(sameOrigin('https://o1.ingest.sentry.io/api', TARGET)).toBe(false);
    expect(sameOrigin('not a url', TARGET)).toBe(false);
    expect(sameOrigin('data:text/plain,hi', 'data:text/plain,hi')).toBe(false);
  });
});

describe('operationOf', () => {
  it('reads operationName from the query string or the JSON body', () => {
    expect(operationOf('https://a/api/graphql?query=q&operationName=Games', null)).toBe('Games');
    expect(operationOf('https://a/api/graphql', '{"operationName":"Session"}')).toBe('Session');
  });
  it("else reads the document's operation name", () => {
    expect(
      operationOf(`https://a/api/graphql?query=${encodeURIComponent('query Games { a }')}`, null),
    ).toBe('Games');
    expect(
      operationOf('https://a/g', JSON.stringify({ query: 'mutation Vote($a: ID) { v }' })),
    ).toBe('Vote');
    expect(operationOf('https://a/g', JSON.stringify({ query: '{ a }', operationName: '' }))).toBe(
      null,
    );
  });
  it('is null for anything else', () => {
    expect(operationOf('https://a/g', null)).toBe(null);
    expect(operationOf('https://a/g', 'not json')).toBe(null);
    expect(operationOf('https://a/g', '[1]')).toBe(null);
    expect(operationOf('nope', null)).toBe(null);
  });
});

describe('isListed and findListed', () => {
  it('match by origin, exact path, method and operation', () => {
    const games = `${TARGET}api/graphql?operationName=Games&query=x`;
    expect(isListed(GAMES, get(games), TARGET)).toBe(true);
    expect(isListed(GAMES, post(`${TARGET}api/graphql`, { operationName: 'Games' }), TARGET)).toBe(
      true,
    );
    expect(isListed({ ...GAMES, method: 'GET' }, post(games, {}), TARGET)).toBe(false);
    expect(isListed({ ...GAMES, method: 'GET' }, { ...get(games), method: 'get' }, TARGET)).toBe(
      true,
    );
    expect(isListed(GAMES, get(`${TARGET}api/graphql?operationName=Session`), TARGET)).toBe(false);
    expect(isListed(GAMES, get(`${TARGET}api/graphql/x?operationName=Games`), TARGET)).toBe(false);
    expect(
      isListed(GAMES, get(`https://other.example/api/graphql?operationName=Games`), TARGET),
    ).toBe(false);
    expect(isListed({ path: '/' }, get(TARGET), TARGET)).toBe(true);
  });
  it('findListed returns the first that matches', () => {
    const list = [
      { name: 'a', path: '/x', method: 'POST' },
      { name: 'b', path: '/x' },
    ];
    expect(findListed(list, get(`${TARGET}x`), TARGET)?.name).toBe('b');
    expect(findListed(list, post(`${TARGET}x`, {}), TARGET)?.name).toBe('a');
    expect(findListed(list, get(`${TARGET}y`), TARGET)).toBeUndefined();
  });
});

describe('readsByMethod', () => {
  it('lets GET and HEAD go out, whatever the case', () => {
    expect(['GET', 'head'].map(readsByMethod)).toEqual([true, true]);
    expect(['POST', 'PUT', 'DELETE', 'PATCH'].map(readsByMethod)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('addedHeaders', () => {
  const headers = { 'x-synthetic': 'probe' };
  it("adds the app's headers on the deployment's origin only", () => {
    expect(addedHeaders(`${TARGET}api/graphql`, TARGET, headers)).toEqual(headers);
    expect(addedHeaders('https://o1.ingest.sentry.io/api/1/envelope/', TARGET, headers)).toEqual(
      {},
    );
    expect(addedHeaders('https://vercel.com/sso', TARGET, headers)).toEqual({});
    expect(addedHeaders(TARGET, TARGET, {})).toEqual({});
  });
});

describe('hostMatches', () => {
  it('lets * stand for one or more characters within a label', () => {
    expect(hostMatches('board-games-b7b2-jbhirshs-projects.vercel.app', '*.vercel.app')).toBe(true);
    expect(hostMatches('A.Vercel.App', '*.vercel.app')).toBe(true);
    expect(hostMatches('a.b.vercel.app', '*.vercel.app')).toBe(false);
    expect(hostMatches('vercel.app', '*.vercel.app')).toBe(false);
    expect(hostMatches('xvercel.app', '*.vercel.app')).toBe(false);
    expect(hostMatches('board-games-pr1.vercel.app', 'board-games-*.vercel.app')).toBe(true);
    expect(hostMatches('example.com', 'example.com')).toBe(true);
    expect(hostMatches('exampleXcom', 'example.com')).toBe(false);
  });
});
