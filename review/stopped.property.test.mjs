import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MARKER, commentBody, limitOf } from './stopped.mjs';

const NOW = Date.UTC(2026, 10, 13, 22);

/** An execution file's messages, shaped like the API's or not at all. */
const messages = fc.oneof(
  fc.jsonValue(),
  fc.array(
    fc.oneof(
      fc.jsonValue(),
      fc.record({
        type: fc.constant('assistant'),
        api_error_params: fc.record({
          rate_limit_info: fc.record({
            rateLimitType: fc.oneof(fc.string(), fc.jsonValue()),
            resetsAt: fc.oneof(fc.double(), fc.integer(), fc.jsonValue()),
          }),
        }),
      }),
      fc.record({
        type: fc.constant('rate_limit_event'),
        rate_limit_info: fc.record({
          status: fc.constantFrom('rejected', 'allowed', 'allowed_warning'),
          resetsAt: fc.oneof(fc.double(), fc.integer()),
          unifiedWindows: fc.dictionary(
            fc.string(),
            fc.record({
              status: fc.constantFrom('rejected', 'allowed'),
              resetsAt: fc.oneof(fc.double(), fc.integer()),
            }),
          ),
        }),
      }),
      fc.record({
        type: fc.constant('result'),
        num_turns: fc.oneof(fc.integer(), fc.double(), fc.string()),
      }),
    ),
  ),
);

describe('the stopped-review comment, for any execution file', () => {
  it('never throws, and holds no text the API wrote beyond a plain limit name', () => {
    fc.assert(
      fc.property(
        messages,
        fc.constantFrom('review', 'followup'),
        fc.constantFrom('credit', 'limit'),
        fc.boolean(),
        fc.nat(),
        (m, pass, stopped, fallback, turns) => {
          const limit = limitOf(m, NOW);
          if (limit.name !== null) expect(limit.name).toMatch(/^[a-zA-Z0-9_ -]{1,60}$/);
          if (limit.resets !== null)
            expect(limit.resets).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
          const body = commentBody({
            pass: /** @type {'review' | 'followup'} */ (pass),
            stopped: /** @type {'credit' | 'limit'} */ (stopped),
            fallback,
            limit,
            turns,
          });
          // Six lines whatever the API said, and no markup it could inject.
          expect(body.split('\n')).toHaveLength(6);
          expect(body.startsWith(`${MARKER}\n`)).toBe(true);
          expect(body.slice(MARKER.length)).not.toMatch(/[<>@]|https?:/);
        },
      ),
    );
  });
});
