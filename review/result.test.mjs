import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { judge, judgeFile, oneLine, usageLimit } from './result.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'usage-limit.json'), 'utf8'));
/** When #320's run hit the limit. */
const NOW = Date.parse('2026-11-13T21:54:51Z');

const init = { type: 'system', subtype: 'init' };
/** @param {Record<string, unknown>} result */
const run = (result) => [init, { type: 'assistant', message: { content: [] } }, result];

describe('judge', () => {
  it('passes a successful result past the turn cap, which claude-code-action fails', () => {
    // What fog-and-frontier #304's follow-up gave: "Claude reported a
    // successful result after 125 turns, exceeding the configured maximum of 100".
    expect(
      judge(run({ type: 'result', subtype: 'success', is_error: false, num_turns: 125 })),
    ).toEqual({
      finished: true,
      why: 'the pass finished after 125 turns, past its turn cap or not',
    });
  });

  it('fails a run stopped at the cap, an error result, or no result', () => {
    expect(judge(run({ type: 'result', subtype: 'error_max_turns', num_turns: 100 }))).toEqual({
      finished: false,
      why: 'the pass ended with error_max_turns after 100 turns',
    });
    expect(judge(run({ type: 'result', subtype: 'success', is_error: true })).finished).toBe(false);
    expect(judge([init]).finished).toBe(false);
    expect(judge({ type: 'result', subtype: 'success' }).finished).toBe(false);
  });

  it('goes by the last result', () => {
    const ok = { type: 'result', subtype: 'success', num_turns: 3 };
    expect(
      judge([...run(ok), { type: 'result', subtype: 'error_during_execution' }]).finished,
    ).toBe(false);
    expect(judge([null, 7, ...run(ok)]).finished).toBe(true);
  });
});

describe('judgeFile', () => {
  it('reads the execution file, and fails without a readable one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'result-'));
    const file = path.join(dir, 'execution.json');
    writeFileSync(
      file,
      JSON.stringify(run({ type: 'result', subtype: 'success', num_turns: 201 })),
    );
    expect(judgeFile(file).finished).toBe(true);
    expect(judgeFile(undefined)).toEqual({ finished: false, why: 'no execution file' });
    writeFileSync(file, '{');
    expect(judgeFile(file).why).toContain('could not read');
  });
});

/**
 * A usage-limited pass: the limited assistant message (its rate_limit_info
 * given), then its result.
 *
 * @param {Record<string, unknown> | undefined} info
 * @param {Record<string, unknown>[]} [before] messages ahead of the assistant's
 * @returns {Record<string, unknown>[]}
 */
function limited(info, before = []) {
  return [
    init,
    ...before,
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: "You've hit your limit" }] },
      error: 'rate_limit',
      api_error_status: 429,
      api_error: 'usage_limit_reached',
      ...(info ? { api_error_params: { rate_limit_info: info } } : {}),
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: true,
      num_turns: 1,
      api_error: 'usage_limit_reached',
      result: "You've hit your limit · resets 12:40am (UTC)",
    },
  ];
}

describe('usage limits', () => {
  it("tells #320's run as a 5-hour limit resetting at 00:40 UTC", () => {
    const outcome = judge(fixture, NOW);
    expect(outcome.finished).toBe(false);
    expect(outcome.limit).toEqual({
      name: '5-hour limit',
      resets: '2026-11-14 00:40 UTC',
      turns: 1,
      text: "You've hit your 5-hour limit · resets 12:40am (UTC)",
    });
    expect(outcome.why).toBe(
      'the pass stopped on a usage limit after 1 turn: the Claude account hit its 5-hour limit, which resets 2026-11-14 00:40 UTC; re-run this job after then',
    );
    expect(outcome.why).not.toContain('ended with success');
  });

  it('names the weekly limits, shows a plain unknown type raw, and any other as a usage limit', () => {
    const name = (/** @type {unknown} */ type) =>
      usageLimit(limited({ rateLimitType: type, resetsAt: 1794616800 }), NOW)?.name;
    expect(name('seven_day')).toBe('weekly limit');
    expect(name('seven_day_opus')).toBe('weekly Opus limit');
    expect(name('seven_day_sonnet')).toBe('weekly Sonnet limit');
    expect(name('thirty_day')).toBe('thirty_day limit');
    expect(name('Thirty Day <b>')).toBe('usage limit');
    expect(name('constructor')).toBe('constructor limit');
    expect(name(7)).toBe('usage limit');
    expect(judge(limited({ rateLimitType: 'x y', resetsAt: 1794616800 }), NOW).why).toContain(
      'hit a usage limit, which resets',
    );
  });

  it('takes the details from the last rejected rate_limit_event when the params lack them', () => {
    const rejected = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1794711600 },
    };
    const warning = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        resetsAt: 1794616800,
        unifiedWindows: { five_hour: { status: 'allowed_warning', resetsAt: 1794616800 } },
      },
    };
    expect(usageLimit(limited(undefined, [rejected, warning]), NOW)).toMatchObject({
      name: 'weekly limit',
      resets: '2026-11-15 03:00 UTC',
    });
    const window = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        unifiedWindows: {
          seven_day: { status: 'allowed_warning', resetsAt: 1794711600 },
          five_hour: { status: 'rejected', resetsAt: 1794616800 },
        },
      },
    };
    expect(usageLimit(limited({}, [window, warning]), NOW)).toMatchObject({
      name: '5-hour limit',
      resets: '2026-11-14 00:40 UTC',
    });
    expect(usageLimit(limited(undefined), NOW)).toMatchObject({
      name: 'usage limit',
      resets: null,
    });
  });

  it('says the API gave no reset time, quoting its text, for a reset that is missing or out of range', () => {
    for (const resetsAt of [undefined, '1794616800', Number.NaN, 1e20, -1, 1_000_000_000]) {
      const outcome = judge(limited({ rateLimitType: 'five_hour', resetsAt }), NOW);
      expect(outcome.limit?.resets).toBeNull();
      expect(outcome.why).toBe(
        "the pass stopped on a usage limit after 1 turn: the Claude account hit its 5-hour limit, and the API gave no reset time; re-run this job once it resets (it said: You've hit your limit · resets 12:40am (UTC))",
      );
    }
  });

  it('is not a 429 throttle without usage_limit_reached', () => {
    const throttled = limited({ rateLimitType: 'five_hour', resetsAt: 1794616800 }).map((m) =>
      'api_error' in m ? { ...m, api_error: 'rate_limit_error' } : m,
    );
    const outcome = judge(throttled, NOW);
    expect(outcome.limit).toBeUndefined();
    expect(outcome.why).toBe(
      "the pass ended with an error after 1 turn: You've hit your limit · resets 12:40am (UTC)",
    );
    expect(usageLimit(throttled, NOW)).toBeNull();
  });

  it('is not a limited assistant message followed by an error_max_turns result', () => {
    const run = [
      ...limited({ rateLimitType: 'five_hour', resetsAt: 1794616800 }).slice(0, -1),
      { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 200 },
    ];
    expect(judge(run, NOW)).toEqual({
      finished: false,
      why: 'the pass ended with error_max_turns after 200 turns',
    });
  });

  it('says an is_error success ended with an error, quoting it, never "with success"', () => {
    expect(
      judge(
        run({
          type: 'result',
          subtype: 'success',
          is_error: true,
          num_turns: 1,
          result: 'boom\nbang',
        }),
      ),
    ).toEqual({ finished: false, why: 'the pass ended with an error after 1 turn: boom bang' });
    expect(judge(run({ type: 'result', is_error: true })).why).toBe(
      'the pass ended with no subtype',
    );
  });
});

describe('oneLine', () => {
  it('collapses control characters and whitespace, and caps the length', () => {
    expect(oneLine('a\r\n\u0007b\u2028  c\t')).toBe('a b c');
    expect(oneLine(undefined)).toBe('');
    expect(oneLine('x'.repeat(400))).toHaveLength(300);
    expect(oneLine('abcdef', 4)).toBe('abc…');
  });
});
