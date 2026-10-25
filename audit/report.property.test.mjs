import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { jscpdFindings, knipFindings, lycheeFindings } from './report.mjs';

// A tool's report is whatever its version writes: any JSON at all.
const json = fc.jsonValue({ maxDepth: 5 });

describe('the reports, for any JSON', () => {
  it.each([
    ['knip', (/** @type {unknown} */ r) => knipFindings(r, 'knip.json')],
    ['jscpd', (/** @type {unknown} */ r) => jscpdFindings(r, '/repo')],
    ['lychee', lycheeFindings],
  ])('%s never throws, and has Markdown exactly when it found something', (_, findings) => {
    fc.assert(
      fc.property(json, (report) => {
        const { count, markdown } = findings(report);
        expect(Number.isInteger(count) && count >= 0).toBe(true);
        expect(markdown === '').toBe(count === 0);
      }),
    );
  });

  it('every broken link lychee lists is counted', () => {
    const failure = fc.record({ url: fc.webUrl(), status: fc.string() });
    fc.assert(
      fc.property(fc.dictionary(fc.string({ minLength: 1 }), fc.array(failure)), (map) => {
        const expected = Object.values(map).reduce((n, f) => n + f.length, 0);
        expect(lycheeFindings({ error_map: map }).count).toBe(expected);
      }),
    );
  });
});
