import { describe, expect, it } from 'vitest';
import { ApiError, OutOfTime, client, detailOf, pacer, retryAfter } from './github.mjs';

/** A clock that only moves when waited on. */
function fakeClock(start = 0) {
  let t = start;
  /** @type {number[]} */
  const waits = [];
  return {
    now: () => t,
    wait: async (/** @type {number} */ ms) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

/**
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
const answer = (status, body, headers = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers });

describe('pacer', () => {
  it('spaces writes by the gap', async () => {
    const clock = fakeClock();
    const pace = pacer({ clock, gapMs: 3000, perHour: 100 });
    await pace.take();
    await pace.take();
    await pace.take();
    expect(clock.waits).toEqual([3000, 3000]);
  });

  it('waits for the oldest writes to age out of the hour', async () => {
    const clock = fakeClock();
    const pace = pacer({ clock, gapMs: 0, perHour: 3 });
    await pace.take(2);
    await clock.wait(1000);
    await pace.take(1);
    await pace.take(2);
    // The first two must leave the hour before two more go.
    expect(clock.now()).toBe(3_600_000);
  });

  it('waits a gap for each write of a batch, and goes on from an earlier run', async () => {
    const clock = fakeClock();
    const pace = pacer({ clock, gapMs: 3000, perHour: 100 });
    await pace.take(10);
    await pace.take(1);
    expect(clock.waits).toEqual([30_000]);
    const history = pace.history();
    expect(history).toEqual({ times: Array(11).fill(0).fill(30_000, 10), next: 33_000 });
    // The next run waits out this one's gap, and counts its writes.
    const after = pacer({ clock, gapMs: 3000, perHour: 12, history });
    await after.take(1);
    expect(clock.now()).toBe(33_000);
    await after.take(1);
    expect(clock.now()).toBe(3_600_000);
  });

  it('refuses a batch over the hourly limit, and a wait past the deadline', async () => {
    const clock = fakeClock();
    await expect(pacer({ clock, perHour: 2 }).take(3)).rejects.toThrow(/over the 2 an hour/);
    const pace = pacer({ clock, gapMs: 3000, deadline: 2000 });
    await pace.take();
    await expect(pace.take()).rejects.toBeInstanceOf(OutOfTime);
  });
});

describe('retryAfter', () => {
  /**
   * @param {number} status
   * @param {Record<string, string>} [headers]
   */
  const r = (status, headers) => new Response('', { status, headers });

  it('honours retry-after and the rate limit reset', () => {
    expect(retryAfter(r(403, { 'retry-after': '30' }), 0, 0)).toBe(30_000);
    expect(
      retryAfter(r(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' }), 0, 50_000),
    ).toBe(51_000);
    expect(retryAfter(r(429), 1, 0)).toBe(120_000);
    expect(retryAfter(r(403), 0, 0, '{"message":"You have exceeded a secondary rate limit"}')).toBe(
      60_000,
    );
  });

  it("doesn't retry a refusal, or past its tries", () => {
    expect(retryAfter(r(403), 0, 0)).toBeNull();
    expect(retryAfter(r(404), 0, 0)).toBeNull();
    expect(retryAfter(r(429), 5, 0)).toBeNull();
    expect(retryAfter(r(502), 2, 0)).toBe(20_000);
    expect(retryAfter(r(502), 3, 0)).toBeNull();
  });
});

describe('client', () => {
  it('pages with page=N until a short page', async () => {
    /** @type {string[]} */
    const asked = [];
    const api = client({
      log: () => {},
      fetch: async (url) => {
        asked.push(String(url));
        const page = Number(new URL(String(url)).searchParams.get('page'));
        return answer(
          200,
          Array.from({ length: page === 1 ? 100 : 7 }, (_, i) => ({ i })),
        );
      },
    });
    expect(await api.list('repos/o/r/issues?state=all')).toHaveLength(107);
    expect(asked).toEqual([
      'https://api.github.com/repos/o/r/issues?state=all&per_page=100&page=1',
      'https://api.github.com/repos/o/r/issues?state=all&per_page=100&page=2',
    ]);
  });

  it('sends the token, retries a rate limit and a network error, then paces writes', async () => {
    const clock = fakeClock();
    /** @type {{ headers?: unknown; body?: unknown }[]} */
    const sent = [];
    let calls = 0;
    const api = client({
      token: 't0ken',
      clock,
      log: () => {},
      pace: pacer({ clock }),
      fetch: async (_url, init) => {
        sent.push(init ?? {});
        calls++;
        if (calls === 1) throw new Error('reset');
        if (calls === 2) return answer(429, {}, { 'retry-after': '2' });
        return answer(200, { ok: true });
      },
    });
    expect(await api.write('PATCH', 'repos/o/r/issues/1', { body: 'x' })).toEqual({ ok: true });
    expect(clock.waits).toEqual([5000, 2000]);
    const headers = /** @type {Record<string, string>} */ (sent[0].headers);
    expect(headers.authorization).toBe('Bearer t0ken');
    expect(sent[0].body).toBe('{"body":"x"}');
  });

  it('throws an ApiError with the status, and none for a 204', async () => {
    const api = client({ log: () => {}, fetch: async () => answer(404, { message: 'Not Found' }) });
    await expect(api.get('repos/o/r/issues/1')).rejects.toMatchObject({ status: 404 });
    await expect(api.get('x')).rejects.toBeInstanceOf(ApiError);
    const none = client({ log: () => {}, fetch: async () => answer(204, null) });
    expect(await none.get('x')).toBeNull();
    const notList = client({ log: () => {}, fetch: async () => answer(200, {}) });
    await expect(notList.list('x')).rejects.toThrow(/not a list/);
  });

  it('gives up on a network error after three retries', async () => {
    const clock = fakeClock();
    const api = client({
      clock,
      log: () => {},
      fetch: async () => Promise.reject(new Error('down')),
    });
    await expect(api.get('x')).rejects.toThrow('down');
    expect(clock.waits).toHaveLength(3);
  });
  it('stops rather than wait past the deadline, and marks a limit that outlasts the retries', async () => {
    const clock = fakeClock();
    const late = client({
      clock,
      deadline: 1000,
      log: () => {},
      fetch: async () => answer(429, {}, { 'retry-after': '5' }),
    });
    await expect(late.get('x')).rejects.toBeInstanceOf(OutOfTime);
    const down = client({
      clock,
      deadline: 1000,
      log: () => {},
      fetch: async () => Promise.reject(new Error('down')),
    });
    await expect(down.get('x')).rejects.toBeInstanceOf(OutOfTime);
    const limited = client({
      clock,
      log: () => {},
      fetch: async () => answer(403, { message: 'secondary rate limit' }),
    });
    await expect(limited.get('x')).rejects.toMatchObject({
      status: 403,
      limited: true,
      detail: 'secondary rate limit',
    });
  });

  it("reads GitHub's message, or the answer's start", () => {
    expect(detailOf('{"message":"Not Found"}')).toBe('Not Found');
    expect(detailOf('<html>')).toBe('<html>');
    expect(detailOf('{"x":1}')).toBe('{"x":1}');
  });
});
