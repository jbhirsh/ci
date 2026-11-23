// The sync against a real git remote (a bare repository standing in for the
// app on GitHub) and a fake GitHub API that answers from it: PRs, compares
// and trees are read from the bare repository, so the guard checks what a
// push really put there.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFiles } from '../review/testApp.mjs';
import { CI_ROOT } from './manifest.mjs';
import { BRANCH, blobSha } from './plan.mjs';
import {
  appOf,
  check,
  contentProblems,
  dryRun,
  gitIn,
  guard,
  main,
  prepare,
  publish,
  readPrepared,
  SECRET,
} from './sync.mjs';
import { loadManifest, resolve } from './manifest.mjs';

const CI_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const TEMPLATE = readFileSync(path.join(CI_ROOT, '.github/pull_request_template.md'), 'utf8');
const HELLO =
  'name: Hello\non: pull_request\njobs:\n  hello:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hello\n';
const SIFT_HELLO = HELLO.replace('on: pull_request', 'on: workflow_dispatch');
const SETTINGS = '{\n  "autofix": {\n    "exempt": {\n      "PR changes": "data"\n    }\n  }\n}\n';

/** @type {string[]} */
const temps = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sync-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A checkout of this repo holding a small manifest: the real template, and a
 * workflow with a companion and a variant for sift.
 *
 * @param {Record<string, string>} [files] more or other files
 */
function ciRoot(files = {}) {
  const root = temp();
  writeFiles(root, {
    'sync/manifest.json': JSON.stringify({
      files: [
        {
          path: '.github/pull_request_template.md',
          source: '.github/pull_request_template.md',
          apps: ['BoardGames', 'fog-and-frontier', 'sift'],
        },
        {
          path: '.github/workflows/hello.yml',
          source: 'sync/callers/hello.yml',
          apps: ['BoardGames', 'fog-and-frontier', 'sift'],
          variants: {
            sift: { source: 'sync/variants/sift/hello.yml', why: 'sift runs it by hand' },
          },
          companions: [{ key: ['autofix', 'exempt', 'Hello'], value: 'says hello' }],
        },
      ],
      unsynced: [],
    }),
    '.github/pull_request_template.md': TEMPLATE,
    'sync/callers/hello.yml': HELLO,
    'sync/variants/sift/hello.yml': SIFT_HELLO,
    ...files,
  });
  return root;
}

/** @param {string} cwd */
const git = (cwd) => gitIn(cwd);
const ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

/**
 * The app on "GitHub": a bare repository whose main holds these files, and
 * a function that commits more to its main.
 *
 * @param {Record<string, string>} files
 */
function appRemote(files) {
  const bare = temp();
  git(bare)(['init', '-q', '--bare', '-b', 'main']);
  git(bare)(['config', 'uploadpack.allowFilter', 'true']);
  git(bare)(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const work = temp();
  git(work)(['init', '-q', '-b', 'main']);
  /** @param {Record<string, string>} more */
  const commit = (more) => {
    writeFiles(work, more);
    git(work)(['add', '--', ...Object.keys(more)]);
    git(work)(['commit', '-q', '--no-gpg-sign', '-m', 'app'], { env: ENV });
    git(work)(['push', '-q', `file://${bare}`, 'main']);
    return git(work)(['rev-parse', 'HEAD']).trim();
  };
  /**
   * Commits a change made in the app's work tree by `edit` (a link, a mode).
   *
   * @param {(dir: string) => void} edit
   * @param {string[]} paths
   */
  const commitWith = (edit, paths) => {
    edit(work);
    git(work)(['add', '--', ...paths]);
    git(work)(['commit', '-q', '--no-gpg-sign', '-m', 'app'], { env: ENV });
    git(work)(['push', '-q', `file://${bare}`, 'main']);
    return git(work)(['rev-parse', 'HEAD']).trim();
  };
  commit({ 'README.md': 'app\n', ...files });
  return { bare, url: `file://${bare}`, commit, commitWith };
}

/**
 * The fake GitHub API for one app, answering from its bare repository.
 *
 * @param {string} repo
 * @param {string} bare
 */
function fakeGitHub(repo, bare) {
  const g = git(bare);
  /**
   * @typedef {{ number: number, node_id: string, draft: boolean, state: string,
   *   mergeable_state: string | null, auto_merge: unknown, title?: string, body?: string,
   *   headRepo?: string }} FakePull
   */
  /** @type {Map<number, FakePull>} */
  const pulls = new Map();
  /** @type {[string, string, unknown?][]} */
  const calls = [];
  /** @type {{ query: string, variables: Record<string, unknown>, branch: string }[]} */
  const mutations = [];
  const state = {
    threads: /** @type {unknown[]} */ ([]),
    required: /** @type {string[]} */ ([]),
    checkRuns: /** @type {unknown[]} */ ([]),
    statuses: /** @type {unknown[]} */ ([]),
    clean: false,
    /** A refusal enabling auto-merge gives, as GitHub words it. */
    refusal: /** @type {string | null} */ (null),
    refuseCreate: false,
    ruleTypes: ['required_status_checks', 'pull_request', 'code_scanning'],
    mergeable: /** @type {string | null} */ (null),
  };
  const branchHead = () => {
    try {
      return g(['rev-parse', `refs/heads/${BRANCH}`]).trim();
    } catch {
      return '';
    }
  };
  /** @param {number} n */
  const pull = (n) => {
    const p = /** @type {NonNullable<ReturnType<typeof pulls.get>>} */ (pulls.get(n));
    return { ...p, mergeable_state: state.mergeable, head: { sha: branchHead() } };
  };
  /** @type {import('../lib/comment.mjs').Api} */
  const api = (method, route, body) => {
    calls.push([method, route, body]);
    const r = route.replace(`repos/${repo}/`, '');
    let m;
    if (method === 'GET' && r.startsWith('pulls?head=')) {
      expect(r).toContain('&base=main&');
      return [...pulls.values()]
        .filter((p) => p.state === 'open')
        .map((p) => ({
          number: p.number,
          body: p.body ?? null,
          head: { repo: { full_name: p.headRepo ?? repo } },
        }));
    }
    if (method === 'GET' && (m = /^pulls\/(\d+)$/.exec(r))) return pull(Number(m[1]));
    if (method === 'POST' && r === 'pulls') {
      if (state.refuseCreate)
        throw new Error('HTTP 403: Resource not accessible by personal access token');
      const number = pulls.size + 1;
      pulls.set(number, {
        number,
        node_id: `PR_${number}`,
        draft: false,
        state: 'open',
        mergeable_state: null,
        auto_merge: null,
        .../** @type {object} */ (body),
      });
      return { number };
    }
    if (method === 'PATCH' && (m = /^pulls\/(\d+)$/.exec(r))) {
      Object.assign(/** @type {object} */ (pulls.get(Number(m[1]))), body);
      return {};
    }
    if (method === 'PUT' && /^pulls\/\d+\/merge$/.test(r)) return { merged: true };
    if (method === 'POST' && /^issues\/\d+\/comments$/.test(r)) return {};
    if (method === 'DELETE' && r === `git/refs/heads/${BRANCH}`) {
      g(['update-ref', '-d', `refs/heads/${BRANCH}`]);
      return null;
    }
    if (method === 'GET' && (m = /^compare\/(\w+)\.\.\.(\w+)$/.exec(r))) {
      const [, base, head] = m;
      const mergeBase = g(['merge-base', base, head]).trim();
      const raw = g(['diff', '--raw', '--no-renames', '--abbrev=40', mergeBase, head]).trim();
      const files = raw
        ? raw.split('\n').map((line) => {
            const [meta, filename] = line.split('\t');
            const [, , , sha, letter] = meta.split(' ');
            const status = { A: 'added', M: 'modified', D: 'removed', T: 'changed' }[letter];
            return { filename, status, sha: letter === 'D' ? null : sha };
          })
        : [];
      return {
        ahead_by: Number(g(['rev-list', '--count', `${mergeBase}..${head}`]).trim()),
        behind_by: Number(g(['rev-list', '--count', `${head}..${base}`]).trim()),
        merge_base_commit: { sha: mergeBase },
        files,
      };
    }
    if (method === 'GET' && (m = /^git\/commits\/(\w+)$/.exec(r))) {
      return { tree: { sha: g(['rev-parse', `${m[1]}^{tree}`]).trim() } };
    }
    if (method === 'GET' && (m = /^git\/trees\/(\w+)$/.exec(r))) {
      const tree = g(['ls-tree', m[1]])
        .trim()
        .split('\n')
        .map((line) => {
          const [meta, name] = line.split('\t');
          const [mode, type, sha] = meta.split(' ');
          return { path: name, mode, type, sha };
        });
      return { tree };
    }
    if (method === 'GET' && (m = /^contents\/\.github\/ci\.json\?ref=(\w+)$/.exec(r))) {
      try {
        return { content: Buffer.from(g(['show', `${m[1]}:.github/ci.json`])).toString('base64') };
      } catch {
        throw Object.assign(new Error('HTTP 404'), { status: 404 });
      }
    }
    if (method === 'GET' && r.startsWith('rules/branches/main')) {
      return state.ruleTypes.map((type) =>
        type === 'required_status_checks'
          ? {
              type,
              parameters: {
                required_status_checks: state.required.map((context) => ({ context })),
              },
            }
          : { type },
      );
    }
    if (method === 'GET' && /^commits\/\w+\/check-runs/.test(r))
      return { check_runs: state.checkRuns };
    if (method === 'GET' && /^commits\/\w+\/status/.test(r)) return { statuses: state.statuses };
    throw new Error(`unexpected ${method} ${route}`);
  };
  /** @type {import('./sync.mjs').Graphql} */
  const graphql = (query, variables) => {
    if (query.includes('reviewThreads')) {
      return { repository: { pullRequest: { reviewThreads: { nodes: state.threads } } } };
    }
    mutations.push({ query, variables, branch: branchHead() });
    const p = pulls.get(Number(String(variables.id).replace('PR_', '')));
    if (query.includes('disablePullRequestAutoMerge')) {
      if (p) p.auto_merge = null;
      return {};
    }
    if (state.clean) throw new Error('Pull request is in clean status');
    if (state.refusal) throw new Error(state.refusal);
    if (p) p.auto_merge = { merge_method: 'squash' };
    return {};
  };
  return { api, graphql, pulls, calls, mutations, state, branchHead };
}

/**
 * Runs prepare on a fresh checkout of the app's main, then publish with the
 * fake GitHub, as the action's steps run them.
 *
 * @param {{ app: string, ci: string, remote: ReturnType<typeof appRemote>,
 *   github: ReturnType<typeof fakeGitHub>, token?: string, autoMerge?: string,
 *   wrapGit?: (git: import('./sync.mjs').Git) => import('./sync.mjs').Git }} input
 */
async function run({
  app,
  ci,
  remote,
  github,
  token = 'secret',
  wrapGit = (g) => g,
  autoMerge = 'true',
}) {
  const checkout = temp();
  execFileSync('git', ['clone', '-q', remote.url, checkout], { env: { PATH: process.env.PATH } });
  const out = temp();
  /** @type {string[]} */
  const installs = [];
  await prepare(
    { APP: app, APP_ROOT: checkout, SYNC_OUT: out, CI_SHA },
    { install: (root) => installs.push(root), format: async (text) => text, ciRoot: ci },
  );
  const work = temp();
  const lines = publish(
    {
      APP: app,
      CI_SHA,
      GH_TOKEN: token,
      SYNC_OUT: out,
      RUN_URL: 'https://run',
      AUTO_MERGE: autoMerge,
    },
    {
      api: github.api,
      graphql: github.graphql,
      git: wrapGit(gitIn(work)),
      remote: remote.url,
      ciRoot: ci,
    },
  );
  return { lines, installs, work };
}

/**
 * The commits the sync branch holds on top of `base`, oldest first.
 *
 * @param {string} bare
 * @param {string} base
 */
const branchCommits = (bare, base) =>
  git(bare)(['log', '--reverse', '--format=%P|%s', `${base}..refs/heads/${BRANCH}`])
    .trim()
    .split('\n');

/**
 * @param {string} bare
 * @param {string} file
 */
const onBranch = (bare, file) => git(bare)(['show', `refs/heads/${BRANCH}:${file}`]);

describe('publish', () => {
  it('opens one PR with a commit per file, byte-identical, auto-merge bound to its head', async () => {
    const ci = ciRoot();
    const remote = appRemote({
      '.github/pull_request_template.md': 'an old template\n',
      '.github/workflows/hello.yml': 'name: Hello\n# old\n',
      '.github/ci.json': SETTINGS,
    });
    const base = git(remote.bare)(['rev-parse', 'main']).trim();
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    const { lines, installs } = await run({ app: 'BoardGames', ci, remote, github });

    const commits = branchCommits(remote.bare, base);
    expect(commits.map((c) => c.split('|')[1])).toEqual([
      'Sync .github/pull_request_template.md with jbhirsh/ci',
      'Sync .github/workflows/hello.yml with jbhirsh/ci',
    ]);
    // One parent each: never a merge commit.
    expect(commits.every((c) => !c.split('|')[0].includes(' '))).toBe(true);
    expect(onBranch(remote.bare, '.github/pull_request_template.md')).toBe(TEMPLATE);
    expect(onBranch(remote.bare, '.github/workflows/hello.yml')).toBe(HELLO);
    // An updated file brings no companion, so ci.json and Prettier are untouched.
    expect(onBranch(remote.bare, '.github/ci.json')).toBe(SETTINGS);
    expect(installs).toEqual([]);

    expect([...github.pulls.values()]).toHaveLength(1);
    const [pr] = github.pulls.values();
    expect(pr.title).toBe('Sync shared files with jbhirsh/ci');
    expect(pr.body).toContain('| <code>.github/workflows/hello.yml</code> | updated |');
    expect(pr.body).toContain('([run](https://run))');
    expect(github.mutations).toHaveLength(1);
    expect(github.mutations[0].query).toContain('mergeMethod: SQUASH');
    expect(github.mutations[0].variables).toEqual({ id: 'PR_1', head: github.branchHead() });
    // A head pushed this run has no results yet: no check is read.
    expect(github.calls.some(([, route]) => route.includes('check-runs'))).toBe(false);
    expect(lines).toEqual([
      expect.stringMatching(
        /^BoardGames: pushed bot\/sync-files at \w{7}, 2 commit\(s\) on \w{7}\.$/,
      ),
      'BoardGames: opened #1.',
      `BoardGames: #1: auto-merge is on for ${github.branchHead().slice(0, 7)}.`,
    ]);
  });

  it("fetches no blob of the app's beyond the files it reads", async () => {
    const ci = ciRoot();
    const remote = appRemote({
      'docs/big.bin': 'x'.repeat(100_000),
      '.github/workflows/other.yml': 'name: Other\n',
    });
    const big = git(remote.bare)(['rev-parse', 'main:docs/big.bin']).trim();
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    const { work } = await run({ app: 'BoardGames', ci, remote, github });
    const held = git(work)(['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']);
    expect(held).not.toContain(big);
    expect(github.pulls.size).toBe(1);
  });

  it('changes nothing when run again', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    await run({ app: 'BoardGames', ci, remote, github });
    const head = github.branchHead();
    const { lines } = await run({ app: 'BoardGames', ci, remote, github });
    expect(github.branchHead()).toBe(head);
    expect(github.pulls.size).toBe(1);
    expect(github.mutations).toHaveLength(1);
    expect(lines).toEqual(['BoardGames: #1 already holds these files; left as it is.']);
  });

  it('force-pushes a newer source to the same PR, with auto-merge off while it does', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    await run({ app: 'BoardGames', ci, remote, github });
    const first = github.branchHead();
    writeFileSync(path.join(ci, 'sync/callers/hello.yml'), `${HELLO}# newer\n`);
    const { lines } = await run({ app: 'BoardGames', ci, remote, github });
    expect(github.branchHead()).not.toBe(first);
    expect(onBranch(remote.bare, '.github/workflows/hello.yml')).toBe(`${HELLO}# newer\n`);
    expect(github.pulls.size).toBe(1);
    const [, off, on] = github.mutations;
    expect(off.query).toContain('disablePullRequestAutoMerge');
    expect(off.branch).toBe(first);
    expect(on.variables.head).toBe(github.branchHead());
    expect(lines).toContain("BoardGames: rewrote #1's description.");
  });

  it('closes the PR, with a comment, and deletes its branch once nothing differs', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    await run({ app: 'BoardGames', ci, remote, github });
    remote.commit({
      '.github/workflows/hello.yml': HELLO,
      '.github/pull_request_template.md': TEMPLATE,
    });
    const { lines } = await run({ app: 'BoardGames', ci, remote, github });
    expect(lines).toEqual(['BoardGames: closed #1: every synced file matches jbhirsh/ci again.']);
    expect(github.pulls.get(1)?.state).toBe('closed');
    expect(github.branchHead()).toBe('');
    const comment = github.calls.find(
      ([method, route]) => method === 'POST' && route.endsWith('/comments'),
    );
    expect(JSON.stringify(comment?.[2])).toContain('nothing left to sync');
    // And then there is nothing to do.
    expect((await run({ app: 'BoardGames', ci, remote, github })).lines).toEqual([
      'BoardGames: every synced file matches jbhirsh/ci; no PR open.',
    ]);
  });

  it("writes an app's variant, and shows why in the PR", async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': HELLO });
    const github = fakeGitHub('jbhirsh/sift', remote.bare);
    await run({ app: 'sift', ci, remote, github });
    expect(onBranch(remote.bare, '.github/workflows/hello.yml')).toBe(SIFT_HELLO);
    expect(github.pulls.get(1)?.body).toContain(
      "- `.github/workflows/hello.yml` is this app's variant: sift runs it by hand",
    );
  });

  it('adds a file with its companion key in the same commit, through Prettier only then', async () => {
    const ci = ciRoot();
    const remote = appRemote({
      '.github/pull_request_template.md': TEMPLATE,
      '.github/ci.json': SETTINGS,
    });
    const base = git(remote.bare)(['rev-parse', 'main']).trim();
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    const { installs } = await run({ app: 'BoardGames', ci, remote, github });
    expect(installs).toHaveLength(1);
    expect(branchCommits(remote.bare, base)).toHaveLength(1);
    const files = git(remote.bare)(['show', '--name-only', '--format=', `refs/heads/${BRANCH}`]);
    expect(files.trim().split('\n')).toEqual(['.github/ci.json', '.github/workflows/hello.yml']);
    expect(JSON.parse(onBranch(remote.bare, '.github/ci.json'))).toEqual({
      autofix: { exempt: { 'PR changes': 'data', Hello: 'says hello' } },
    });
    expect(github.pulls.get(1)?.body).toContain('`.github/ci.json` gains `autofix.exempt.Hello`');
  });

  it('refuses a template of the wrong shape before anything is pushed', async () => {
    const ci = ciRoot({ '.github/pull_request_template.md': '## Goal\n' });
    const remote = appRemote({});
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    await expect(run({ app: 'BoardGames', ci, remote, github })).rejects.toThrow(
      /refusing to sync files that fail their checks:\n {2}- \.github\/pull_request_template\.md: /,
    );
    expect(github.branchHead()).toBe('');
    expect(github.calls).toEqual([]);
  });

  it('refuses an empty token before running anything', () => {
    let ran = 0;
    expect(() =>
      publish(
        { APP: 'sift', CI_SHA, GH_TOKEN: '', SYNC_OUT: '/nowhere' },
        {
          api: () => ran++,
          graphql: () => ran++,
          git: () => String(ran++),
        },
      ),
    ).toThrow(`${SECRET} is empty`);
    expect(ran).toBe(0);
  });

  it('names a missing Workflows permission when GitHub refuses the push, and changes nothing', async () => {
    const ci = ciRoot();
    const remote = appRemote({});
    const github = fakeGitHub('jbhirsh/fog-and-frontier', remote.bare);
    /**
     * @param {import('./sync.mjs').Git} g
     * @returns {import('./sync.mjs').Git}
     */
    const wrapGit = (g) => (args, options) => {
      if (args.includes('push')) {
        throw Object.assign(new Error('git push failed'), {
          stderr:
            '! [remote rejected] bot/sync-files (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/hello.yml` without `workflow` scope)',
        });
      }
      return g(args, options);
    };
    await expect(run({ app: 'fog-and-frontier', ci, remote, github, wrapGit })).rejects.toThrow(
      'BOT_PR_TOKEN lacks the Workflows permission on jbhirsh/fog-and-frontier, which a push of a workflow file needs: give the token Workflows read and write there. Nothing was pushed.',
    );
    expect(github.pulls.size).toBe(0);
    expect(github.branchHead()).toBe('');
  });

  it('names a token that may not push at all, and passes other failures on', async () => {
    const ci = ciRoot();
    const remote = appRemote({});
    const github = fakeGitHub('jbhirsh/sift', remote.bare);
    /** @param {string} stderr */
    const refusing = (stderr) => (/** @type {import('./sync.mjs').Git} */ g) =>
      /** @type {import('./sync.mjs').Git} */ (
        (args, options) => {
          if (args.includes('push')) throw Object.assign(new Error('git push failed'), { stderr });
          return g(args, options);
        }
      );
    await expect(
      run({
        app: 'sift',
        ci,
        remote,
        github,
        wrapGit: refusing('remote: Permission to jbhirsh/sift.git denied to x.\nfatal: ... 403'),
      }),
    ).rejects.toThrow(
      "BOT_PR_TOKEN can't push to jbhirsh/sift: give the token Contents, Pull requests and Workflows read and write",
    );
    await expect(
      run({ app: 'sift', ci, remote, github, wrapGit: refusing('stale info') }),
    ).rejects.toThrow('git push failed');
  });

  it('never overwrites a branch that moved after it was read', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/sift', remote.bare);
    const other = remote.commit({ 'theirs.txt': 'pushed by someone else\n' });
    /**
     * @param {import('./sync.mjs').Git} g
     * @returns {import('./sync.mjs').Git}
     */
    const wrapGit = (g) => (args, options) => {
      const out = g(args, options);
      // Someone pushes the branch between the sync's read and its push.
      if (args[0] === 'ls-remote' && args.includes(`refs/heads/${BRANCH}`)) {
        git(remote.bare)(['update-ref', `refs/heads/${BRANCH}`, other]);
      }
      return out;
    };
    await expect(run({ app: 'sift', ci, remote, github, wrapGit })).rejects.toThrow(/stale info/);
    expect(github.branchHead()).toBe(other);
  });

  it('leaves a PR whose branch already holds the files when only the base moved', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    await run({ app: 'BoardGames', ci, remote, github });
    const head = github.branchHead();
    remote.commit({ 'other.txt': 'unrelated\n' });
    github.state.mergeable = 'clean';
    const { lines } = await run({ app: 'BoardGames', ci, remote, github });
    expect(github.branchHead()).toBe(head);
    expect(lines).toEqual(['BoardGames: #1 already holds these files; left as it is.']);
  });

  it.each(['behind', 'dirty'])('rebuilds a %s branch from the app’s head', async (mergeable) => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/sift', remote.bare);
    await run({ app: 'sift', ci, remote, github });
    const newMain = remote.commit({ 'other.txt': 'unrelated\n' });
    github.state.mergeable = mergeable;
    await run({ app: 'sift', ci, remote, github });
    expect(git(remote.bare)(['merge-base', 'main', `refs/heads/${BRANCH}`]).trim()).toBe(newMain);
    expect(github.pulls.size).toBe(1);
  });

  it('turns auto-merge on for a kept PR that lost it, after the guard', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    await run({ app: 'BoardGames', ci, remote, github });
    /** @type {{ auto_merge: unknown }} */ (github.pulls.get(1)).auto_merge = null;
    remote.commit({ 'other.txt': 'unrelated\n' });
    const { lines } = await run({ app: 'BoardGames', ci, remote, github });
    expect(lines).toEqual([
      `BoardGames: #1: auto-merge is on for ${github.branchHead().slice(0, 7)}.`,
    ]);
  });

  it('merges at once, bound to the head, when GitHub says there is nothing to wait for', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    github.state.clean = true;
    const { lines } = await run({ app: 'BoardGames', ci, remote, github });
    const merge = github.calls.find(([method]) => method === 'PUT');
    expect(merge).toEqual([
      'PUT',
      'repos/jbhirsh/BoardGames/pulls/1/merge',
      { sha: github.branchHead(), merge_method: 'squash' },
    ]);
    expect(lines.at(-1)).toMatch(/nothing to wait for, so merged \w{7}\.$/);
  });

  it('passes on a failure to turn auto-merge on that is not about a clean PR', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    /** @type {import('./sync.mjs').Graphql} */
    const graphql = (query, variables) => {
      if (query.includes('enablePullRequestAutoMerge'))
        throw new Error('Auto merge is not allowed');
      return github.graphql(query, variables);
    };
    await expect(
      run({ app: 'BoardGames', ci, remote, github: { ...github, graphql } }),
    ).rejects.toThrow('Auto merge is not allowed');
  });

  it('leaves a draft without auto-merge', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    await run({ app: 'BoardGames', ci, remote, github });
    const pr = /** @type {{ draft: boolean, auto_merge: unknown }} */ (github.pulls.get(1));
    pr.draft = true;
    pr.auto_merge = null;
    writeFileSync(path.join(ci, 'sync/callers/hello.yml'), `${HELLO}# newer\n`);
    const { lines } = await run({ app: 'BoardGames', ci, remote, github });
    expect(lines.at(-1)).toBe(
      'BoardGames: #1 is a draft, so auto-merge stays off until it is marked ready.',
    );
    expect(github.mutations.filter((m) => m.query.includes('enable'))).toHaveLength(1);
  });

  it('fails naming an unresolved review thread, after doing its work', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/sift', remote.bare);
    github.state.threads = [
      {
        isResolved: false,
        path: '.github/workflows/pr-description.yml',
        line: 7,
        comments: { nodes: [] },
      },
    ];
    const failed = await run({ app: 'sift', ci, remote, github }).catch((error) => error);
    expect(failed.message).toBe(
      'sift: bot/sync-files is blocked: unresolved review thread on .github/workflows/pr-description.yml:7',
    );
    expect(failed.done).toContain('sift: opened #1.');
    expect(github.pulls.size).toBe(1);
  });

  it('fails naming a failed required check on a head it did not push, never a pending one', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/sift', remote.bare);
    await run({ app: 'sift', ci, remote, github });
    github.state.required = ['Lint, Typecheck & Unit Test', 'E2E Tests (Maestro)'];
    github.state.checkRuns = [
      { id: 1, name: 'Lint, Typecheck & Unit Test', status: 'completed', conclusion: 'failure' },
      { id: 2, name: 'E2E Tests (Maestro)', status: 'in_progress', conclusion: null },
    ];
    await expect(run({ app: 'sift', ci, remote, github })).rejects.toThrow(
      /^sift: bot\/sync-files is blocked: required check "Lint, Typecheck & Unit Test" failed$/,
    );
    github.state.checkRuns = [
      { id: 3, name: 'E2E Tests (Maestro)', status: 'queued', conclusion: null },
    ];
    expect((await run({ app: 'sift', ci, remote, github })).lines).toEqual([
      'sift: #1 already holds these files; left as it is.',
    ]);
  });

  it('fails when the guard refuses what GitHub holds, leaving auto-merge off', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    /** @type {import('../lib/comment.mjs').Api} */
    const api = (method, route, body) => {
      const answer = github.api(method, route, body);
      if (!route.includes('/compare/')) return answer;
      const c = /** @type {{ files: unknown[] }} */ (answer);
      return {
        ...c,
        files: [...c.files, { filename: 'package.json', status: 'modified', sha: 'x' }],
      };
    };
    await expect(
      run({ app: 'BoardGames', ci, remote, github: { ...github, api } }),
    ).rejects.toThrow(
      /^BoardGames: the guard refused bot\/sync-files at \w{7}; auto-merge is off:\n {2}- package.json is not a file the sync writes$/,
    );
    expect(github.pulls.size).toBe(0);
    expect(github.mutations).toEqual([]);
  });
});

describe('guard', () => {
  const content = Buffer.from('name: x\n');
  /**
   * A fake API answering the compare and the trees of one commit pair.
   *
   * @param {object} compareAnswer
   * @param {Record<string, string>} [modes] head modes by path
   * @param {string} [baseMode] every file's mode at the base
   */
  const api = (compareAnswer, modes = {}, baseMode = '100644') =>
    /** @type {import('../lib/comment.mjs').Api} */ (
      (_method, route) => {
        if (route.includes('/compare/')) return compareAnswer;
        if (route.includes('/git/commits/'))
          return { tree: { sha: route.endsWith('head') ? 'th' : 'tb' } };
        const head = route.endsWith('/th') || route.endsWith('/thw');
        if (route.endsWith('/th') || route.endsWith('/tb')) {
          return {
            tree: [
              { path: 'w', mode: '040000', type: 'tree', sha: head ? 'thw' : 'tbw' },
              { path: 'f', mode: '100644', type: 'blob', sha: 'x' },
            ],
          };
        }
        return {
          tree: Object.entries({ 'w/a.yml': '100644', 'w/b.yml': '100644', ...modes })
            .filter(([file]) => head || file !== 'w/new.yml')
            .map(([file, mode]) => ({
              path: file.slice(2),
              mode: head ? (modes[file] ?? mode) : baseMode,
              type: 'blob',
              sha: 'x',
            })),
        };
      }
    );
  const expected = new Map([['w/a.yml', content]]);
  const ok = {
    ahead_by: 1,
    behind_by: 0,
    files: [{ filename: 'w/a.yml', status: 'modified', sha: blobSha(content) }],
  };
  const args = {
    repo: 'jbhirsh/sift',
    base: 'base',
    head: 'head',
    commits: 1,
    expected,
    settingsBefore: '',
    companions: [],
  };

  it('passes only the files meant, byte-identical, in their mode', () => {
    expect(guard({ ...args, api: api(ok) })).toEqual([]);
  });

  it('refuses a file outside the manifest, a missing one, or other bytes', () => {
    expect(
      guard({
        ...args,
        api: api({ ...ok, files: [{ filename: 'w/b.yml', status: 'modified', sha: 'y' }] }),
      }),
    ).toEqual(['w/b.yml is not a file the sync writes', 'w/a.yml is missing from the branch']);
    expect(
      guard({ ...args, api: api({ ...ok, files: [{ ...ok.files[0], sha: 'other' }] }) }),
    ).toEqual(['w/a.yml is not byte-identical to its source']);
  });

  it('refuses a rename, a deletion or a mode change', () => {
    for (const file of [
      { ...ok.files[0], status: 'renamed', previous_filename: 'w/old.yml' },
      { ...ok.files[0], status: 'removed' },
      { ...ok.files[0], status: 'changed' },
    ]) {
      expect(guard({ ...args, api: api({ ...ok, files: [file] }) })[0]).toBe(
        `w/a.yml is ${file.status}: only an added or modified file is synced`,
      );
    }
    expect(guard({ ...args, api: api(ok, { 'w/a.yml': '100755' }) })).toEqual([
      'w/a.yml has mode 100755, not 100644 (a plain file)',
    ]);
  });

  it('refuses a file that is a link at both ends, its mode unchanged', () => {
    expect(guard({ ...args, api: api(ok, { 'w/a.yml': '120000' }, '120000') })).toEqual([
      'w/a.yml has mode 120000, not 120000 (a plain file)',
    ]);
  });

  it('refuses a new file that is a link', () => {
    const added = {
      ahead_by: 1,
      behind_by: 0,
      files: [{ filename: 'w/new.yml', status: 'added', sha: blobSha(content) }],
    };
    expect(
      guard({
        ...args,
        expected: new Map([['w/new.yml', content]]),
        api: api(added, { 'w/new.yml': '120000' }),
      }),
    ).toEqual(['w/new.yml has mode 120000, not 100644 (a plain file)']);
  });

  it('refuses a branch with other commits, or behind its base', () => {
    expect(guard({ ...args, api: api({ ...ok, ahead_by: 2, behind_by: 1 }) })).toEqual([
      'the branch is 2 commit(s) ahead and 1 behind its base, not 1 and 0',
    ]);
  });

  it('holds ci.json to the companion keys', () => {
    const companions = [{ key: ['autofix', 'exempt', 'Hello'], value: 'hi' }];
    const after = Buffer.from(
      '{\n  "a": 1,\n  "autofix": { "exempt": { "Hello": "hi" } },\n  "b": 2\n}\n',
    );
    const files = [{ filename: '.github/ci.json', status: 'modified', sha: blobSha(after) }];
    const answer = /** @type {import('../lib/comment.mjs').Api} */ (
      (_m, route) => {
        if (route.includes('/compare/')) return { ahead_by: 1, behind_by: 0, files };
        if (route.includes('/git/commits/')) return { tree: { sha: 't' } };
        if (route.endsWith('/t'))
          return { tree: [{ path: '.github', mode: '040000', type: 'tree', sha: 'g' }] };
        return { tree: [{ path: 'ci.json', mode: '100644', type: 'blob', sha: 'x' }] };
      }
    );
    expect(
      guard({
        ...args,
        api: answer,
        expected: new Map([['.github/ci.json', after]]),
        settingsBefore: '{\n  "a": 1\n}\n',
        companions,
      }),
    ).toEqual([
      '.github/ci.json in the sync PR changes more than the companion keys (autofix.exempt.Hello)',
    ]);
  });
});

describe('check', () => {
  const here = () => CI_SHA;
  /**
   * @param {{ head?: string, runs?: number }} answers
   * @returns {import('../lib/comment.mjs').Api & { calls: string[] }}
   */
  const api = ({ head = CI_SHA, runs = 1 } = {}) => {
    /** @type {string[]} */
    const calls = [];
    const fn = /** @type {import('../lib/comment.mjs').Api & { calls: string[] }} */ (
      (/** @type {string} */ _method, /** @type {string} */ route) => {
        calls.push(route);
        return route.endsWith('commits/main') ? { sha: head } : { total_count: runs };
      }
    );
    fn.calls = calls;
    return fn;
  };

  it('refuses an empty token before reading anything, naming the secret and what it needs', () => {
    const fake = api();
    expect(() => check({ TOKEN_SET: 'false', CI_SHA }, fake, here)).toThrow(
      'BOT_PR_TOKEN is empty: add it as an Actions secret of jbhirsh/ci, a fine-grained token on jbhirsh/BoardGames, jbhirsh/fog-and-frontier, jbhirsh/sift with Contents, Pull requests and Workflows read and write, and Checks and Commit statuses read. Nothing was changed in any app.',
    );
    expect(fake.calls).toEqual([]);
  });

  it('refuses a commit that is no full SHA, or whose CI has not passed', () => {
    expect(() => check({ TOKEN_SET: 'true', CI_SHA: 'main' }, api(), here)).toThrow(
      'CI_SHA must be a full commit SHA',
    );
    const fake = api({ runs: 0 });
    expect(() => check({ TOKEN_SET: 'true', CI_SHA }, fake, here)).toThrow(
      "CI hasn't passed on jbhirsh/ci@abcdef0 (its push to main)",
    );
    expect(fake.calls[1]).toBe(
      `repos/jbhirsh/ci/actions/workflows/ci.yml/runs?head_sha=${CI_SHA}&branch=main&event=push&status=success&per_page=1`,
    );
  });

  it('skips a commit main has moved past, and goes on from main’s passing head', () => {
    expect(check({ TOKEN_SET: 'true', CI_SHA }, api({ head: 'f'.repeat(40) }), here)).toEqual({
      go: false,
      message:
        "jbhirsh/ci@abcdef0 is not main's head (fffffff; this checkout of main: abcdef0), so nothing is synced: a run from main's head syncs, after its CI passes or when dispatched on main.",
    });
    // The workflow checks main out: a checkout that moved past the event's
    // commit (or a dispatch from another branch) syncs nothing.
    expect(check({ TOKEN_SET: 'true', CI_SHA }, api(), () => 'e'.repeat(40)).go).toBe(false);
    expect(check({ TOKEN_SET: 'true', CI_SHA }, api(), here)).toEqual({
      go: true,
      message: 'Syncing from jbhirsh/ci@abcdef0, whose CI passed.',
    });
  });
});

describe('prepare and readPrepared', () => {
  it('needs a folder to write to and a known app', async () => {
    await expect(prepare({ APP: 'sift' }, { install: () => {} })).rejects.toThrow(
      'SYNC_OUT names no folder',
    );
    await expect(prepare({ APP: 'nope', SYNC_OUT: temp() }, { install: () => {} })).rejects.toThrow(
      'the app must be one of BoardGames, fog-and-frontier, sift, not "nope"',
    );
    expect(() => appOf(undefined)).toThrow('not ""');
  });

  it('refuses what prepare would not write', () => {
    const dir = temp();
    const file = path.join(dir, 'prepared.json');
    for (const [value, message] of /** @type {[unknown, string][]} */ ([
      [[], 'is not what prepare writes'],
      [{ appSha: 'main', settings: {} }, 'prepared.json appSha must be a full commit SHA'],
      [{ appSha: CI_SHA, settings: [] }, 'settings must map paths to text'],
      [{ appSha: CI_SHA, settings: { a: 1 } }, 'settings must map paths to text'],
    ])) {
      writeFileSync(file, JSON.stringify(value));
      expect(() => readPrepared(file)).toThrow(message);
    }
    writeFileSync(file, JSON.stringify({ appSha: CI_SHA, settings: { a: 'x' } }));
    expect(readPrepared(file)).toEqual({ appSha: CI_SHA, settings: { a: 'x' } });
  });

  it('refuses to publish a companion that prepare wrote no settings for', async () => {
    const ci = ciRoot();
    const remote = appRemote({});
    const out = temp();
    writeFileSync(
      path.join(out, 'prepared.json'),
      JSON.stringify({ appSha: git(remote.bare)(['rev-parse', 'main']).trim(), settings: {} }),
    );
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    expect(() =>
      publish(
        { APP: 'BoardGames', CI_SHA, GH_TOKEN: 't', SYNC_OUT: out },
        {
          api: github.api,
          graphql: github.graphql,
          git: gitIn(temp()),
          remote: remote.url,
          ciRoot: ci,
        },
      ),
    ).toThrow(
      'prepare wrote no .github/ci.json for .github/workflows/hello.yml, which adds companions',
    );
  });
});

describe('contentProblems', () => {
  it("passes this repo's template, for every app", () => {
    for (const app of ['BoardGames', 'fog-and-frontier', 'sift']) {
      expect(contentProblems(resolve(loadManifest(), app), CI_ROOT)).toEqual([]);
    }
  });
});

describe('dryRun and main', () => {
  it('prints the PR the sync would open, or that there is none', () => {
    const ci = ciRoot();
    const app = temp();
    writeFiles(app, {
      '.github/workflows/hello.yml': 'old\n',
      '.github/workflows/other.yml': 'name: [',
    });
    const lines = dryRun('BoardGames', app, ci);
    expect(lines[0]).toBe(
      'BoardGames: would open or update one PR from bot/sync-files, "Sync shared files with jbhirsh/ci", with 2 commit(s):',
    );
    expect(lines.at(-1)).toContain('## Checklist');
    writeFiles(app, {
      '.github/workflows/hello.yml': HELLO,
      '.github/pull_request_template.md': TEMPLATE,
    });
    expect(dryRun('BoardGames', app, ci)).toEqual([
      'BoardGames: every synced file matches jbhirsh/ci; no PR.',
    ]);
  });

  it('runs each step from the command line, with its exit code', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    const output = path.join(temp(), 'output');
    /** @type {string[]} */
    const log = [];
    const deps = {
      api: github.api,
      graphql: github.graphql,
      remote: remote.url,
      ciRoot: ci,
      install: () => {},
    };

    const checkApi = /** @type {import('../lib/comment.mjs').Api} */ (
      (_m, route) => (route.endsWith('commits/main') ? { sha: CI_SHA } : { total_count: 1 })
    );
    expect(
      await main(
        ['check'],
        { TOKEN_SET: 'true', CI_SHA, GITHUB_OUTPUT: output },
        (l) => log.push(l),
        { ...deps, api: checkApi, checkedOut: () => CI_SHA },
      ),
    ).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('go=true\n');

    const checkout = temp();
    execFileSync('git', ['clone', '-q', remote.url, checkout], { env: { PATH: process.env.PATH } });
    const out = temp();
    const env = {
      APP: 'BoardGames',
      APP_ROOT: checkout,
      SYNC_OUT: out,
      CI_SHA,
      GH_TOKEN: 't',
      RUNNER_TEMP: temp(),
    };
    expect(await main(['prepare'], env, (l) => log.push(l), deps)).toBe(0);
    expect(await main(['publish'], env, (l) => log.push(l), deps)).toBe(0);
    expect(log).toContain('BoardGames: opened #1.');

    expect(await main(['dry-run', 'BoardGames', checkout], {}, (l) => log.push(l), deps)).toBe(0);
    expect(await main(['nothing'], {}, (l) => log.push(l))).toBe(2);
    expect(log.at(-1)).toBe(
      'usage: node sync/sync.mjs check | prepare | publish | dry-run <app> <app dir>',
    );
  });

  it('prints each line of a failure as an error, after what it did', async () => {
    /** @type {string[]} */
    const log = [];
    expect(await main(['check'], { TOKEN_SET: 'false' }, (l) => log.push(l))).toBe(1);
    expect(log[0]).toMatch(/^::error::BOT_PR_TOKEN is empty/);

    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    github.state.threads = [
      { isResolved: false, path: 'a.yml', line: 1 },
      { isResolved: false, path: 'b.yml', line: 2 },
    ];
    const checkout = temp();
    execFileSync('git', ['clone', '-q', remote.url, checkout], { env: { PATH: process.env.PATH } });
    const out = temp();
    const env = {
      APP: 'BoardGames',
      APP_ROOT: checkout,
      SYNC_OUT: out,
      CI_SHA,
      GH_TOKEN: 't',
      RUNNER_TEMP: temp(),
    };
    const deps = {
      api: github.api,
      graphql: github.graphql,
      remote: remote.url,
      ciRoot: ci,
      install: () => {},
    };
    await main(['prepare'], env, () => {}, deps);
    log.length = 0;
    expect(await main(['publish'], env, (l) => log.push(l), deps)).toBe(1);
    expect(log.slice(-3)).toEqual([
      expect.stringMatching(/auto-merge is on/),
      '::error::BoardGames: bot/sync-files is blocked: unresolved review thread on a.yml:1',
      '::error::BoardGames: bot/sync-files is blocked: unresolved review thread on b.yml:2',
    ]);
  });
});

describe('gitIn', () => {
  it('leaves out the GIT_* a hook set, so a test never acts on this repository', () => {
    const dir = temp();
    mkdirSync(path.join(dir, 'x'));
    process.env.GIT_DIR = path.join(dir, 'not-a-repo');
    try {
      gitIn(dir)(['init', '-q']);
    } finally {
      delete process.env.GIT_DIR;
    }
    expect(git(dir)(['rev-parse', '--is-inside-work-tree']).trim()).toBe('true');
  });
});

describe('publish, in the cases review found', () => {
  /** @param {import('./sync.mjs').Git} g @returns {import('./sync.mjs').Git} */
  const id = (g) => g;

  it('names a PR GitHub calls blocked with every check passed and no thread, and main’s rules', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    await run({ app: 'BoardGames', ci, remote, github });
    github.state.mergeable = 'blocked';
    github.state.required = ['ci'];
    github.state.checkRuns = [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success' }];
    await expect(run({ app: 'BoardGames', ci, remote, github })).rejects.toThrow(
      "BoardGames: bot/sync-files is blocked: GitHub says it is blocked with every required check passed and no review thread open: look at its merge box; main's rules are required_status_checks, pull_request, code_scanning",
    );
    // A check still running is no cause, and nor is the state it leaves.
    github.state.checkRuns = [{ id: 2, name: 'ci', status: 'in_progress', conclusion: null }];
    expect((await run({ app: 'BoardGames', ci, remote, github })).lines).toEqual([
      'BoardGames: #1 already holds these files; left as it is.',
    ]);
  });

  it('fetches no blob of the app when main moves before the push, even with negotiation off', async () => {
    const ci = ciRoot();
    const remote = appRemote({
      'docs/big.bin': 'x'.repeat(100_000),
      '.github/workflows/hello.yml': 'old\n',
    });
    const big = git(remote.bare)(['rev-parse', 'main:docs/big.bin']).trim();
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    /** @param {import('./sync.mjs').Git} g @returns {import('./sync.mjs').Git} */
    const wrapGit = (g) => (args, options) => {
      // main moves after the sync read it, so GitHub no longer advertises its base.
      if (args[0] === 'ls-remote' && args.includes(`refs/heads/${BRANCH}`)) {
        remote.commit({ 'moved.txt': 'main moved\n' });
      }
      // As git's own default, which this sandbox's global config changes.
      return g(args.includes('push') ? ['-c', 'push.negotiate=false', ...args] : args, options);
    };
    const { work } = await run({ app: 'BoardGames', ci, remote, github, wrapGit });
    expect(github.branchHead()).not.toBe('');
    const held = git(work)(['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']);
    expect(held).not.toContain(big);
  });

  it('leaves the PR for a person, with auto-merge off, when the run says so', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    const { lines } = await run({ app: 'BoardGames', ci, remote, github, autoMerge: 'false' });
    expect(lines.at(-1)).toBe(
      "BoardGames: #1 is left for a person to merge: this run's auto-merge is off.",
    );
    expect(github.mutations).toEqual([]);
    // A PR whose auto-merge an earlier run turned on has it turned off.
    /** @type {{ auto_merge: unknown }} */ (github.pulls.get(1)).auto_merge = {
      merge_method: 'squash',
    };
    await run({ app: 'BoardGames', ci, remote, github, autoMerge: 'false' });
    expect(github.mutations.map((m) => m.query.includes('disablePullRequestAutoMerge'))).toEqual([
      true,
    ]);
    expect(github.pulls.get(1)?.auto_merge).toBeNull();
  });

  it.each(['unstable', 'has_hooks', 'clean'])(
    'merges at once, bound to the head, when GitHub says the PR is in %s status',
    async (status) => {
      const ci = ciRoot();
      const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
      const github = fakeGitHub('jbhirsh/sift', remote.bare);
      github.state.refusal = `Pull request Pull request is in ${status} status`;
      const { lines } = await run({ app: 'sift', ci, remote, github });
      expect(github.calls.find(([method]) => method === 'PUT')?.[2]).toEqual({
        sha: github.branchHead(),
        merge_method: 'squash',
      });
      expect(lines.at(-1)).toMatch(/nothing to wait for, so merged \w{7}\.$/);
    },
  );

  it('fails naming the PR and what to do when auto-merge is refused otherwise, saying what it did', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/sift', remote.bare);
    github.state.refusal = 'Auto merge is not allowed for this repository';
    const failed = await run({ app: 'sift', ci, remote, github }).catch((error) => error);
    expect(failed.message).toBe(
      'GitHub refused to turn auto-merge on for jbhirsh/sift#1 (Auto merge is not allowed for this repository): merge it by hand once its checks pass, or dispatch the sync again.',
    );
    expect(failed.done).toEqual([
      expect.stringMatching(/^sift: pushed bot\/sync-files/),
      'sift: opened #1.',
    ]);
  });

  it('says what it pushed when the guard then refuses', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/sift', remote.bare);
    /** @type {import('../lib/comment.mjs').Api} */
    const api = (method, route, body) => {
      const answer = github.api(method, route, body);
      return route.includes('/compare/')
        ? { .../** @type {object} */ (answer), ahead_by: 9 }
        : answer;
    };
    const failed = await run({ app: 'sift', ci, remote, github: { ...github, api } }).catch(
      (e) => e,
    );
    expect(failed.message).toMatch(/the guard refused/);
    expect(failed.done).toEqual([expect.stringMatching(/^sift: pushed bot\/sync-files at \w{7}/)]);
  });

  it('refuses a synced path that is a link in the app, pushing nothing', async () => {
    const ci = ciRoot();
    const remote = appRemote({});
    remote.commitWith(
      (dir) => {
        mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
        symlinkSync('elsewhere.yml', path.join(dir, '.github/workflows/hello.yml'));
      },
      ['.github/workflows/hello.yml'],
    );
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    await expect(run({ app: 'BoardGames', ci, remote, github, wrapGit: id })).rejects.toThrow(
      '.github/workflows/hello.yml in jbhirsh/BoardGames is not a plain file (mode 120000): the sync writes only plain files, so replace it with one in the app. Nothing was pushed.',
    );
    expect(github.branchHead()).toBe('');
  });

  it('guards a kept PR every run: a push that changes only a mode turns its auto-merge off', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/sift', remote.bare);
    await run({ app: 'sift', ci, remote, github });
    // Someone pushes the branch with hello.yml made executable: same bytes.
    const other = temp();
    git(other)(['clone', '-q', '-b', BRANCH, remote.url, '.']);
    git(other)(['update-index', '--chmod=+x', '.github/workflows/hello.yml']);
    git(other)(['commit', '-q', '--no-gpg-sign', '-m', 'mode'], { env: ENV });
    git(other)(['push', '-q', 'origin', BRANCH]);
    const failed = await run({ app: 'sift', ci, remote, github }).catch((e) => e);
    expect(failed.message).toContain('the guard refused');
    expect(failed.message).toContain('.github/workflows/hello.yml has mode 100755, not 100644');
    expect(github.pulls.get(1)?.auto_merge).toBeNull();
  });

  it("refuses to adopt a person's PR from the branch, and ignores one from a fork", async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/sift', remote.bare);
    const base = {
      node_id: 'x',
      draft: false,
      state: 'open',
      mergeable_state: null,
      auto_merge: null,
    };
    github.pulls.set(1, { ...base, number: 1, body: 'from a fork', headRepo: 'someone/sift' });
    const { lines } = await run({ app: 'sift', ci, remote, github });
    expect(lines).toContain('sift: opened #2.');
    github.pulls.set(3, { ...base, number: 3, body: 'my own work' });
    github.pulls.delete(2);
    await expect(run({ app: 'sift', ci, remote, github })).rejects.toThrow(
      "jbhirsh/sift#3 comes from bot/sync-files but the sync didn't open it (its description lacks <!-- sync-files -->): close it, or move its work to another branch, and the next run opens its own.",
    );
  });

  it('deletes a stale branch once nothing differs and no PR is open', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    await run({ app: 'BoardGames', ci, remote, github });
    /** @type {{ state: string }} */ (github.pulls.get(1)).state = 'closed';
    remote.commit({
      '.github/workflows/hello.yml': HELLO,
      '.github/pull_request_template.md': TEMPLATE,
    });
    expect((await run({ app: 'BoardGames', ci, remote, github })).lines).toEqual([
      'BoardGames: every synced file matches jbhirsh/ci; deleted a stale bot/sync-files.',
    ]);
    expect(github.branchHead()).toBe('');
  });

  it('deletes the branch it pushed when GitHub refuses to open the PR, naming the permission', async () => {
    const ci = ciRoot();
    const remote = appRemote({ '.github/workflows/hello.yml': 'old\n' });
    const github = fakeGitHub('jbhirsh/fog-and-frontier', remote.bare);
    github.state.refuseCreate = true;
    await expect(run({ app: 'fog-and-frontier', ci, remote, github })).rejects.toThrow(
      'GitHub refused to open the sync PR in jbhirsh/fog-and-frontier (HTTP 403: Resource not accessible by personal access token): BOT_PR_TOKEN needs Pull requests read and write there. The pushed bot/sync-files was deleted again.',
    );
    expect(github.branchHead()).toBe('');
  });

  it('refuses a synced file of the app that is not UTF-8 text', async () => {
    const ci = ciRoot();
    const remote = appRemote({});
    remote.commitWith(
      (dir) => {
        mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
        writeFileSync(
          path.join(dir, '.github/workflows/hello.yml'),
          Buffer.from([0x6e, 0xff, 0x0a]),
        );
      },
      ['.github/workflows/hello.yml'],
    );
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    // prepare reads raw bytes, and refuses them itself.
    const checkout = temp();
    execFileSync('git', ['clone', '-q', remote.url, checkout], { env: { PATH: process.env.PATH } });
    await expect(
      prepare(
        { APP: 'BoardGames', APP_ROOT: checkout, SYNC_OUT: temp(), CI_SHA },
        { install: () => {}, ciRoot: ci },
      ),
    ).rejects.toThrow(
      '.github/workflows/hello.yml in jbhirsh/BoardGames is not UTF-8 text: the sync holds only text files, so replace it in the app.',
    );
    // publish, reading git's text, refuses it the same way.
    const out = temp();
    writeFileSync(
      path.join(out, 'prepared.json'),
      JSON.stringify({ appSha: git(remote.bare)(['rev-parse', 'main']).trim(), settings: {} }),
    );
    expect(() =>
      publish(
        { APP: 'BoardGames', CI_SHA, GH_TOKEN: 't', SYNC_OUT: out },
        {
          api: github.api,
          graphql: github.graphql,
          git: gitIn(temp()),
          remote: remote.url,
          ciRoot: ci,
        },
      ),
    ).toThrow('is not UTF-8 text');
  });

  it('refuses a companion written from a main that has since moved', async () => {
    const ci = ciRoot();
    const remote = appRemote({
      '.github/pull_request_template.md': TEMPLATE,
      '.github/ci.json': SETTINGS,
    });
    const github = fakeGitHub('jbhirsh/BoardGames', remote.bare);
    const checkout = temp();
    execFileSync('git', ['clone', '-q', remote.url, checkout], { env: { PATH: process.env.PATH } });
    const out = temp();
    await prepare(
      { APP: 'BoardGames', APP_ROOT: checkout, SYNC_OUT: out, CI_SHA },
      { install: () => {}, format: async (text) => text, ciRoot: ci },
    );
    remote.commit({ 'other.txt': 'moved\n' });
    expect(() =>
      publish(
        { APP: 'BoardGames', CI_SHA, GH_TOKEN: 't', SYNC_OUT: out },
        {
          api: github.api,
          graphql: github.graphql,
          git: gitIn(temp()),
          remote: remote.url,
          ciRoot: ci,
        },
      ),
    ).toThrow(
      /jbhirsh\/BoardGames's main moved \(\w{7} → \w{7}\) after prepare wrote its \.github\/ci\.json: nothing was pushed/,
    );
    expect(github.branchHead()).toBe('');
  });

  it('names the Prepare job when it left no prepared.json', () => {
    expect(() => readPrepared(path.join(temp(), 'prepared.json'))).toThrow(
      'is missing: the Prepare job for this app failed or was skipped, so its log says why.',
    );
  });
});
