// Whether a review pass that failed did finish, from its execution file.
// action.yml runs each pass with continue-on-error and asks this after a
// failure, so this is what fails the check, saying why. A review that ran
// long but came back with a successful result has done its job, and
// whether it read everything is coverage.ts's call. Anything else (an
// error result, a run stopped at the cap, no result at all, no execution
// file) fails.
//
// CLI: `node result.ts <execution file>`; exits 0 for a finished review,
// 1 otherwise, saying which on stdout.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type Outcome = {
  finished: boolean;
  why: string;
};

/**
 * Judges a pass's execution file (the SDK's message list) by its last
 * result message.
 */
export function judge(execution: unknown): Outcome {
  const messages = Array.isArray(execution) ? execution : [];
  let result: Record<string, unknown> | undefined;
  for (const m of messages) {
    if (m && typeof m === 'object' && (m as { type?: unknown }).type === 'result') {
      result = m as Record<string, unknown>;
    }
  }
  if (!result) return { finished: false, why: 'the pass gave no result' };
  const turns = typeof result.num_turns === 'number' ? ` after ${result.num_turns} turns` : '';
  if (result.subtype === 'success' && result.is_error !== true) {
    return { finished: true, why: `the pass finished${turns}, past its turn cap or not` };
  }
  return { finished: false, why: `the pass ended with ${String(result.subtype)}${turns}` };
}

export function main(file: string | undefined): Outcome {
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
