// Whether a review pass that claude-code-action failed did finish, and
// whether it stopped on the Claude account's usage limit. The action fails
// a run that ran past `--max-turns` even when Claude came back with a
// successful result (base-action/src/run-claude-sdk.ts, October 2026:
// "Claude reported a successful result after N turns, exceeding the
// configured maximum of M"), after writing the execution file. A review
// that ran long but finished has done its job, and whether it read
// everything is coverage.mjs's call, so action.yml runs each pass with
// continue-on-error and asks limit.mjs, which judges with this. Anything
// else (an error result, a run stopped at the cap, no result at all, no
// execution file) still fails.
//
// A usage limit is told only by the last result: `is_error: true` with the
// API's `api_error: "usage_limit_reached"` (BoardGames #320's run, November
// 2026, whose fixture is fixtures/usage-limit.json). A 429 without it is a
// throttle, not the account running out, and a limited assistant message
// followed by another ending is that other ending. The limited assistant
// message's `api_error_params.rate_limit_info`, or failing that the last
// `rejected` rate_limit_event (or window of one), only supplies which limit
// and when it resets; an `allowed_warning` window is another limit nearing,
// not this one. The reset time is untrusted, and one out of range counts as
// none: the message then says the API gave none and quotes the result's
// text, which is never parsed.
//
// Everything here comes from the execution file, so every piece of text it
// puts in a message goes through oneLine() first.

import { readFileSync } from 'node:fs';

/** The most characters oneLine() leaves, and so the most a message holds. */
export const MAX_LINE = 300;

const LIMIT_NAMES = new Map([
  ['five_hour', '5-hour limit'],
  ['seven_day', 'weekly limit'],
  ['seven_day_opus', 'weekly Opus limit'],
  ['seven_day_sonnet', 'weekly Sonnet limit'],
]);
const RAW_TYPE = /^[a-z0-9_]{1,40}$/;
/** 2020-01-01, in seconds: a reset before it is no reset time. */
const EARLIEST = 1_577_836_800;
const YEAR = 366 * 24 * 60 * 60;

/**
 * @typedef {object} Limit
 * @property {string} name which limit, for a person: "5-hour limit"
 * @property {string | null} resets when it resets, "2026-11-14 00:40 UTC",
 *   or null when the API gave no usable time
 * @property {number | null} turns how many turns the pass ran
 * @property {string} text the result's own text, one line
 */

/**
 * @typedef {object} Outcome
 * @property {boolean} finished
 * @property {string} why one line, at most MAX_LINE characters
 * @property {Limit} [limit] set only when the pass stopped on a usage limit
 */

/**
 * @param {string} c one code point
 */
function isControl(c) {
  const n = /** @type {number} */ (c.codePointAt(0));
  return n < 0x20 || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029;
}

/**
 * Untrusted text made safe to print: control characters and runs of
 * whitespace become one space, and it's cut to `max` characters.
 *
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function oneLine(text, max = MAX_LINE) {
  const flat = Array.from(String(text ?? ''), (c) => (isControl(c) ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A reset time read from the API, in seconds, as UTC, or null when it isn't
 * a number between 2020 and a year after `now`.
 *
 * @param {unknown} resetsAt
 * @param {number} now milliseconds
 * @returns {string | null}
 */
function resetTime(resetsAt, now) {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null;
  if (resetsAt < EARLIEST || resetsAt > now / 1000 + YEAR) return null;
  return `${new Date(resetsAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * A limit's type for a person: its known name, the type itself when it's a
 * plain identifier, or "a usage limit".
 *
 * @param {unknown} type
 */
function limitName(type) {
  if (typeof type !== 'string') return 'usage limit';
  return LIMIT_NAMES.get(type) ?? (RAW_TYPE.test(type) ? `${type} limit` : 'usage limit');
}

/**
 * @param {number | null} turns
 */
const after = (turns) => (turns === null ? '' : ` after ${turns} turn${turns === 1 ? '' : 's'}`);

/**
 * @param {unknown} execution
 * @returns {{ messages: unknown[], result: Record<string, unknown> | undefined }}
 */
function lastResult(execution) {
  const messages = Array.isArray(execution) ? execution : [];
  /** @type {Record<string, unknown> | undefined} */
  let result;
  for (const m of messages) {
    if (isObject(m) && m.type === 'result') result = m;
  }
  return { messages, result };
}

/**
 * @param {Record<string, unknown>} result
 * @returns {number | null}
 */
const turnsOf = (result) =>
  Number.isSafeInteger(result.num_turns) ? /** @type {number} */ (result.num_turns) : null;

/**
 * The usage limit a pass stopped on, or null when it didn't stop on one:
 * set only when the last result is an error with `usage_limit_reached`.
 * Which limit and when it resets come from the limited assistant message's
 * rate_limit_info, else the last rejected rate_limit_event or window of one.
 *
 * @param {unknown} execution
 * @param {number} [now] milliseconds, for the range a reset time may fall in
 * @returns {Limit | null}
 */
export function usageLimit(execution, now = Date.now()) {
  const { messages, result } = lastResult(execution);
  if (!result || result.is_error !== true || result.api_error !== 'usage_limit_reached') {
    return null;
  }
  /** @type {Record<string, unknown> | undefined} */
  let source;
  for (const m of messages) {
    if (!isObject(m) || m.type !== 'assistant' || m.api_error !== 'usage_limit_reached') continue;
    const info = isObject(m.api_error_params) ? m.api_error_params.rate_limit_info : undefined;
    if (isObject(info) && (typeof info.rateLimitType === 'string' || info.resetsAt !== undefined)) {
      source = info;
    }
  }
  if (!source) {
    for (const m of messages) {
      if (!isObject(m) || m.type !== 'rate_limit_event' || !isObject(m.rate_limit_info)) continue;
      const info = m.rate_limit_info;
      if (info.status === 'rejected') source = info;
      if (!isObject(info.unifiedWindows)) continue;
      for (const [type, window] of Object.entries(info.unifiedWindows)) {
        if (isObject(window) && window.status === 'rejected') {
          source = { rateLimitType: type, resetsAt: window.resetsAt };
        }
      }
    }
  }
  return {
    name: limitName(source?.rateLimitType),
    resets: resetTime(source?.resetsAt, now),
    turns: turnsOf(result),
    text: oneLine(result.result),
  };
}

/**
 * What a limit means, in one sentence's worth: which limit, when it resets
 * and when to re-run. Shared by the log line and the PR comment.
 *
 * @param {Limit} limit
 * @param {(text: string) => string} [quote] how the result's text is set
 *   in, when there's no reset time
 */
export function limitSentence(limit, quote = (text) => text) {
  const name = limit.name === 'usage limit' ? 'a usage limit' : `its ${limit.name}`;
  if (limit.resets) {
    return `the Claude account hit ${name}, which resets ${limit.resets}; re-run this job after then`;
  }
  const said = limit.text ? ` (it said: ${quote(limit.text)})` : '';
  return `the Claude account hit ${name}, and the API gave no reset time; re-run this job once it resets${said}`;
}

/**
 * Judges claude-code-action's execution file (the SDK's message list) by
 * its last result message.
 *
 * @param {unknown} execution
 * @param {number} [now] milliseconds, for the range a reset time may fall in
 * @returns {Outcome}
 */
export function judge(execution, now = Date.now()) {
  const { result } = lastResult(execution);
  if (!result) return { finished: false, why: 'the pass gave no result' };
  const turns = after(turnsOf(result));
  if (result.subtype === 'success' && result.is_error !== true) {
    return { finished: true, why: `the pass finished${turns}, past its turn cap or not` };
  }
  const limit = usageLimit(execution, now);
  if (limit) {
    return {
      finished: false,
      why: oneLine(`the pass stopped on a usage limit${turns}: ${limitSentence(limit)}`),
      limit,
    };
  }
  const ending =
    result.subtype === 'success' ? 'an error' : oneLine(result.subtype, 60) || 'no subtype';
  const text =
    typeof result.result === 'string' && result.result.trim() ? `: ${result.result}` : '';
  return { finished: false, why: oneLine(`the pass ended with ${ending}${turns}${text}`) };
}

/**
 * Judges the execution file at a path; a missing or unreadable one is a
 * pass that didn't finish.
 *
 * @param {string | undefined} file
 * @param {number} [now]
 * @returns {Outcome}
 */
export function judgeFile(file, now = Date.now()) {
  if (!file) return { finished: false, why: 'no execution file' };
  let execution;
  try {
    execution = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { finished: false, why: oneLine(`could not read the execution file ${file}`) };
  }
  return judge(execution, now);
}
