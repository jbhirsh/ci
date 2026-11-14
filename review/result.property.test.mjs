import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { judge, MAX_LINE, oneLine, usageLimit } from './result.mjs';

// The execution file is whatever claude-code-action wrote, from the API's
// answers: any JSON, and messages of any shape.
const NOW = Date.parse('2026-11-13T21:54:51Z');
const info = fc.record(
  {
    status: fc.oneof(fc.constantFrom('rejected', 'allowed', 'allowed_warning'), fc.jsonValue()),
    rateLimitType: fc.oneof(fc.constantFrom('five_hour', 'seven_day'), fc.string(), fc.jsonValue()),
    resetsAt: fc.oneof(fc.double(), fc.integer(), fc.jsonValue()),
    unifiedWindows: fc.dictionary(
      fc.string(),
      fc.record({ status: fc.constantFrom('rejected', 'allowed_warning'), resetsAt: fc.double() }),
    ),
  },
  { requiredKeys: [] },
);
const message = fc.oneof(
  fc.jsonValue(),
  fc.record(
    {
      type: fc.constantFrom('system', 'assistant', 'rate_limit_event', 'result', 'user'),
      subtype: fc.oneof(fc.constantFrom('success', 'error_max_turns'), fc.string()),
      is_error: fc.oneof(fc.boolean(), fc.jsonValue()),
      api_error: fc.oneof(fc.constantFrom('usage_limit_reached', 'rate_limit_error'), fc.string()),
      api_error_params: fc.record({ rate_limit_info: info }, { requiredKeys: [] }),
      rate_limit_info: info,
      num_turns: fc.oneof(fc.nat(), fc.double(), fc.jsonValue()),
      result: fc.oneof(fc.string(), fc.jsonValue()),
    },
    { requiredKeys: ['type'] },
  ),
);
const execution = fc.oneof(fc.jsonValue(), fc.array(message, { maxLength: 8 }));

/**
 * @param {string} c one code point
 */
function isControl(c) {
  const n = /** @type {number} */ (c.codePointAt(0));
  return n < 0x20 || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029;
}

/**
 * The last result message of an execution, if any.
 *
 * @param {unknown} run
 */
function last(run) {
  if (!Array.isArray(run)) return undefined;
  return run.findLast(
    (m) => typeof m === 'object' && m !== null && !Array.isArray(m) && m.type === 'result',
  );
}

describe('judge and usageLimit', () => {
  it('never throw, and say one line within the cap', () => {
    fc.assert(
      fc.property(execution, (run) => {
        const outcome = judge(run, NOW);
        expect(outcome.why).not.toMatch(/[\r\n\u2028\u2029]/);
        expect(Array.from(outcome.why).length).toBeLessThanOrEqual(MAX_LINE);
        usageLimit(run, NOW);
      }),
    );
  });

  it('set a limit only when the last result is an error with usage_limit_reached', () => {
    fc.assert(
      fc.property(execution, (run) => {
        const result = last(run);
        const limited = result?.is_error === true && result.api_error === 'usage_limit_reached';
        const outcome = judge(run, NOW);
        expect(outcome.limit !== undefined).toBe(limited);
        expect(usageLimit(run, NOW) !== null).toBe(limited);
        if (outcome.limit) expect(outcome.finished).toBe(false);
      }),
    );
  });

  it('give a reset time only as a UTC minute', () => {
    fc.assert(
      fc.property(execution, (run) => {
        const resets = usageLimit(run, NOW)?.resets;
        if (resets) expect(resets).toMatch(/^20\d\d-\d\d-\d\d \d\d:\d\d UTC$/);
      }),
    );
  });
});

describe('oneLine', () => {
  it('leaves one line of at most the cap, for any text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), fc.integer({ min: 2, max: 400 }), (text, max) => {
        const line = oneLine(text, max);
        expect(Array.from(line).some(isControl)).toBe(false);
        expect(Array.from(line).length).toBeLessThanOrEqual(max);
      }),
    );
  });

  it('reads back text that is already one plain line', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9.,:;'"!?()-]+( [A-Za-z0-9.,:;'"!?()-]+)*$/),
        (text) => {
          fc.pre(text.length <= MAX_LINE);
          expect(oneLine(text)).toBe(text);
        },
      ),
    );
  });
});
