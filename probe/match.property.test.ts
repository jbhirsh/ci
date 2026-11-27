import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addedHeaders, findListed, isListed, operationOf } from './match.ts';

const TARGET = 'https://app-abc.vercel.app';
const extra = { 'x-synthetic': 'probe' };
const name = fc.stringMatching(/^[_A-Za-z][_0-9A-Za-z]{0,15}$/);
const method = fc.oneof(fc.constantFrom('GET', 'POST', 'HEAD', 'PUT'), fc.string());
const body = fc.option(fc.oneof(fc.string(), fc.json()), { nil: null });

describe('the request matcher, for any URL, method and body', () => {
  it('never throws', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.webUrl({ withQueryParameters: true }), fc.string()),
        method,
        body,
        (url, m, b) => {
          const seen = { url, method: m, body: b };
          operationOf(url, b);
          isListed({ path: '/api/graphql', operation: 'Games', method: 'POST' }, seen, TARGET);
          findListed([{ path: '/' }], seen, TARGET);
          addedHeaders(url, TARGET, extra);
        },
      ),
    );
  });

  it("never adds the app's headers to a URL whose host or port differs from the deployment's", () => {
    const other = fc.oneof(
      fc.webUrl({ withQueryParameters: true, withFragments: true }),
      fc
        .tuple(fc.integer({ min: 1, max: 65535 }), fc.webPath())
        .filter(([port]) => port !== 443)
        .map(([port, p]) => `https://app-abc.vercel.app:${port}${p}`),
      fc.webPath().map((p) => `http://app-abc.vercel.app${p}`),
      fc.domain().map((d) => `https://app-abc.vercel.app.${d}/`),
      fc.domain().map((d) => `https://${d}.app-abc.vercel.app/`),
    );
    fc.assert(
      fc.property(other, (url) => {
        fc.pre(new URL(url).origin !== TARGET);
        expect(addedHeaders(url, TARGET, extra)).toEqual({});
      }),
    );
  });

  it('reads an operation name the same from the query string and the JSON body', () => {
    fc.assert(
      fc.property(name, fc.option(name, { nil: undefined }), (op, inQuery) => {
        const query = inQuery === undefined ? '{ a }' : `query ${inQuery} { a }`;
        const fromUrl = operationOf(
          `${TARGET}/api/graphql?${new URLSearchParams({ query, operationName: op })}`,
          null,
        );
        const fromBody = operationOf(
          `${TARGET}/api/graphql`,
          JSON.stringify({ query, operationName: op }),
        );
        expect(fromUrl).toBe(op);
        expect(fromBody).toBe(op);
        const noName = operationOf(`${TARGET}/g?${new URLSearchParams({ query })}`, null);
        expect(noName).toBe(operationOf(`${TARGET}/g`, JSON.stringify({ query })));
      }),
    );
  });
});
