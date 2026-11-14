import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTHOR } from '../lib/comment.mjs';
import { autoMergeOn, commentBody, main, MARKER, mustFail } from './limit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-11-13T21:54:51Z');
const REPO = 'jbhirsh/app';

/** #320's execution file, copied where a test may find it. */
function limitedFile() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'limit-')), 'execution.json');
  copyFileSync(path.join(HERE, 'fixtures', 'usage-limit.json'), file);
  return file;
}

/**
 * An execution file holding just a result.
 *
 * @param {Record<string, unknown>} result
 */
function resultFile(result) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'limit-')), 'execution.json');
  writeFileSync(
    file,
    JSON.stringify([
      { type: 'system', subtype: 'init' },
      { type: 'result', ...result },
    ]),
  );
  return file;
}

/**
 * A fake API: the PR (auto-merge on or off), its comments, and every call.
 *
 * @param {{ autoMerge?: boolean, comments?: unknown[], fail?: RegExp, pull?: unknown }} [options]
 *   fail: the routes (with their method) that throw
 */
function fakeApi({ autoMerge = false, comments = [], fail, pull } = {}) {
  /** @type {{ method: string, route: string, body?: Record<string, unknown> }[]} */
  const calls = [];
  /** @type {import('../lib/comment.mjs').Api} */
  const api = (method, route, body) => {
    calls.push({ method, route, ...(body ? { body } : {}) });
    if (fail?.test(`${method} ${route}`)) throw new Error('gh: HTTP 403\nmore');
    if (route === `repos/${REPO}/pulls/1`) {
      return pull === undefined
        ? { number: 1, auto_merge: autoMerge ? { merge_method: 'rebase' } : null }
        : pull;
    }
    if (method === 'GET' && route.startsWith(`repos/${REPO}/issues/1/comments`)) return comments;
    return {};
  };
  return { api, calls };
}

/** Captures what main logs, outputs and summarises. */
function fakeIo() {
  /** @type {string[]} */
  const log = [];
  /** @type {Record<string, string>} */
  const outputs = {};
  /** @type {string[]} */
  const summaries = [];
  return {
    log,
    outputs,
    summaries,
    io: {
      log: (/** @type {string} */ line) => log.push(line),
      output: (/** @type {string} */ name, /** @type {string} */ value) => {
        outputs[name] = value;
      },
      summary: (/** @type {string} */ markdown) => summaries.push(markdown),
    },
  };
}

const person = {
  REPO,
  PR: '1',
  PR_AUTHOR: 'jbhirsh',
  PR_AUTHOR_TYPE: 'User',
  HEAD_REF: 'feature/x',
};

/**
 * Runs main on #320's execution file.
 *
 * @param {Record<string, string>} env
 * @param {Parameters<typeof fakeApi>[0]} [apiOptions]
 * @param {string} [command]
 */
function runLimited(env, apiOptions, command = 'review') {
  const { api, calls } = fakeApi(apiOptions);
  const out = fakeIo();
  const code = main([command, limitedFile()], env, api, out.io, NOW);
  return { code, calls, ...out };
}

describe('mustFail', () => {
  const pr = { author: 'jbhirsh', authorType: 'User', headRef: 'feature/x' };

  it("passes only a person's PR, from a person's branch, without auto-merge", () => {
    expect(mustFail(pr, false)).toEqual({ fail: false, why: "a person's PR without auto-merge" });
    expect(mustFail({ ...pr, author: 'dependabot[bot]', authorType: 'Bot' }, false).fail).toBe(
      true,
    );
    expect(mustFail({ ...pr, author: 'github-actions[bot]', authorType: '' }, false).fail).toBe(
      true,
    );
    expect(mustFail({ ...pr, authorType: 'Bot' }, false).fail).toBe(true);
    expect(mustFail({ ...pr, headRef: 'bot/readme-screenshots' }, false).why).toContain('bot/');
    expect(mustFail({ ...pr, headRef: 'dependabot/npm_and_yarn/x' }, false).fail).toBe(true);
    expect(mustFail(pr, true).why).toContain('auto-merge is on');
    expect(mustFail(pr, null).why).toContain("couldn't be read");
    expect(mustFail({ ...pr, author: '' }, false).fail).toBe(true);
  });
});

describe('autoMergeOn', () => {
  it('reads auto-merge live, and gives null when it cannot', () => {
    expect(autoMergeOn(fakeApi({ autoMerge: true }).api, REPO, 1)).toBe(true);
    expect(autoMergeOn(fakeApi().api, REPO, 1)).toBe(false);
    expect(autoMergeOn(fakeApi({ fail: /pulls/ }).api, REPO, 1)).toBeNull();
    expect(autoMergeOn(fakeApi({ pull: { number: 1 } }).api, REPO, 1)).toBeNull();
    expect(autoMergeOn(fakeApi({ pull: null }).api, REPO, 1)).toBeNull();
  });
});

describe('main on a usage limit', () => {
  it("passes a person's PR with a warning, a summary, limited=true and a comment", () => {
    const { code, log, outputs, summaries, calls } = runLimited(person);
    expect(code).toBe(0);
    expect(log[0]).toBe(
      'Claude Review: the pass stopped on a usage limit after 1 turn: the Claude account hit its 5-hour limit, which resets 2026-11-14 00:40 UTC; re-run this job after then.',
    );
    expect(log[1]).toMatch(
      /^::warning title=Claude Review stopped on a usage limit::the pass stopped/,
    );
    expect(log[1]).toContain('The check passes with this warning');
    expect(log.join('\n')).not.toContain('ended with success');
    expect(outputs).toEqual({ limited: 'true' });
    expect(summaries[0]).toContain('**Claude Review stopped on a usage limit.**');
    expect(summaries[0]).toContain('re-run this job after then');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.route).toBe(`repos/${REPO}/issues/1/comments`);
    expect(post?.body?.body).toContain("**Claude Review didn't review this PR**");
    expect(post?.body?.body).toContain('re-run the Claude Review job after then');
    expect(post?.body?.body).toContain('on the strength of a green check');
    expect(log.at(-1)).toBe('Claude Review: posted the usage-limit comment.');
  });

  it("fails a bot's PR, a bot's branch (#320's), auto-merge on, and a lookup that throws", () => {
    for (const [env, options] of /** @type {const} */ ([
      [
        {
          ...person,
          PR_AUTHOR: 'dependabot[bot]',
          PR_AUTHOR_TYPE: 'Bot',
          HEAD_REF: 'dependabot/npm_and_yarn/x',
        },
        {},
      ],
      [{ ...person, PR_AUTHOR: 'github-actions[bot]', PR_AUTHOR_TYPE: 'Bot' }, {}],
      [{ ...person, HEAD_REF: 'bot/readme-screenshots' }, {}],
      [person, { autoMerge: true }],
      [person, { fail: /^GET .*pulls/ }],
      [{ ...person, PR: '' }, {}],
    ])) {
      const { code, log, outputs, calls } = runLimited(env, options);
      expect(code).toBe(1);
      expect(log[1]).toMatch(/^::error title=Claude Review stopped on a usage limit::/);
      expect(log[1]).toContain('5-hour limit, which resets 2026-11-14 00:40 UTC');
      expect(outputs.limited).toBe('true');
      const post = calls.find((c) => c.method === 'POST');
      if (env.PR) expect(post?.body?.body).toContain('The check fails until a review finishes');
      else expect(post).toBeUndefined();
    }
  });

  it('updates its own comment in place, leaving one with its marker by anyone else', () => {
    const comments = [
      { id: 5, body: `${MARKER}\nby someone else`, user: { login: 'jbhirsh' } },
      { id: 9, body: `${MARKER}\nold`, user: { login: AUTHOR } },
    ];
    const { calls, log } = runLimited(person, { comments });
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([
      { method: 'PATCH', route: `repos/${REPO}/issues/comments/9`, body: expect.any(Object) },
    ]);
    expect(log.at(-1)).toBe('Claude Review: updated the usage-limit comment.');
  });

  it('leaves a comment that already says the same', () => {
    const body = runLimited(person).calls.find((c) => c.method === 'POST')?.body?.body;
    const { calls, log } = runLimited(person, {
      comments: [{ id: 9, body, user: { login: AUTHOR } }],
    });
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(log.at(-1)).toBe('Claude Review: the usage-limit comment is already up to date.');
  });

  it('warns when the comment cannot be kept, and leaves the result alone', () => {
    const { code, log } = runLimited(person, { fail: /^POST/ });
    expect(code).toBe(0);
    expect(log.at(-1)).toBe(
      "::warning::Claude Review: couldn't keep the usage-limit comment: gh: HTTP 403",
    );
  });

  it('lists the files still unread after a limited follow-up, as code', () => {
    const env = { ...person, UNREAD: 'src/a.ts\n`@x`.md\n' };
    const { code, log, calls } = runLimited(env, {}, 'followup');
    expect(code).toBe(0);
    expect(log[1]).toContain('2 file(s) are still unread.');
    const body = calls.find((c) => c.method === 'POST')?.body?.body;
    expect(body).toContain('**Claude Review stopped before reading every file**');
    expect(body).toContain("- `src/a.ts`\n- `'@x'.md`");
  });

  it('only notes a limited follow-up that left nothing unread', () => {
    const { code, log, outputs, calls } = runLimited({ ...person, UNREAD: '' }, {}, 'followup');
    expect(code).toBe(0);
    expect(log[1]).toContain('nothing went unreviewed');
    expect(outputs).toEqual({});
    expect(calls).toEqual([]);
  });
});

describe('main otherwise', () => {
  it('passes a finished review and fails any other ending, as before', () => {
    const { api, calls } = fakeApi();
    const out = fakeIo();
    expect(
      main(['review', resultFile({ subtype: 'success', num_turns: 201 })], person, api, out.io),
    ).toBe(0);
    expect(
      main(
        ['review', resultFile({ subtype: 'error_max_turns', num_turns: 200 })],
        person,
        api,
        out.io,
      ),
    ).toBe(1);
    expect(main(['followup'], person, api, out.io)).toBe(1);
    expect(out.log).toEqual([
      'Claude Review: the pass finished after 201 turns, past its turn cap or not.',
      'Claude Review: the pass ended with error_max_turns after 200 turns.',
      'Claude Review: no execution file.',
    ]);
    expect(out.outputs).toEqual({});
    expect(calls).toEqual([]);
  });

  it('refuses an unknown command', () => {
    const out = fakeIo();
    expect(main(['nope'], person, fakeApi().api, out.io)).toBe(1);
    expect(out.log[0]).toContain('unknown command nope');
  });
});

describe('main clear', () => {
  it('deletes its comment, and says when there is none', () => {
    const comments = [{ id: 9, body: `${MARKER}\nold`, user: { login: AUTHOR } }];
    const { api, calls } = fakeApi({ comments });
    const out = fakeIo();
    expect(main(['clear'], person, api, out.io)).toBe(0);
    expect(calls.at(-1)).toEqual({ method: 'DELETE', route: `repos/${REPO}/issues/comments/9` });
    expect(main(['clear'], person, fakeApi().api, out.io)).toBe(0);
    expect(out.log).toEqual([
      'Claude Review: cleared the usage-limit comment.',
      'Claude Review: no usage-limit comment to clear.',
    ]);
  });

  it('only warns when it cannot', () => {
    const out = fakeIo();
    expect(main(['clear'], person, fakeApi({ fail: /comments/ }).api, out.io)).toBe(0);
    expect(main(['clear'], { REPO }, fakeApi().api, out.io)).toBe(0);
    expect(out.log[0]).toBe(
      "::warning::Claude Review: couldn't clear the usage-limit comment: gh: HTTP 403",
    );
    expect(out.log[1]).toContain('REPO and PR are needed');
  });
});

describe('commentBody', () => {
  const limit = { name: '5-hour limit', resets: null, turns: 7, text: 'Out of `credits` @team' };

  it('says how far a longer pass got, and quotes the API as code without a reset time', () => {
    const body = commentBody(limit, [], false);
    expect(body.startsWith(`${MARKER}\n**Claude Review stopped partway (7 turns)**`)).toBe(true);
    expect(body).toContain(
      "no reset time; re-run the Claude Review job once it resets (it said: `Out of 'credits' @team`)",
    );
  });

  it('caps the list of unread files', () => {
    const files = Array.from({ length: 60 }, (_, i) => `f${i}.ts`);
    const body = commentBody(limit, files, true);
    expect(body).toContain('- `f49.ts`\n- and 10 more');
    expect(body).not.toContain('f50.ts');
  });
});
