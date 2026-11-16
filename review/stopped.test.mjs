import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTHOR } from '../lib/comment.mjs';
import { MARKER, commentBody, limitOf, main, reason, stopFrom } from './stopped.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'usage-limit.json');
/** #320's run, the 13th of November 2026. */
const NOW = Date.UTC(2026, 10, 13, 22);
/** @type {unknown[]} */
const limited = JSON.parse(readFileSync(FIXTURE, 'utf8'));

/**
 * A fake GitHub API holding a PR's comments, recording each write.
 *
 * @param {{ id: number, body: string, user: { login: string } }[]} [comments]
 * @param {{ fails?: boolean }} [behaviour]
 */
function fakeApi(comments = [], behaviour = {}) {
  /** @type {[string, string, unknown][]} */
  const writes = [];
  /** @type {import('../lib/comment.mjs').Api} */
  const api = (method, route, body) => {
    if (behaviour.fails) throw new Error('gh: Forbidden (HTTP 403)\nmore');
    if (method === 'GET') return route.endsWith('page=1') ? comments : [];
    writes.push([method, route, body]);
    return null;
  };
  return { api, writes };
}

function io() {
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const summaries = [];
  return {
    lines,
    summaries,
    io: {
      log: (/** @type {string} */ l) => lines.push(l),
      summary: (/** @type {string} */ m) => summaries.push(m),
    },
  };
}

describe('limitOf', () => {
  it("reads #320's 5-hour limit and its reset from the limited message", () => {
    expect(limitOf(limited, NOW)).toEqual({ name: '5-hour limit', resets: '2026-11-14 00:40 UTC' });
  });
  it('falls back to the rejected window that resets last', () => {
    const events = [
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          unifiedWindows: {
            five_hour: { status: 'rejected', resetsAt: 1794616800 },
            seven_day: { status: 'rejected', resetsAt: 1794711600 },
            seven_day_opus: { status: 'allowed_warning', resetsAt: 1794800000 },
          },
        },
      },
    ];
    expect(limitOf(events, NOW)).toEqual({ name: 'weekly limit', resets: '2026-11-15 03:00 UTC' });
  });
  it('gives no name or time it cannot trust', () => {
    const odd = (/** @type {unknown} */ info) => [
      { type: 'assistant', api_error_params: { rate_limit_info: info } },
    ];
    expect(limitOf(odd({ rateLimitType: 'new_window', resetsAt: 1 }), NOW)).toEqual({
      name: 'new_window limit',
      resets: null,
    });
    expect(limitOf(odd({ rateLimitType: '<b>@owner</b>', resetsAt: 9e12 }), NOW)).toEqual({
      name: null,
      resets: null,
    });
    expect(limitOf(null, NOW)).toEqual({ name: null, resets: null });
  });
});

describe('commentBody', () => {
  const stop = /** @type {import('./stopped.mjs').Stop} */ ({
    pass: 'review',
    stopped: 'limit',
    fallback: true,
    limit: { name: '5-hour limit', resets: '2026-11-14 00:40 UTC' },
    turns: 1,
  });
  it('says the PR is not reviewed, the retry, the limit, its reset, and to re-run', () => {
    expect(commentBody(stop)).toBe(
      [
        MARKER,
        "**Claude Review didn't review this PR**: the Claude account hit its 5-hour limit, which resets 2026-11-14 00:40 UTC.",
        '',
        "It was retried on the owner's Claude subscription, which stopped too.",
        '',
        'The check fails until a review finishes. Re-run the Claude Review job after 2026-11-14 00:40 UTC.',
      ].join('\n'),
    );
  });
  it('says a partial pass, a follow-up, no retry and no reset time', () => {
    expect(commentBody({ ...stop, turns: 12 })).toContain('stopped partway (12 turns)');
    expect(commentBody({ ...stop, pass: 'followup' })).toContain(
      'follow-up stopped before it finished',
    );
    const credit = commentBody({
      ...stop,
      stopped: 'credit',
      fallback: false,
      limit: { name: null, resets: null },
    });
    expect(credit).toContain('the API credit is spent, and the API gave no time it renews');
    expect(credit).toContain('so it was not retried');
    expect(credit).toContain('job once the credit or limit resets.');
    expect(reason({ ...stop, limit: { name: null, resets: null } })).toBe(
      'a spend or usage limit was reached, and the API gave no reset time',
    );
  });
});

describe('stopFrom', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stopped-'));
  it("takes the follow-up's stop when it ran, else the review's", () => {
    const followup = path.join(dir, 'f.json');
    writeFileSync(followup, JSON.stringify([{ type: 'result', num_turns: 2 }]));
    expect(
      stopFrom(
        {
          REVIEW_STOPPED: '',
          REVIEW_FALLBACK: 'true',
          REVIEW_FILE: FIXTURE,
          FOLLOWUP_STOPPED: 'credit',
          FOLLOWUP_FALLBACK: '',
          FOLLOWUP_TURNS: '7',
          FOLLOWUP_FILE: followup,
        },
        NOW,
      ),
    ).toEqual({
      pass: 'followup',
      stopped: 'credit',
      fallback: false,
      limit: { name: null, resets: null },
      turns: 7,
    });
    // The most turns an attempt ran, not the retry's: the API attempt got further.
    expect(
      stopFrom(
        {
          REVIEW_STOPPED: 'limit',
          REVIEW_FALLBACK: 'true',
          REVIEW_TURNS: '40',
          REVIEW_FILE: FIXTURE,
        },
        NOW,
      ),
    ).toMatchObject({ pass: 'review', fallback: true, turns: 40, limit: { name: '5-hour limit' } });
    expect(stopFrom({}, NOW)).toBeNull();
  });
  it('reads no limit from a missing file', () => {
    expect(stopFrom({ REVIEW_STOPPED: 'limit', REVIEW_FILE: path.join(dir, 'none') }, NOW)).toEqual(
      {
        pass: 'review',
        stopped: 'limit',
        fallback: false,
        limit: { name: null, resets: null },
        turns: 0,
      },
    );
  });
});

describe('main', () => {
  const env = {
    REPO: 'o/r',
    PR: '9',
    REVIEW_STOPPED: 'limit',
    REVIEW_FALLBACK: 'true',
    REVIEW_FILE: FIXTURE,
  };

  it('fails the check, saying why, and posts the comment', () => {
    const { api, writes } = fakeApi();
    const out = io();
    expect(main('report', env, api, out.io, NOW)).toBe(1);
    expect(out.lines[0]).toMatch(
      /^::error title=Claude Review stopped::The review stopped: the Claude account hit its 5-hour limit/,
    );
    expect(out.summaries[0]).toContain('The check fails until a review finishes.');
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe('POST');
    expect(writes[0][1]).toBe('repos/o/r/issues/9/comments');
  });

  it('updates the comment in place, and leaves one already up to date', () => {
    const { api: first, writes: posted } = fakeApi();
    main('report', env, first, io().io, NOW);
    const body = /** @type {{ body: string }} */ (posted[0][2]).body;
    const same = fakeApi([{ id: 4, body, user: { login: AUTHOR } }]);
    main('report', env, same.api, io().io, NOW);
    expect(same.writes).toEqual([]);
    const old = fakeApi([{ id: 4, body: `${MARKER}\nold`, user: { login: AUTHOR } }]);
    main('report', env, old.api, io().io, NOW);
    expect(old.writes).toEqual([['PATCH', 'repos/o/r/issues/comments/4', { body }]]);
  });

  it('still fails when the comment cannot be posted, with a warning', () => {
    const out = io();
    expect(main('report', env, fakeApi([], { fails: true }).api, out.io, NOW)).toBe(1);
    expect(out.lines[1]).toBe(
      "::warning::Claude Review: couldn't keep the stopped-review comment: gh: Forbidden (HTTP 403)",
    );
  });

  it('clears the comment, never failing', () => {
    const there = fakeApi([{ id: 4, body: `${MARKER}\nx`, user: { login: AUTHOR } }]);
    const out = io();
    expect(main('clear', env, there.api, out.io, NOW)).toBe(0);
    expect(there.writes).toEqual([['DELETE', 'repos/o/r/issues/comments/4', undefined]]);
    expect(out.lines[0]).toBe('Claude Review: cleared the stopped-review comment.');
    const none = io();
    expect(main('clear', env, fakeApi().api, none.io, NOW)).toBe(0);
    expect(none.lines[0]).toBe('Claude Review: no stopped-review comment to clear.');
    const broken = io();
    expect(main('clear', env, fakeApi([], { fails: true }).api, broken.io, NOW)).toBe(0);
    expect(broken.lines[0]).toMatch(/^::warning::/);
  });

  it('refuses a bad command, and a report with no stop', () => {
    const out = io();
    expect(main('nope', env, fakeApi().api, out.io, NOW)).toBe(1);
    expect(main(undefined, env, fakeApi().api, out.io, NOW)).toBe(1);
    expect(main('report', { REPO: 'o/r', PR: '9' }, fakeApi().api, out.io, NOW)).toBe(1);
    expect(out.lines).toContain('Claude Review: no pass stopped.');
  });
});
