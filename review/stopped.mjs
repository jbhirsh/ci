// What action.yml runs when a review pass stopped short for reasons not the
// PR's (sdk.mjs's `stopped`: out of API credit, or a spend or usage limit)
// and the retry on the owner's Claude subscription didn't cure it, or there
// was no subscription token to retry with (#57).
//
// The PR isn't reviewed, so the check fails, whoever opened the PR: a
// green check would let a PR that merges itself (a Dependabot bump, the
// README screenshot bot's `bot/` branch, anything with auto-merge on)
// merge unreviewed. One PR comment, marked MARKER and kept by AUTHOR
// (lib/comment.mjs), says what wasn't reviewed, whether the subscription
// retry ran, which limit stopped it and when that resets, and to re-run the
// Claude Review job after then. A later stop updates it in place, and
// `clear` (run once no pass stopped) deletes it. Posting is best-effort: a
// token that can't comment (a fork's) is a warning, never the result.
//
// Which limit and when it resets come from the last attempt's execution
// file: the subscription's own when the retry ran. The API's error carries
// them (`rate_limit_info` on the limited message, else the rejected window
// of a `rate_limit_event` that resets last). An API credit or spend stop
// has no reset time, and the comment says so. Everything read from the file
// is untrusted: only a known limit's name, or a plain identifier, and a
// reset time in range reach the comment; the API's own text never does.
//
// CLI: `node stopped.mjs report`, with REPO, PR, GH_TOKEN (for gh) and each
// pass's outputs: REVIEW_STOPPED, REVIEW_FALLBACK, REVIEW_TURNS,
// REVIEW_FILE and the same for FOLLOWUP_ (empty when the follow-up didn't
// run). Exits 1.
// `node stopped.mjs clear`, with REPO, PR and GH_TOKEN: deletes the
// comment; exits 0 whatever happens.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { summary } from '../lib/actions.mjs';
import { findComment, ghApi } from '../lib/comment.mjs';

/** @typedef {import('../lib/comment.mjs').Api} Api */

/** The hidden first line of the comment. */
export const MARKER = '<!-- claude-review:stopped -->';
const TITLE = 'Claude Review stopped';

const LIMIT_NAMES = new Map([
  ['five_hour', '5-hour limit'],
  ['seven_day', 'weekly limit'],
  ['seven_day_opus', 'weekly Opus limit'],
  ['seven_day_sonnet', 'weekly Sonnet limit'],
]);
/** A limit type the API names that isn't known yet, shown as it is. */
const RAW_TYPE = /^[a-z0-9_]{1,40}$/;
/** 2020-01-01, in seconds: a reset before it is no reset time. */
const EARLIEST = 1_577_836_800;
const YEAR = 366 * 24 * 60 * 60;

/**
 * @typedef {object} Limit
 * @property {string | null} name which limit, for a person ("5-hour
 *   limit"), or null when the API didn't say
 * @property {string | null} resets when it resets ("2026-11-14 00:40 UTC"),
 *   or null when the API gave no usable time
 */

/**
 * @typedef {object} Stop
 * @property {'review' | 'followup'} pass which pass stopped
 * @property {'credit' | 'limit'} stopped why (sdk.mjs's stoppedBy)
 * @property {boolean} fallback whether the subscription retry ran
 * @property {Limit} limit
 * @property {number} turns the most turns an attempt at the pass ran
 *   (sdk.mjs's `turns`; 0 when unknown)
 */

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
 * @param {unknown} type
 * @returns {string | null}
 */
function limitName(type) {
  if (typeof type !== 'string') return null;
  return LIMIT_NAMES.get(type) ?? (RAW_TYPE.test(type) ? `${type} limit` : null);
}

/**
 * Of two rejected limits, the one that resets later; one without a usable
 * reset loses to one with, and between two such the newer wins.
 *
 * @param {Record<string, unknown> | undefined} current
 * @param {Record<string, unknown>} next
 * @returns {Record<string, unknown>}
 */
function later(current, next) {
  /** @param {unknown} t */
  const time = (t) => (typeof t === 'number' && Number.isFinite(t) ? t : -Infinity);
  return current && time(current.resetsAt) > time(next.resetsAt) ? current : next;
}

/**
 * Which limit an attempt stopped on and when it resets, from its messages:
 * the limited assistant message's `rate_limit_info`, else the rejected
 * `rate_limit_event` or window that resets last. With two limits reached,
 * re-running after the later reset is what works.
 *
 * @param {unknown} messages
 * @param {number} now milliseconds
 * @returns {Limit}
 */
export function limitOf(messages, now) {
  const list = Array.isArray(messages) ? messages : [];
  /** @type {Record<string, unknown> | undefined} */
  let source;
  for (const m of list) {
    if (!isObject(m) || m.type !== 'assistant' || !isObject(m.api_error_params)) continue;
    const info = m.api_error_params.rate_limit_info;
    if (isObject(info)) source = info;
  }
  if (!source) {
    for (const m of list) {
      if (!isObject(m) || m.type !== 'rate_limit_event' || !isObject(m.rate_limit_info)) continue;
      const info = m.rate_limit_info;
      if (info.status === 'rejected') source = later(source, info);
      if (!isObject(info.unifiedWindows)) continue;
      for (const [type, window] of Object.entries(info.unifiedWindows)) {
        if (isObject(window) && window.status === 'rejected') {
          source = later(source, { rateLimitType: type, resetsAt: window.resetsAt });
        }
      }
    }
  }
  return { name: limitName(source?.rateLimitType), resets: resetTime(source?.resetsAt, now) };
}

/**
 * What stopped it, in a clause: the credit, or which limit and its reset.
 *
 * @param {Stop} stop
 * @returns {string}
 */
export function reason({ stopped, limit }) {
  if (stopped === 'credit') return 'the API credit is spent, and the API gave no time it renews';
  const which = limit.name
    ? `the Claude account hit its ${limit.name}`
    : 'a spend or usage limit was reached';
  return limit.resets
    ? `${which}, which resets ${limit.resets}`
    : `${which}, and the API gave no reset time`;
}

/**
 * The comment's body.
 *
 * @param {Stop} stop
 * @returns {string}
 */
export function commentBody(stop) {
  const what =
    stop.pass === 'followup'
      ? "**Claude Review's follow-up stopped before it finished, so this PR isn't fully reviewed**"
      : stop.turns > 1
        ? `**Claude Review stopped partway (${stop.turns} turns), so this PR isn't fully reviewed**`
        : "**Claude Review didn't review this PR**";
  const retry = stop.fallback
    ? "It was retried on the owner's Claude subscription, which stopped too."
    : 'No subscription token is set (`claude_code_oauth_token`), so it was not retried.';
  const when = stop.limit.resets ? `after ${stop.limit.resets}` : 'once the credit or limit resets';
  return [
    MARKER,
    `${what}: ${reason(stop)}.`,
    '',
    retry,
    '',
    `The check fails until a review finishes. Re-run the Claude Review job ${when}.`,
  ].join('\n');
}

/**
 * Posts the comment, or edits the one there; a body already there is left.
 *
 * @param {Api} api
 * @param {string} repo
 * @param {number} pr
 * @param {string} body
 * @returns {string} what happened
 */
function keepComment(api, repo, pr, body) {
  const existing = findComment(api, repo, pr, MARKER);
  if (existing?.body === body) return 'the comment is already up to date';
  if (existing) {
    api('PATCH', `repos/${repo}/issues/comments/${existing.id}`, { body });
    return 'updated the comment';
  }
  api('POST', `repos/${repo}/issues/${pr}/comments`, { body });
  return 'posted the comment';
}

/**
 * Deletes the comment, once no pass stopped.
 *
 * @param {Api} api
 * @param {string} repo
 * @param {number} pr
 * @returns {string} what happened
 */
function clearComment(api, repo, pr) {
  const existing = findComment(api, repo, pr, MARKER);
  if (!existing) return 'no stopped-review comment to clear';
  api('DELETE', `repos/${repo}/issues/comments/${existing.id}`);
  return 'cleared the stopped-review comment';
}

/**
 * A workflow command's message, escaped as the runner expects.
 *
 * @param {string} text
 */
const escapeData = (text) =>
  text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

/**
 * The first line of a failure, for a warning.
 *
 * @param {unknown} error
 */
const firstLine = (error) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300);

/**
 * The pass that stopped (the follow-up's, when it ran and stopped), as action.yml's
 * outputs give it, with its last attempt's messages.
 *
 * @param {Record<string, string | undefined>} env
 * @param {number} now
 * @returns {Stop | null} null when neither pass stopped
 */
export function stopFrom(env, now) {
  const pass = env.FOLLOWUP_STOPPED ? 'followup' : env.REVIEW_STOPPED ? 'review' : null;
  if (!pass) return null;
  const prefix = pass === 'followup' ? 'FOLLOWUP' : 'REVIEW';
  const stopped = env[`${prefix}_STOPPED`] === 'credit' ? 'credit' : 'limit';
  /** @type {unknown} */
  let messages = [];
  try {
    messages = JSON.parse(readFileSync(env[`${prefix}_FILE`] ?? '', 'utf8'));
  } catch {
    // No file to read: the limit is unknown, and the comment says so.
  }
  return {
    pass,
    stopped,
    fallback: env[`${prefix}_FALLBACK`] === 'true',
    limit: stopped === 'credit' ? { name: null, resets: null } : limitOf(messages, now),
    turns: Number(env[`${prefix}_TURNS`]) || 0,
  };
}

/**
 * @typedef {object} Io
 * @property {(line: string) => void} log
 * @property {(markdown: string) => void} summary
 */

/**
 * Runs one of the CLI's commands; returns the exit code.
 *
 * @param {string | undefined} command
 * @param {Record<string, string | undefined>} env
 * @param {Api} api
 * @param {Io} io
 * @param {number} [now]
 * @returns {number}
 */
export function main(command, env, api, io, now = Date.now()) {
  const repo = env.REPO ?? '';
  const pr = Number(env.PR);
  if (command === 'clear') {
    try {
      io.log(`Claude Review: ${clearComment(api, repo, pr)}.`);
    } catch (error) {
      io.log(
        `::warning::Claude Review: couldn't clear the stopped-review comment: ${escapeData(firstLine(error))}`,
      );
    }
    return 0;
  }
  if (command !== 'report') {
    io.log('usage: stopped.mjs report|clear');
    return 1;
  }
  const stop = stopFrom(env, now);
  if (!stop) {
    io.log('Claude Review: no pass stopped.');
    return 1;
  }
  const retry = stop.fallback
    ? 'The retry on the Claude subscription stopped too.'
    : 'No subscription token was given to retry on.';
  const message = `${stop.pass === 'followup' ? 'The follow-up' : 'The review'} stopped: ${reason(stop)}. ${retry} The check fails until a review finishes.`;
  io.log(`::error title=${TITLE}::${escapeData(message)}`);
  io.summary(`**${TITLE}.** ${message}`);
  try {
    io.log(`Claude Review: ${keepComment(api, repo, pr, commentBody(stop))}.`);
  } catch (error) {
    io.log(
      `::warning::Claude Review: couldn't keep the stopped-review comment: ${escapeData(firstLine(error))}`,
    );
  }
  return 1;
}

/* c8 ignore start: the CLI's lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv[2], process.env, ghApi, { log: console.log, summary }));
}
/* c8 ignore stop */
