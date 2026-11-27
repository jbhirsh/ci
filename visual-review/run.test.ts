import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitHubIo, main, parseTarget } from './run.ts';
import type { Api } from '../lib/comment.ts';
import type { Handoff } from './review.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseTarget', () => {
  it('reads what find.ts writes, and nothing else', () => {
    expect(parseTarget('{"kind":"pr","number":5,"run":11}')).toEqual({
      kind: 'pr',
      number: 5,
      run: 11,
    });
    expect(parseTarget('{"kind":"issue","number":9,"run":3}')).toEqual({
      kind: 'issue',
      number: 9,
      run: 3,
    });
    for (const bad of [
      '{"kind":"pr","run":1}',
      '{"kind":"x","number":1,"run":1}',
      '{"kind":"issue","run":3}',
      '{"kind":"issue","number":9,"run":0}',
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
    const posted: unknown[] = [];
    const api: Api = (method, route, body) => {
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
    expect(() =>
      main(
        {
          GITHUB_REPOSITORY: 'a/b',
          UPLOAD_TOKEN: 'bot',
          TARGET: '{"kind":"pr","number":5,"run":1}',
        },
        { api, gh: () => 'jbhirsh\n' },
      ),
    ).toThrow(/HANDOFF_DIR is missing/);
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
    const api: Api = () => {
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
    const calls: [string, string[]][] = [];
    const gh = (token: string, args: string[]) => {
      calls.push([token, args]);
      if (args[1] === 'user') return 'jbhirsh\n';
      return '';
    };
    const api: Api = (method, route) => {
      if (route.endsWith('/actions/runs/1')) {
        return { id: 1, head_sha: 'a'.repeat(40), conclusion: 'success' };
      }
      if (route.includes('/artifacts')) return { artifacts: [] };
      if (route.endsWith('/pulls/5')) return { head: { sha: 'a'.repeat(40) }, body: '' };
      if (route.includes('/pulls/5/commits')) return [];
      if (route.includes('/statuses?')) return [];
      if (route.includes('/jobs')) return { jobs: [] };
      if (route.includes('/comments')) return [];
      if (route.includes('/files')) return [];
      if (route.includes('/status')) return { statuses: [] };
      if (method === 'POST') return {};
      throw new Error(route);
    };
    // A gh that answers GraphQL for the PR.
    const withGraphql = (token: string, args: string[]) =>
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
                  timelineItems: { nodes: [] },
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
          HANDOFF_DIR: mkdtempSync(path.join(tmpdir(), 'handoff-')),
        },
        { gh: withGraphql, api },
      ),
    ).toBe(5);
    expect(calls[0]).toEqual(['bot', ['api', 'user', '--jq', '.login']]);
    expect(calls.find(([, a]) => a[0] === 'run')).toEqual(undefined);
  });
});

describe('gitHubIo', () => {
  let calls: [string, string[]][];
  let told: number;
  const dir = mkdtempSync(path.join(tmpdir(), 'handoff-'));
  const io = (answer: (args: string[]) => string) => {
    calls = [];
    told = 0;
    return gitHubIo({
      env: { OWNER: 'jbhirsh', DEFAULT_BRANCH: 'trunk', UPLOAD_LOGIN: 'jbhirsh' },
      repo: 'jbhirsh/app',
      token: 'actions',
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
      handoffDir: path.join(dir, 'out'),
      handedOff: () => {
        told++;
      },
    });
  };

  it('writes the hand-off and its pictures where the action uploads them', () => {
    const g = io(() => '');
    expect(g.main).toBe('trunk');
    expect(g.uploader).toBe('jbhirsh');
    const handoff = { version: 1, pictures: ['01.png'] } as unknown as Handoff;
    g.handoff(handoff, [{ name: '01.png', bytes: Buffer.from('png') }]);
    expect(readFileSync(path.join(dir, 'out', '01.png'), 'utf8')).toBe('png');
    expect(JSON.parse(readFileSync(path.join(dir, 'out', 'attach.json'), 'utf8'))).toEqual(handoff);
    expect(told).toBe(1);
    expect(calls).toEqual([]);
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
