import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitHubIo, main, parseTarget } from './run.mjs';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseTarget', () => {
  it('reads what find.mjs writes, and nothing else', () => {
    expect(parseTarget('{"kind":"pr","number":5,"run":11}')).toEqual({
      kind: 'pr',
      number: 5,
      run: 11,
    });
    expect(parseTarget('{"kind":"issue","run":3}')).toEqual({ kind: 'issue', run: 3 });
    for (const bad of [
      '{"kind":"pr","run":1}',
      '{"kind":"x","run":1}',
      '{"kind":"issue","run":0}',
    ]) {
      expect(() => parseTarget(bad)).toThrow(/not a review target/);
    }
  });
});

describe('main', () => {
  it('needs the settings, and BOT_PR_TOKEN', () => {
    const none = mkdtempSync(path.join(tmpdir(), 'app-'));
    vi.stubEnv('APP_ROOT', none);
    expect(() => main({})).toThrow(/no visual-review key/);
    const root = mkdtempSync(path.join(tmpdir(), 'app-'));
    mkdirSync(path.join(root, '.github'));
    writeFileSync(
      path.join(root, '.github/ci.json'),
      JSON.stringify({ 'visual-review': { workflow: 'v.yml', job: 'v', folders: ['f'] } }),
    );
    vi.stubEnv('APP_ROOT', root);
    /** @type {unknown[]} */
    const posted = [];
    /** @type {import('../lib/comment.mjs').Api} */
    const api = (method, route, body) => {
      if (method === 'POST') posted.push(body);
      return { head_sha: 'a'.repeat(40) };
    };
    expect(() =>
      main({ GITHUB_REPOSITORY: 'a/b', TARGET: '{"kind":"pr","number":5,"run":1}' }, { api }),
    ).toThrow(/BOT_PR_TOKEN is missing/);
    // The required check says why, rather than never reporting.
    expect(posted).toEqual([
      {
        state: 'failure',
        context: 'Visual changes',
        description: expect.stringMatching(/^Visual review failed: BOT_PR_TOKEN is missing/),
      },
    ]);
  });
  it('keeps the first error when posting the failure status fails too', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'app-'));
    mkdirSync(path.join(root, '.github'));
    writeFileSync(
      path.join(root, '.github/ci.json'),
      JSON.stringify({ 'visual-review': { workflow: 'v.yml', job: 'v', folders: ['f'] } }),
    );
    vi.stubEnv('APP_ROOT', root);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    /** @type {import('../lib/comment.mjs').Api} */
    const api = () => {
      throw new Error('HTTP 502');
    };
    expect(() =>
      main({ GITHUB_REPOSITORY: 'a/b', TARGET: '{"kind":"pr","number":5,"run":1}' }, { api }),
    ).toThrow(/BOT_PR_TOKEN is missing/);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/Couldn't post the failure status.*502/),
    );
    warn.mockRestore();
  });
});

describe('main, against a fake gh', () => {
  it('wires each call to the right token and command', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'app-'));
    mkdirSync(path.join(root, '.github'));
    writeFileSync(
      path.join(root, '.github/ci.json'),
      JSON.stringify({ 'visual-review': { workflow: 'v.yml', job: 'v', folders: ['f'] } }),
    );
    vi.stubEnv('APP_ROOT', root);
    /** @type {[string, string[]][]} */
    const calls = [];
    const gh = (/** @type {string} */ token, /** @type {string[]} */ args) => {
      calls.push([token, args]);
      if (args[1] === 'user') return 'jbhirsh\n';
      return '';
    };
    /** @type {import('../lib/comment.mjs').Api} */
    const api = (method, route) => {
      if (route.endsWith('/actions/runs/1')) {
        return { id: 1, head_sha: 'a'.repeat(40), conclusion: 'success' };
      }
      if (route.includes('/artifacts')) return { artifacts: [] };
      if (route.endsWith('/pulls/5')) return { head: { sha: 'a'.repeat(40) } };
      if (route.includes('/statuses?')) return [];
      if (route.includes('/jobs')) return { jobs: [] };
      if (route.includes('/comments')) return [];
      if (route.includes('/files')) return [];
      if (route.includes('/status')) return { statuses: [] };
      if (method === 'POST') return {};
      throw new Error(route);
    };
    // A gh that answers GraphQL for the PR.
    const withGraphql = (/** @type {string} */ token, /** @type {string[]} */ args) =>
      args[1] === 'graphql'
        ? JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  author: { login: 'jbhirsh', __typename: 'User' },
                  headRefName: 'x',
                  body: '',
                  state: 'OPEN',
                  autoMergeRequest: null,
                },
              },
            },
          })
        : gh(token, args);
    expect(
      main(
        {
          GITHUB_REPOSITORY: 'jbhirsh/app',
          GH_TOKEN: 'actions',
          UPLOAD_TOKEN: 'bot',
          UPLOAD_LOGIN: 'jbhirsh',
          TARGET: '{"kind":"pr","number":5,"run":1}',
        },
        { gh: withGraphql, api },
      ),
    ).toBe(5);
    expect(calls[0]).toEqual(['bot', ['api', 'user', '--jq', '.login']]);
    expect(calls.find(([, a]) => a[0] === 'run')).toEqual(undefined);
  });
});

describe('gitHubIo', () => {
  /** @type {[string, string[]][]} */
  let calls;
  /** @param {(args: string[]) => string} answer */
  const io = (answer) => {
    calls = [];
    return gitHubIo({
      env: { OWNER: 'jbhirsh', DEFAULT_BRANCH: 'trunk', UPLOAD_LOGIN: 'jbhirsh' },
      repo: 'jbhirsh/app',
      token: 'actions',
      upload: 'bot',
      gh: (token, args) => {
        calls.push([token, args]);
        return answer(args);
      },
      api: (method, route) =>
        route.includes('/runs/3/')
          ? { artifacts: [{ expired: false }] }
          : route.includes('/runs/4/')
            ? { artifacts: [{ expired: true }] }
            : { artifacts: [] },
    });
  };

  it('posts and edits the upload comment with BOT_PR_TOKEN only', () => {
    const g = io(() => 'https://github.com/jbhirsh/app/pull/5#issuecomment-42\n');
    expect(g.main).toBe('trunk');
    expect(g.upload('pr', 5, 'body', ['/t/01.png'])).toBe(42);
    expect(calls[0]).toEqual([
      'bot',
      ['pr', 'comment', '5', '--repo', 'jbhirsh/app', '--body', 'body', '--attach', '/t/01.png'],
    ]);
    g.upload('issue', 9, 'b', []);
    expect(calls[1][1][0]).toBe('issue');
    g.editComment(42, 'new');
    expect(calls[2]).toEqual([
      'bot',
      ['api', '-X', 'PATCH', 'repos/jbhirsh/app/issues/comments/42', '-f', 'body=new'],
    ]);
  });

  it("stops when gh doesn't name the comment", () => {
    expect(() => io(() => 'done').upload('pr', 5, 'b', [])).toThrow(/didn't say/);
  });

  it('downloads with the Actions token, and asks GraphQL with typed variables', () => {
    const g = io((args) => (args[1] === 'graphql' ? '{"data":{"x":1}}' : ''));
    expect(g.artifact(3, '/d')).toBe('ok');
    expect(calls[0]).toEqual([
      'actions',
      ['run', 'download', '3', '--repo', 'jbhirsh/app', '--name', 'visual-shots', '--dir', '/d'],
    ]);
    expect(g.graphql('q', { owner: 'a', number: 5 })).toEqual({ x: 1 });
    expect(calls[1][1]).toEqual([
      'api',
      'graphql',
      '-f',
      'query=q',
      '-f',
      'owner=a',
      '-F',
      'number=5',
    ]);
    expect(typeof g.now()).toBe('number');
    expect(g.artifact(4, '/d')).toBe('expired');
    expect(g.artifact(5, '/d')).toBe('none');
  });

  it('lets a failed download throw, never reading as no shots', () => {
    const g = io((args) => {
      if (args[0] === 'run') throw new Error('HTTP 502');
      return '';
    });
    expect(() => g.artifact(3, '/d')).toThrow(/502/);
  });
});
