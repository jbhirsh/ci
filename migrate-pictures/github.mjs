// The GitHub REST API as the migration uses it (ci#33): reads paged by an
// explicit `page=N` loop, writes paced, and both retried through GitHub's
// rate limits. Node's fetch, nothing installed.
//
// Paging: `page=N` until a short page, never the `Link` header, whose URLs
// name `repositories/<id>`, which some proxies refuse (ci#33's plan).
//
// Pacing: GitHub's secondary limit on writes that create content is 80 a
// minute and 500 an hour, so writes go at most one every `gapMs` (3 s) and
// `perHour` (450) in any hour; an attachment counts as one write, and a
// batch of them waits a gap for each. The run's writes are kept in the
// state (cli.mjs), so the next run's pacer counts them too. When the
// next write would wait past the step's deadline, the pacer throws
// OutOfTime, and the step saves its state and stops cleanly: running the
// step again from that run carries on.
//
// Retries: a 403 or 429 that GitHub marks as a rate limit (`retry-after`,
// `x-ratelimit-remaining: 0`, or "rate limit" in its message) waits as long
// as it says (retry-after's seconds, or until x-ratelimit-reset), else 60 s
// doubling, up to 5 times, each wait held between a second and an hour;
// a 5xx or a network error is retried 3 times. A wait that would end past
// the step's deadline throws OutOfTime instead. Any other answer throws an
// ApiError carrying its status, GitHub's message, and whether it was a rate
// limit still in force after the retries, which callers read (a 403 that
// isn't a limit, on an edit, is a post the token may not edit, reported
// rather than failed).

import { setTimeout as sleep } from 'node:timers/promises';

/** An answer GitHub gave that isn't a success. */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {{ detail?: string; limited?: boolean }} [options]
   *   detail: GitHub's own message; limited: a rate limit outlasting the retries
   */
  constructor(message, status, { detail = '', limited = false } = {}) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.limited = limited;
  }
}

/**
 * GitHub's `message` from an error answer's body, or its start.
 *
 * @param {string} text
 */
export function detailOf(text) {
  try {
    const { message } = JSON.parse(text);
    if (typeof message === 'string') return message.slice(0, 200);
  } catch {
    // Not JSON: its start below.
  }
  return text.slice(0, 200);
}

/** The step's time is up: save what's done and stop. */
export class OutOfTime extends Error {}

/**
 * @typedef {object} Clock
 * @property {() => number} now
 * @property {(ms: number) => Promise<unknown>} wait
 */

/** @type {Clock} */
export const realClock = { now: Date.now, wait: sleep };

/**
 * @typedef {object} PaceHistory What a pacer has sent, kept in the state
 *   so the next run's pacer counts the writes this one made.
 * @property {number[]} times when each write in the last hour went
 * @property {number} next the earliest the next write may go
 */

/**
 * Spaces writes out: a batch of `count` writes waits `gapMs` for each
 * write of the batch before it, and at most `perHour` go in any hour.
 *
 * @param {{ clock?: Clock; gapMs?: number; perHour?: number; deadline?: number; history?: PaceHistory }} [options]
 *   deadline: the clock's time after which no write may start (OutOfTime);
 *   history: an earlier run's, to go on from
 */
export function pacer({
  clock = realClock,
  gapMs = 3000,
  perHour = 450,
  deadline = Infinity,
  history = { times: [], next: 0 },
} = {}) {
  const done = [...history.times];
  let next = history.next;
  return {
    /**
     * Waits until `count` more writes may go, then counts them as gone.
     *
     * @param {number} [count]
     */
    async take(count = 1) {
      if (count > perHour) throw new Error(`a batch of ${count} is over the ${perHour} an hour`);
      const now = clock.now();
      const hourAgo = now - 3_600_000;
      while (done.length > 0 && done[0] <= hourAgo) done.shift();
      let at = Math.max(next, now);
      const over = done.length + count - perHour;
      if (over > 0) at = Math.max(at, done[over - 1] + 3_600_000);
      if (at > deadline) throw new OutOfTime('out of time for this run');
      if (at > now) await clock.wait(at - now);
      const went = clock.now();
      for (let i = 0; i < count; i++) done.push(went);
      next = went + gapMs * count;
    },
    /** @returns {PaceHistory} */
    history: () => ({ times: done.filter((t) => t > clock.now() - 3_600_000), next }),
  };
}

/** @typedef {ReturnType<typeof pacer>} Pacer */

/** The longest one retry waits, whatever the answer asks. */
const MAX_WAIT_MS = 3_600_000;

/**
 * How long to wait before retrying this answer, or null for no retry:
 * between a second and an hour.
 *
 * @param {Response} response
 * @param {number} tries the retries already made
 * @param {number} now
 * @param {string} [text] the answer's body
 */
export function retryAfter(response, tries, now, text = '') {
  const wait = rawWait(response, tries, now, text);
  return wait === null ? null : Math.min(MAX_WAIT_MS, Math.max(1000, wait));
}

/**
 * retryAfter's wait, before it's held between a second and an hour.
 *
 * @param {Response} response
 * @param {number} tries
 * @param {number} now
 * @param {string} text
 */
function rawWait(response, tries, now, text) {
  const { status, headers } = response;
  if (status >= 500) return tries < 3 ? 5000 * 2 ** tries : null;
  if (status !== 403 && status !== 429) return null;
  if (tries >= 5) return null;
  const after = headers.get('retry-after');
  if (after && /^\d+$/.test(after)) return Number(after) * 1000;
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (reset > 0) return reset * 1000 - now + 1000;
  }
  return isLimit(response, text) ? 60_000 * 2 ** tries : null;
}

/**
 * Whether an answer is a rate limit: a 429 always is, and so is a 403 that
 * says so, as GitHub's secondary limit can answer with neither header (its
 * docs: wait a minute). Any other 403 is a refusal (no permission).
 *
 * @param {Response} response
 * @param {string} text
 */
export function isLimit({ status, headers }, text) {
  if (status === 429) return true;
  return (
    status === 403 && (headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(text))
  );
}

/**
 * A client for one token.
 *
 * @param {{ token?: string; fetch?: typeof globalThis.fetch; clock?: Clock; pace?: Pacer; log?: (line: string) => void; base?: string; deadline?: number }} [options]
 *   token: none sends no Authorization header (a local run behind a proxy
 *   that adds one); pace: the writes' pacer; deadline: no retry waits past it
 */
export function client({
  token,
  fetch = globalThis.fetch,
  clock = realClock,
  pace = pacer({ clock }),
  log = console.log,
  base = 'https://api.github.com',
  deadline = Infinity,
} = {}) {
  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<unknown>}
   */
  async function call(method, path, body) {
    /** @type {Record<string, string>} */
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'jbhirsh-ci-migrate-pictures',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    for (let tries = 0; ; tries++) {
      /** @type {Response} */
      let response;
      try {
        response = await fetch(`${base}/${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (tries >= 3) throw error;
        if (clock.now() + 5000 * 2 ** tries > deadline)
          throw new OutOfTime('out of time for this run');
        await clock.wait(5000 * 2 ** tries);
        continue;
      }
      if (response.ok) return response.status === 204 ? null : response.json();
      const text = await response.text();
      const wait = retryAfter(response, tries, clock.now(), text);
      if (wait === null) {
        throw new ApiError(
          `${method} ${path}: ${response.status} ${text.slice(0, 300)}`,
          response.status,
          {
            detail: detailOf(text),
            limited: isLimit(response, text),
          },
        );
      }
      if (clock.now() + wait > deadline) throw new OutOfTime('out of time for this run');
      log(`${method} ${path}: ${response.status}; retrying in ${Math.round(wait / 1000)} s`);
      await clock.wait(wait);
    }
  }

  return {
    /** @param {string} path */
    get: (path) => call('GET', path),
    /**
     * Every item of a list, page by page.
     *
     * @param {string} path
     * @returns {Promise<Record<string, unknown>[]>}
     */
    async list(path) {
      /** @type {Record<string, unknown>[]} */
      const all = [];
      const join = path.includes('?') ? '&' : '?';
      for (let page = 1; ; page++) {
        const items = await call('GET', `${path}${join}per_page=100&page=${page}`);
        if (!Array.isArray(items)) throw new Error(`GET ${path}: not a list`);
        all.push(...items);
        if (items.length < 100) return all;
      }
    },
    /**
     * A paced write.
     *
     * @param {'PATCH' | 'PUT'} method
     * @param {string} path
     * @param {unknown} body
     */
    async write(method, path, body) {
      await pace.take();
      return call(method, path, body);
    },
    pace,
  };
}

/** @typedef {ReturnType<typeof client>} Client */
