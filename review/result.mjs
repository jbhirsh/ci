// Whether a review pass that claude-code-action failed did finish. The
// action fails a run that ran past `--max-turns` even when Claude came back
// with a successful result (base-action/src/run-claude-sdk.ts, October
// 2026: "Claude reported a successful result after N turns, exceeding the
// configured maximum of M"), after writing the execution file. A review
// that ran long but finished has done its job, and whether it read
// everything is coverage.mjs's call, so action.yml runs each pass with
// continue-on-error and asks this instead. Anything else (an error result,
// a run stopped at the cap, no result at all, no execution file) still
// fails.
//
// CLI: `node result.mjs <execution file>`; exits 0 for a finished review,
// 1 otherwise, saying which on stdout.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {object} Outcome
 * @property {boolean} finished
 * @property {string} why
 */

/**
 * Judges claude-code-action's execution file (the SDK's message list) by
 * its last result message.
 *
 * @param {unknown} execution
 * @returns {Outcome}
 */
export function judge(execution) {
  const messages = Array.isArray(execution) ? execution : [];
  /** @type {Record<string, unknown> | undefined} */
  let result;
  for (const m of messages) {
    if (m && typeof m === 'object' && /** @type {{ type?: unknown }} */ (m).type === 'result') {
      result = /** @type {Record<string, unknown>} */ (m);
    }
  }
  if (!result) return { finished: false, why: 'the pass gave no result' };
  const turns = typeof result.num_turns === 'number' ? ` after ${result.num_turns} turns` : '';
  if (result.subtype === 'success' && result.is_error !== true) {
    return { finished: true, why: `the pass finished${turns}, past its turn cap or not` };
  }
  return { finished: false, why: `the pass ended with ${String(result.subtype)}${turns}` };
}

/**
 * @param {string | undefined} file
 * @returns {Outcome}
 */
export function main(file) {
  if (!file) return { finished: false, why: 'no execution file' };
  try {
    return judge(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { finished: false, why: `could not read the execution file ${file}` };
  }
}

/* c8 ignore start: the CLI's lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { finished, why } = main(process.argv[2]);
  console.log(`Claude Review: ${why}.`);
  if (!finished) process.exit(1);
}
/* c8 ignore stop */
