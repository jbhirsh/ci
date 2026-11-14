import fc from 'fast-check';
import { describe, it } from 'vitest';
import { retryAfter } from './github.mjs';

const header = fc.oneof(
  fc.constant(undefined),
  fc.string({ maxLength: 12 }),
  fc.nat().map(String),
  fc.constant('0'),
);

describe('retryAfter, for any answer GitHub gives', () => {
  it('never throws, and is null or a wait of a second to an hour', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 599 }),
        fc.record({
          'retry-after': header,
          'x-ratelimit-remaining': header,
          'x-ratelimit-reset': header,
        }),
        fc.nat({ max: 10 }),
        fc.string({ maxLength: 60 }),
        (status, raw, tries, text) => {
          /** @type {Record<string, string>} */
          const headers = {};
          for (const [k, v] of Object.entries(raw)) if (v !== undefined) headers[k] = v;
          const wait = retryAfter(
            new Response(null, { status: status < 200 ? 299 : status, headers }),
            tries,
            0,
            text,
          );
          return wait === null || (wait >= 1000 && wait <= 3_600_000);
        },
      ),
    );
  });

  it('never retries a success or a plain refusal', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(200, 201, 204, 400, 401, 404, 422),
        fc.nat({ max: 10 }),
        (status, tries) => retryAfter(new Response(null, { status }), tries, 0) === null,
      ),
    );
  });
});
