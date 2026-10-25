import { describe, expect, it } from 'vitest';
import { annotations, body, main, parseCommit, prCommits, problems } from './check.mjs';

const TRAILERS = 'Co-Authored-By: Claude <noreply@anthropic.com>';

/** @param {string} message */
const commit = (message, { login = 'me', parents = 1 } = {}) => ({
  sha: 'abc1234',
  login,
  parents,
  message,
});

describe('body', () => {
  it('is what follows the blank line, without the closing trailers', () => {
    expect(body(`Subject\n\nWhy it matters.\n\n${TRAILERS}`)).toBe('Why it matters.');
    expect(body(`Subject\n\nOne.\n\nTwo.\n\nKey: value\nOther: x`)).toBe('One.\n\nTwo.');
  });

  it('counts trailers alone as no body', () => {
    expect(body(`Subject\n\n${TRAILERS}\nClaude-Session: https://x`)).toBe('');
    expect(body('Subject')).toBe('');
    expect(body('Subject\n\n\n\n')).toBe('');
  });

  it('keeps a lone "Key: value" paragraph that names no known trailer', () => {
    expect(body('Subject\n\nWhy: the cache was stale.')).toBe('Why: the cache was stale.');
  });

  it('keeps a last paragraph with a line that is not a trailer', () => {
    expect(body(`Subject\n\nBody.\n\n${TRAILERS}\nand more`)).toBe(
      `Body.\n\n${TRAILERS}\nand more`,
    );
  });
});

describe('problems', () => {
  it('passes a good message', () => {
    expect(problems(commit(`Fix the thing\n\nBecause it broke.\n\n${TRAILERS}`))).toEqual([]);
  });

  it('exempts Dependabot', () => {
    expect(problems(commit('Bump x', { login: 'dependabot[bot]' }))).toEqual([]);
  });

  it('reports a merge commit and nothing else', () => {
    expect(problems(commit('Merge main', { parents: 2 }))).toEqual([
      'merge commit. Rebase onto main instead of merging it in.',
    ]);
  });

  it('counts the subject in characters, up to 72', () => {
    const ok = 'a'.repeat(71) + '🎉';
    expect(problems(commit(`${ok}\n\nBody.`))).toEqual([]);
    expect(problems(commit(`${'a'.repeat(73)}\n\nBody.`))).toEqual([
      'subject is 73 characters; the limit is 72.',
    ]);
  });

  it.each(['fixup! Fix', 'squash! Fix', 'amend! Fix', 'WIP', 'wip: more', 'Oops.', 'oops'])(
    'asks to squash "%s"',
    (subject) => {
      expect(problems(commit(`${subject}\n\nBody.`))).toContain(
        'squash this into the commit it patches.',
      );
    },
  );

  it('leaves subjects that only start like one', () => {
    expect(problems(commit('Wipe the cache\n\nBody.'))).toEqual([]);
    expect(problems(commit('Oopsie-proof the form\n\nBody.'))).toEqual([]);
  });

  it('wants a blank line after the subject and a body', () => {
    expect(problems(commit('Subject\nBody right away.'))).toEqual([
      'the subject needs a blank line after it.',
      'no body. Add one explaining why the change is needed.',
    ]);
    expect(problems(commit(`Subject\n\n${TRAILERS}`))).toEqual([
      'no body. Add one explaining why the change is needed.',
    ]);
  });
});

describe('annotations', () => {
  it('names the commit and its subject', () => {
    expect(annotations([commit('WIP\n\nBody.'), commit('Good\n\nBody.')])).toEqual([
      '::error title=Commit abc1234::"WIP": squash this into the commit it patches.',
    ]);
  });
});

describe('parseCommit', () => {
  it('reads one line of the API output', () => {
    expect(parseCommit('{"sha":"a","login":"","parents":1,"message":"m"}')).toEqual({
      sha: 'a',
      login: '',
      parents: 1,
      message: 'm',
    });
  });

  it('refuses anything else', () => {
    expect(() => parseCommit('{"sha":"a"}')).toThrow('unexpected commit');
    expect(() => parseCommit('null')).toThrow('unexpected commit');
  });
});

describe('prCommits', () => {
  it("pages through the PR's commits", () => {
    /** @type {string[][]} */
    const calls = [];
    const run = (/** @type {string[]} */ args) => {
      calls.push(args);
      return '{"sha":"a","login":"x","parents":1,"message":"A"}\n\n{"sha":"b","login":"y","parents":2,"message":"B"}\n';
    };
    expect(prCommits('o/r', '5', run).map((c) => c.sha)).toEqual(['a', 'b']);
    expect(calls[0].slice(0, 3)).toEqual(['api', '--paginate', 'repos/o/r/pulls/5/commits']);
  });
});

describe('main', () => {
  const env = { GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '5' };
  const api =
    (/** @type {string[]} */ ...messages) =>
    () =>
      messages
        .map((message) => JSON.stringify({ sha: 'a', login: 'me', parents: 1, message }))
        .join('\n');

  it('passes when every message does', () => {
    const lines = /** @type {string[]} */ ([]);
    expect(main(env, api('Good\n\nBody.'), (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual(['All commit messages pass.']);
  });

  it('fails with an annotation per problem and how to fix it', () => {
    const lines = /** @type {string[]} */ ([]);
    expect(main(env, api('WIP'), (l) => lines.push(l))).toBe(1);
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toContain('git rebase -i origin/main');
  });

  it('needs the repository and the PR', () => {
    expect(() => main({}, api())).toThrow('GITHUB_REPOSITORY and PR_NUMBER');
  });
});
