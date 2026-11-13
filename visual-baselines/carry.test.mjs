import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOT, runIn } from './baselines.mjs';
import {
  ACTIONS_APP,
  HELD_POLLS,
  POLL_MS,
  QUIET_MS,
  WAIT_MS,
  amendAndCarry,
  awaitChecks,
  cancelHeld,
  checkRunsFromApi,
  decide,
  gitHubFromEnv,
  posts,
  readRequired,
  readResults,
  requiredFromRules,
  statusesFromApi,
  stillHead,
} from './carry.mjs';
import { repo } from './test-repo.mjs';
import { RUN_ID, VERIFY, apiRun, fake, rule, statusPage } from './test-github.mjs';

describe('requiredFromRules', () => {
  it("keeps checks tied to GitHub Actions or to any app, each once, leaving another app's", () => {
    expect(
      requiredFromRules([
        { type: 'deletion' },
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [
              { context: 'Unit', integration_id: ACTIONS_APP },
              { context: 'Vercel' },
              { context: 'Semgrep', integration_id: 1 },
            ],
          },
        },
        rule('Unit'),
      ]),
    ).toEqual([
      { context: 'Unit', app: ACTIONS_APP },
      { context: 'Vercel', app: null },
    ]);
  });

  it.each([
    [{}, /as a list/],
    [[{ type: 'required_status_checks' }], /lists no checks/],
    [[{ type: 'required_status_checks', parameters: { required_status_checks: [{}] } }], /no name/],
    [
      [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'a', integration_id: 'x' }] },
        },
      ],
      /no name/,
    ],
  ])('refuses rules it cannot read: %j', (rules, message) => {
    expect(() => requiredFromRules(rules)).toThrow(message);
  });
});

describe('checkRunsFromApi and statusesFromApi', () => {
  it('reads the fields used, and refuses anything else', () => {
    expect(checkRunsFromApi({ check_runs: [{ id: 1, name: 'a', status: 'queued' }] })).toEqual([
      { id: 1, name: 'a', status: 'queued', conclusion: null, url: '', app: null, links: [] },
    ]);
    expect(() => checkRunsFromApi({})).toThrow(/page of check runs/);
    expect(() => checkRunsFromApi({ check_runs: [{ id: 1 }] })).toThrow(/missing/);
    expect(statusesFromApi(statusPage(['Vercel', 'success']))).toEqual([
      { context: 'Vercel', state: 'success', url: 'https://vercel.example/Vercel' },
    ]);
    expect(statusesFromApi({ statuses: [{ context: 'x', state: 'pending' }] })[0].url).toBe('');
    expect(() => statusesFromApi(null)).toThrow(/statuses/);
    expect(() => statusesFromApi({ statuses: [{ context: 'x' }] })).toThrow(/missing/);
  });
});

describe('decide', () => {
  /** @type {import('./carry.mjs').Required[]} */
  const required = [
    { context: 'Unit', app: ACTIONS_APP },
    { context: 'Lint', app: ACTIONS_APP },
    { context: 'E2E', app: ACTIONS_APP },
  ];
  /**
   * @param {unknown[]} runs
   * @param {[string, string][]} [statuses] [context, state]
   * @param {import('./carry.mjs').Required[]} [req]
   */
  const of = (runs, statuses = [], req = required) =>
    decide({
      required: req,
      runs: checkRunsFromApi({ check_runs: runs }),
      statuses: statusesFromApi(statusPage(...statuses)),
      verifyCheck: 'E2E',
      runId: RUN_ID,
    });

  it('carries every check over when all but the visual one passed', () => {
    const d = of([
      apiRun(1, 'Unit', 'success'),
      apiRun(2, 'Lint', 'skipped'),
      apiRun(3, 'E2E', 'failure'),
    ]);
    expect(d.kind).toBe('ready');
    expect(d.kind === 'ready' && d.carry.map((r) => r.name)).toEqual(['Unit', 'Lint']);
  });

  it.each(['failure', 'cancelled', 'timed_out', 'action_required'])(
    'refuses a check that concluded %s, naming it and its link',
    (conclusion) => {
      expect(of([apiRun(1, 'Unit', 'success'), apiRun(2, 'Lint', conclusion)])).toEqual({
        kind: 'refuse',
        reasons: [`\`Lint\` ${conclusion} (https://github.com/o/r/actions/runs/2/job/2)`],
      });
    },
  );

  it('refuses a check that never ran once nothing on the commit still runs', () => {
    expect(of([apiRun(1, 'Unit', 'success')])).toEqual({
      kind: 'missing',
      reasons: ['`Lint` never ran'],
    });
  });

  it('waits for a check that has not reported while something else still runs', () => {
    expect(of([apiRun(1, 'Unit', 'success'), apiRun(9, 'Deploy', null)])).toEqual({
      kind: 'wait',
      waiting: ['Lint'],
    });
    expect(of([apiRun(1, 'Unit', 'success')], [['Vercel', 'pending']])).toEqual({
      kind: 'wait',
      waiting: ['Lint'],
    });
  });

  it('refuses a failure at once, even while others run', () => {
    expect(of([apiRun(1, 'Unit', null), apiRun(2, 'Lint', 'failure')]).kind).toBe('refuse');
  });

  it('reads the newest run of a check, so a re-run supersedes a failure', () => {
    const d = of([
      apiRun(5, 'Lint', 'success'),
      apiRun(2, 'Lint', 'failure'),
      apiRun(1, 'Unit', 'success'),
    ]);
    expect(d.kind === 'ready' && d.carry.map((r) => r.id)).toEqual([1, 5]);
    expect(
      of([apiRun(2, 'Lint', 'success'), apiRun(6, 'Lint', null), apiRun(1, 'Unit', 'success')]),
    ).toEqual({ kind: 'wait', waiting: ['Lint'] });
  });

  it("leaves out this run's own check runs, and another app's of the same name", () => {
    expect(
      of([
        apiRun(1, 'Unit', 'success'),
        apiRun(2, 'Lint', 'success'),
        apiRun(8, 'Lint', null, { run: RUN_ID }),
        apiRun(9, 'Unit', 'failure', { app: 1 }),
      ]).kind,
    ).toBe('ready');
  });

  it('neither waits for nor carries the visual check, whatever its state', () => {
    const d = of([
      apiRun(1, 'Unit', 'success'),
      apiRun(2, 'Lint', 'success'),
      apiRun(3, 'E2E', null),
    ]);
    expect(d.kind === 'ready' && d.carry.map((r) => r.name)).toEqual(['Unit', 'Lint']);
  });

  it('reads a check any app may report from a commit status, carrying none', () => {
    const req = [
      { context: 'Unit', app: ACTIONS_APP },
      { context: 'Vercel', app: null },
    ];
    const unit = apiRun(1, 'Unit', 'success');
    const ready = of([unit], [['Vercel', 'success']], req);
    expect(ready.kind === 'ready' && ready.carry.map((r) => r.name)).toEqual(['Unit']);
    expect(of([unit], [['Vercel', 'pending']], req)).toEqual({ kind: 'wait', waiting: ['Vercel'] });
    expect(of([unit], [['Vercel', 'error']], req)).toEqual({
      kind: 'refuse',
      reasons: ['`Vercel` error (https://vercel.example/Vercel)'],
    });
    // A check run of that name, from any app, wins over a status.
    const run = apiRun(2, 'Vercel', 'success', { app: 7 });
    const both = of([unit, run], [['Vercel', 'failure']], req);
    expect(both.kind === 'ready' && both.carry.map((r) => r.name)).toEqual(['Unit', 'Vercel']);
  });

  it("refuses a passing status it can't carry over: any but Vercel's", () => {
    const req = [{ context: 'Codecov', app: null }];
    expect(of([], [['Codecov', 'success']], req)).toEqual({
      kind: 'refuse',
      reasons: [
        "`Codecov` is a commit status, which this can't carry over (only Vercel's report on the new commit themselves)",
      ],
    });
  });

  it('reads a context the rule names for two apps once', () => {
    const req = [
      { context: 'Unit', app: ACTIONS_APP },
      { context: 'Unit', app: null },
    ];
    const d = of([apiRun(1, 'Unit', 'success')], [], req);
    expect(d.kind === 'ready' && d.carry).toHaveLength(1);
  });
});

describe('reading the API', () => {
  it('reads every page of the rules and of the check runs', () => {
    const many = Array.from({ length: 150 }, (_, i) => apiRun(i + 1, `c${i}`, 'success'));
    const { github, calls } = fake({
      rules: [Array.from({ length: 100 }, () => rule('Unit')), [rule('Lint')]],
      results: () => ({ runs: many, statuses: [statusPage(['V', 'success']).statuses[0]] }),
    });
    expect(readRequired(github)).toEqual([
      { context: 'Unit', app: ACTIONS_APP },
      { context: 'Lint', app: ACTIONS_APP },
    ]);
    const { runs, statuses } = readResults(github, 'abc');
    expect(runs).toHaveLength(150);
    expect(statuses).toHaveLength(1);
    expect(calls.map((c) => c.route)).toEqual([
      'repos/o/r/rules/branches/main?per_page=100&page=1',
      'repos/o/r/rules/branches/main?per_page=100&page=2',
      'repos/o/r/commits/abc/check-runs?filter=all&per_page=100&page=1',
      'repos/o/r/commits/abc/check-runs?filter=all&per_page=100&page=2',
      'repos/o/r/commits/abc/status?per_page=100&page=1',
    ]);
  });

  it('refuses rules that are not a list', () => {
    const { github } = fake({ rules: [{ message: 'Not Found' }] });
    expect(() => readRequired(github)).toThrow(/branch rules/);
  });
});

describe('awaitChecks', () => {
  const sha = 'a'.repeat(40);

  it('polls while a check runs, then carries once it passes', () => {
    const { github, logs } = fake({
      results: (_, read) => ({
        runs: [
          apiRun(1, 'Unit', 'success'),
          apiRun(2, 'Lint', read < 3 ? null : 'success'),
          apiRun(3, 'E2E', 'failure'),
        ],
      }),
    });
    expect(awaitChecks(github, sha, 'E2E').map((r) => r.name)).toEqual(['Unit', 'Lint']);
    expect(logs).toEqual(['Waiting for Lint on aaaaaaa.', 'Waiting for Lint on aaaaaaa.']);
    expect(github.now()).toBe(2 * POLL_MS);
  });

  it('stops after the wait, naming what still runs', () => {
    const { github } = fake({ results: () => ({ runs: [apiRun(1, 'Unit', null)] }) });
    expect(() => awaitChecks(github, sha, 'E2E')).toThrow(
      "aaaaaaa's checks are still running: Unit, Lint. Run this again once they've finished.",
    );
    expect(github.now()).toBe(WAIT_MS);
  });

  it('gives a check that never reported a grace once all is still: a smoke test starts after its deploy', () => {
    const { github, logs } = fake({
      rules: [[rule('Unit', 'smoke', 'E2E')]],
      results: (_, read) => ({
        runs: [apiRun(1, 'Unit', 'success'), ...(read >= 3 ? [apiRun(2, 'smoke', 'success')] : [])],
      }),
    });
    expect(awaitChecks(github, sha, 'E2E').map((r) => r.name)).toEqual(['Unit', 'smoke']);
    expect(logs).toEqual(['Waiting for `smoke` on aaaaaaa.', 'Waiting for `smoke` on aaaaaaa.']);
  });

  it('refuses a check that never reports once the grace is over', () => {
    const { github } = fake({ results: () => ({ runs: [apiRun(1, 'Unit', 'success')] }) });
    expect(() => awaitChecks(github, sha, 'E2E')).toThrow(
      "Can't update the baselines yet: `Lint` never ran on aaaaaaa.",
    );
    expect(github.now()).toBe(QUIET_MS);
  });

  it('refuses a rule that requires nothing to carry', () => {
    const { github } = fake({ rules: [[rule('E2E')]] });
    expect(() => awaitChecks(github, sha, 'E2E')).toThrow(
      /^The main branch rule requires no check GitHub Actions reports but E2E/,
    );
  });

  it('refuses, naming the check to fix first', () => {
    const { github } = fake({
      results: () => ({ runs: [apiRun(1, 'Unit', 'success'), apiRun(2, 'Lint', 'failure')] }),
    });
    expect(() => awaitChecks(github, sha, 'E2E')).toThrow(
      "Can't update the baselines yet: `Lint` failure (https://github.com/o/r/actions/runs/2/job/2) on aaaaaaa. Fix or re-run that first, then run this again.",
    );
  });
});

describe('posts', () => {
  it('posts the visual check as passed and each carried run with its link', () => {
    const [unit] = checkRunsFromApi({ check_runs: [apiRun(1, 'Unit', 'skipped')] });
    const out = posts({
      sha: 'b'.repeat(40),
      from: 'a'.repeat(40),
      carry: [unit],
      verify: VERIFY,
      workflow: 'Update visual baselines',
      runUrl: 'https://run',
    });
    expect(out).toEqual([
      {
        name: 'E2E',
        head_sha: 'b'.repeat(40),
        status: 'completed',
        conclusion: 'success',
        details_url: 'https://run',
        output: {
          title: 'Passed on this commit',
          summary:
            '[Update visual baselines](https://run) ran `npm run test:e2e` on this commit, once it had written the new visual baselines into it, and it passed.',
        },
      },
      {
        name: 'Unit',
        head_sha: 'b'.repeat(40),
        status: 'completed',
        conclusion: 'skipped',
        details_url: 'https://github.com/o/r/actions/runs/1/job/1',
        output: {
          title: 'Carried over from aaaaaaa',
          summary:
            '[Unit](https://github.com/o/r/actions/runs/1/job/1) concluded skipped on aaaaaaa. This commit is aaaaaaa with new visual baselines and nothing else, so [Update visual baselines](https://run) carried that result over.',
        },
      },
    ]);
  });
});

describe('cancelHeld', () => {
  it('cancels the held runs as they appear, stopping once no more come', () => {
    const { github, calls, logs } = fake({
      held: [[], [11, 12], [11, 12, 13], [11, 12, 13]],
      failCancel: [12],
    });
    expect(cancelHeld(github, 'b'.repeat(40))).toEqual([11, 12, 13]);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.route)).toEqual([
      'repos/o/r/actions/runs/11/cancel',
      'repos/o/r/actions/runs/12/cancel',
      'repos/o/r/actions/runs/13/cancel',
    ]);
    expect(calls[0].route).toBe(
      `repos/o/r/actions/runs?head_sha=${'b'.repeat(40)}&event=pull_request&status=action_required&per_page=100`,
    );
    expect(logs).toEqual(["::warning::Couldn't cancel held run 12: HTTP 409"]);
  });

  it('looks for a minute when none appear', () => {
    const { github, calls } = fake({});
    expect(cancelHeld(github, 'b')).toEqual([]);
    expect(calls).toHaveLength(HELD_POLLS);
  });
});

describe('stillHead', () => {
  it('passes while the branch is at the commit, and stops once it moved', () => {
    const { root, git } = repo({ 'a.txt': '' });
    const run = runIn(root);
    const head = git('rev-parse', 'HEAD').trim();
    expect(() => stillHead(run, 'topic', head)).not.toThrow();
    expect(() => stillHead(run, 'topic', 'f'.repeat(40))).toThrow(
      `topic has moved on from fffffff (it's at ${head.slice(0, 7)}): run this again on its new head`,
    );
    expect(() => stillHead(run, 'gone', head)).toThrow(/at nothing/);
  });
});

describe('amendAndCarry', () => {
  /**
   * An app checkout whose A passed everything but E2E, and a fake GitHub
   * reporting so.
   *
   * @param {{ runs?: unknown[] }} [options]
   */
  function setup({ runs } = {}) {
    const app = repo({ 'shots/a.png': 'old', 'src/x.ts': '' });
    const a = app.git('rev-parse', 'HEAD').trim();
    const f = fake({
      results: (sha) =>
        sha === a
          ? {
              runs: runs ?? [
                apiRun(1, 'Unit', 'success'),
                apiRun(2, 'Lint', 'success'),
                apiRun(3, 'E2E', 'failure'),
              ],
            }
          : {},
      held: [[21]],
    });
    const remoteHead = () =>
      execFileSync('git', ['--git-dir', app.remote, 'rev-parse', 'topic'], {
        encoding: 'utf8',
      }).trim();
    return { ...app, a, ...f, remoteHead };
  }

  /** @param {string} root */
  const write = (root) => () => writeFileSync(path.join(root, 'shots/a.png'), 'new');

  it('amends A with the baselines, verifies, pushes, posts and cancels the held runs', () => {
    const s = setup();
    /** @type {string[]} */
    const order = [];
    const pushed = amendAndCarry({
      verify: VERIFY,
      globs: ['shots'],
      branch: 'topic',
      run: runIn(s.root),
      check: () => order.push(`verify at ${s.git('rev-parse', 'HEAD').trim()}`),
      write: () => {
        order.push('write');
        write(s.root)();
      },
      github: s.github,
    });
    expect(pushed).toBe(true);
    const amended = s.git('rev-parse', 'HEAD').trim();
    expect(order).toEqual(['write', `verify at ${amended}`]);
    expect(s.remoteHead()).toBe(amended);
    expect(s.git('rev-list', '--count', 'HEAD').trim()).toBe('1');
    expect(s.git('log', '-1', '--format=%an|%cn|%s').trim()).toBe(`a|${BOT.name}|first`);
    expect(s.posted().map((c) => [c.body?.name, c.body?.head_sha, c.body?.conclusion])).toEqual([
      ['E2E', amended, 'success'],
      ['Unit', amended, 'success'],
      ['Lint', amended, 'success'],
    ]);
    expect(s.calls.filter((c) => c.route.endsWith('/cancel')).map((c) => c.route)).toEqual([
      'repos/o/r/actions/runs/21/cancel',
    ]);
  });

  it('pushes nothing when the baselines are already up to date', () => {
    const s = setup();
    expect(
      amendAndCarry({
        verify: VERIFY,
        globs: ['shots'],
        branch: 'topic',
        run: runIn(s.root),
        check: () => {},
        write: () => {},
        github: s.github,
      }),
    ).toBe(false);
    expect(s.remoteHead()).toBe(s.a);
    expect(s.posted()).toEqual([]);
  });

  it('refuses before writing anything when another check failed', () => {
    const s = setup({ runs: [apiRun(1, 'Unit', 'failure'), apiRun(2, 'Lint', 'success')] });
    let wrote = false;
    expect(() =>
      amendAndCarry({
        verify: VERIFY,
        globs: ['shots'],
        branch: 'topic',
        run: runIn(s.root),
        check: () => {},
        write: () => {
          wrote = true;
        },
        github: s.github,
      }),
    ).toThrow(/`Unit` failure/);
    expect(wrote).toBe(false);
    expect(s.git('status', '--porcelain')).toBe('');
  });

  it('pushes and posts nothing when the verify command fails', () => {
    const s = setup();
    expect(() =>
      amendAndCarry({
        verify: VERIFY,
        globs: ['shots'],
        branch: 'topic',
        run: runIn(s.root),
        check: () => {
          throw new Error('exit 1');
        },
        write: write(s.root),
        github: s.github,
      }),
    ).toThrow(
      `E2E failed on ${s.a.slice(0, 7)} with the new baselines (its output is above): nothing was pushed`,
    );
    expect(s.remoteHead()).toBe(s.a);
    expect(s.posted()).toEqual([]);
  });

  it('pushes nothing when the amended commit changes more than the baselines', () => {
    const s = setup();
    expect(() =>
      amendAndCarry({
        verify: VERIFY,
        globs: ['shots'],
        branch: 'topic',
        run: runIn(s.root),
        check: () => {},
        write: () => {
          // A command that commits something of its own.
          writeFileSync(path.join(s.root, 'src/x.ts'), 'changed');
          s.git('commit', '-qam', 'sneaky');
          write(s.root)();
        },
        github: s.github,
      }),
    ).toThrow('the amended commit changes more than the baselines (src/x.ts): nothing was pushed');
    expect(s.remoteHead()).toBe(s.a);
  });

  it('stops before starting when the branch has moved on from the checkout', () => {
    const s = setup();
    s.git('commit', '-q', '--allow-empty', '-m', 'local');
    s.git('push', '-q', 'origin', 'topic');
    s.git('reset', '-q', '--hard', s.a);
    expect(() =>
      amendAndCarry({
        verify: VERIFY,
        globs: ['shots'],
        branch: 'topic',
        run: runIn(s.root),
        check: () => {},
        write: write(s.root),
        github: s.github,
      }),
    ).toThrow(/topic has moved on/);
    expect(s.calls).toEqual([]);
  });

  it('pushes and posts nothing when someone pushed after the verify started', () => {
    const s = setup();
    const other = path.join(mkdtempSync(path.join(tmpdir(), 'other-')), 'clone');
    execFileSync('git', ['clone', '-q', '-b', 'topic', s.remote, other]);
    expect(() =>
      amendAndCarry({
        verify: VERIFY,
        globs: ['shots'],
        branch: 'topic',
        run: runIn(s.root),
        check: () => {
          execFileSync('git', [
            '-C',
            other,
            '-c',
            'user.name=b',
            '-c',
            'user.email=b@c.d',
            'commit',
            '-q',
            '--allow-empty',
            '-m',
            'theirs',
          ]);
          execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'topic']);
        },
        write: write(s.root),
        github: s.github,
      }),
    ).toThrow(
      /^topic has moved on from \w{7} \(it's at \w{7}\), so nothing was pushed: run this again on its new head$/,
    );
    expect(
      execFileSync('git', ['--git-dir', s.remote, 'log', '-1', '--format=%s', 'topic'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('theirs');
    expect(s.posted()).toEqual([]);
  });
});

describe('a commit GitHub would refuse, or a push it does', () => {
  /**
   * An app whose remote refuses every push (or takes it), its A having
   * passed, and its fake GitHub.
   *
   * @param {{ files?: string[], refuse?: boolean, failPost?: boolean }} options
   */
  function app({ files, refuse = true, failPost = false }) {
    const made = repo({ 'shots/a.png': 'old' });
    if (refuse) {
      const hook = path.join(made.remote, 'hooks', 'pre-receive');
      writeFileSync(hook, '#!/bin/sh\necho refusing >&2\nexit 1\n', { mode: 0o755 });
    }
    const a = made.git('rev-parse', 'HEAD').trim();
    const f = fake({
      results: (sha) =>
        sha === a ? { runs: [apiRun(1, 'Unit', 'success'), apiRun(2, 'Lint', 'success')] } : {},
      files,
      failPost,
      held: [[31]],
    });
    return { ...made, a, ...f };
  }

  /** @param {ReturnType<typeof app>} s */
  const go = (s) =>
    amendAndCarry({
      verify: VERIFY,
      globs: ['shots'],
      branch: 'topic',
      run: runIn(s.root),
      check: () => {},
      write: () => writeFileSync(path.join(s.root, 'shots/a.png'), 'new'),
      github: s.github,
    });

  it('refuses at once when A changes a workflow, saying what to do', () => {
    const files = [
      ...Array.from({ length: 150 }, (_, i) => `src/${i}.ts`),
      '.github/workflows/ci.yml',
    ];
    const s = app({ files });
    expect(() => go(s)).toThrow(
      `${s.a.slice(0, 7)} changes .github/workflows/ci.yml, and the new baselines would be added to it, which this workflow's token may not push. Push a commit on top of it (an empty one will do: git commit --allow-empty), wait for its checks, then run this again.`,
    );
    // Its files' second page, before any check was read.
    expect(s.calls.map((c) => c.route)).toEqual([
      `repos/o/r/commits/${s.a}?per_page=100&page=1`,
      `repos/o/r/commits/${s.a}?per_page=100&page=2`,
    ]);
  });

  it("points at git's message when GitHub refuses the push", () => {
    const s = app({ files: ['src/a.ts'] });
    expect(() => go(s)).toThrow(
      "GitHub refused the push to topic (git's message is above), so nothing was pushed",
    );
    expect(s.posted()).toEqual([]);
  });

  it('says what to do when the results cannot be posted after the push, leaving the held runs', () => {
    const s = app({ refuse: false, failPost: true });
    expect(() => go(s)).toThrow(
      /^Pushed \w{7} \(\w{7} with the new baselines\), but couldn't post E2E onto it \(HTTP 502\)\. Approve the workflows awaiting approval on the PR, which run its checks on \w{7}, or push a commit on top\.$/,
    );
    expect(s.calls.some((c) => c.route.endsWith('/cancel'))).toBe(false);
  });
});

describe('gitHubFromEnv', () => {
  it("reads the run's variables", () => {
    const g = gitHubFromEnv({
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_RUN_ID: '5',
      GITHUB_SERVER_URL: 'https://ghe',
      GITHUB_WORKFLOW: 'Update visual baselines',
    });
    expect([g.repo, g.runId, g.runUrl, g.workflow]).toEqual([
      'o/r',
      '5',
      'https://ghe/o/r/actions/runs/5',
      'Update visual baselines',
    ]);
    expect(gitHubFromEnv({ GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '5' }).runUrl).toBe(
      'https://github.com/o/r/actions/runs/5',
    );
    const before = Date.now();
    g.sleep(5);
    expect(Date.now() - before).toBeGreaterThanOrEqual(4);
  });

  it.each([{}, { GITHUB_REPOSITORY: 'o/r' }, { GITHUB_REPOSITORY: 'x', GITHUB_RUN_ID: '1' }])(
    'refuses outside Actions: %j',
    (env) => {
      expect(() => gitHubFromEnv(env)).toThrow(/GitHub Actions only/);
    },
  );
});
