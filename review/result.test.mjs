import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { judge, main } from './result.mjs';

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

describe('main', () => {
  it('reads the execution file, and fails without a readable one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'result-'));
    const file = path.join(dir, 'execution.json');
    writeFileSync(
      file,
      JSON.stringify(run({ type: 'result', subtype: 'success', num_turns: 201 })),
    );
    expect(main(file).finished).toBe(true);
    expect(main(undefined)).toEqual({ finished: false, why: 'no execution file' });
    writeFileSync(file, '{');
    expect(main(file).why).toContain('could not read');
  });
});
