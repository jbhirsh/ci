import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  END,
  AUTHOR,
  MARKER,
  MAX_CHARS,
  PAGES,
  clean,
  composeComment,
  explain,
  findComment,
  jobOrder,
  keepComments,
  main,
  mergeSections,
  parseSections,
  pullRequestsOf,
  realDownload,
  statusOf,
} from './comment.mjs';

const REPO = 'jbhirsh/BoardGames';
const HEAD = '69e83c5aa1b2c3d4e5f60718293a4b5c6d7e8f90';
const OLD = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';

/**
 * A section.
 *
 * @param {string} workflow
 * @param {string} job
 * @param {string} [text]
 * @param {string} [sha]
 * @returns {import('./comment.mjs').Section}
 */
const sec = (workflow, job, text = `**${job}:** ✅ no step failed`, sha = HEAD) => ({
  workflow,
  job,
  sha,
  text,
});

const by = {
  workflow: 'CI',
  number: 412,
  url: 'https://github.com/jbhirsh/BoardGames/actions/runs/9',
};

/**
 * An HTTP error as gh reports one.
 *
 * @param {number} status
 */
const httpError = (status) =>
  Object.assign(new Error(`Command failed: gh api\ngh: Something (HTTP ${status})`), {
    stderr: `gh: Something (HTTP ${status})\n`,
  });

/**
 * A fake GitHub: a run with its jobs, its pull requests and their comments,
 * and the artifacts its jobs left.
 *
 * @param {object} [opts]
 * @param {string} [opts.workflow]
 * @param {{ number: number, url?: string }[]} [opts.listed] the run's pull_requests
 * @param {unknown[]} [opts.byCommit] what commits/<sha>/pulls answers
 * @param {string} [opts.prHead] the pull request's head now
 * @param {{ id: number, body: string }[]} [opts.comments]
 * @param {Record<string, string>} [opts.sections] artifact slug to section.md
 * @param {string[]} [opts.jobs] the run's jobs, in order
 * @param {Record<string, unknown>} [opts.fail] a route prefix ("POST repos/…") to the error it throws
 */
function fakeGitHub(opts = {}) {
  const workflow = opts.workflow ?? 'CI';
  /** @type {{ id: number, body: string, user: { login: string } }[]} */
  const comments = (opts.comments ?? []).map((c) => ({ ...c, user: { login: AUTHOR } }));
  /** @type {string[]} */
  const calls = [];
  /** @type {import('./comment.mjs').Api} */
  const api = (method, route, body) => {
    calls.push(`${method} ${route}`);
    for (const [prefix, error] of Object.entries(opts.fail ?? {})) {
      if (`${method} ${route}`.startsWith(prefix)) throw error;
    }
    if (route === `repos/${REPO}/actions/runs/9`) {
      return {
        name: workflow,
        run_number: 412,
        head_sha: HEAD,
        html_url: 'https://github.com/jbhirsh/BoardGames/actions/runs/9',
        pull_requests: opts.listed ?? [
          { number: 7, url: `https://api.github.com/repos/${REPO}/pulls/7` },
        ],
      };
    }
    if (route.startsWith(`repos/${REPO}/actions/runs/9/jobs`)) {
      return { jobs: (opts.jobs ?? []).map((name) => ({ name })) };
    }
    if (route === `repos/${REPO}/commits/${HEAD}/pulls`) return opts.byCommit ?? [];
    if (route === `repos/${REPO}/pulls/7`) return { head: { sha: opts.prHead ?? HEAD } };
    if (route.startsWith(`repos/${REPO}/issues/7/comments?`)) {
      const page = Number(/[?&]page=(\d+)/.exec(route)?.[1]);
      return page === 1 ? comments : [];
    }
    if (method === 'POST' && route === `repos/${REPO}/issues/7/comments`) {
      comments.push({
        id: 100 + comments.length,
        body: String(body?.body),
        user: { login: AUTHOR },
      });
      return {};
    }
    const edit = /^repos\/.+\/issues\/comments\/(\d+)$/.exec(route);
    if (method === 'PATCH' && edit) {
      const c = comments.find((x) => x.id === Number(edit[1]));
      if (c) c.body = String(body?.body);
      return {};
    }
    throw httpError(404);
  };
  /** @type {import('./comment.mjs').Download} */
  const download = (_runId, dir) => {
    const sections = opts.sections ?? {};
    if (!Object.keys(sections).length) throw new Error('no artifacts');
    for (const [slug, text] of Object.entries(sections)) {
      mkdirSync(path.join(dir, `job-summary-${slug}`), { recursive: true });
      writeFileSync(path.join(dir, `job-summary-${slug}`, 'report.html'), '<p>report</p>');
      if (text !== '-') writeFileSync(path.join(dir, `job-summary-${slug}`, 'section.md'), text);
    }
  };
  return { api, download, comments, calls };
}

const env = { GITHUB_REPOSITORY: REPO, RUN_ID: '9' };

describe('parseSections', () => {
  it('reads each section back from a comment, in order, leaving out everything else', () => {
    const body = composeComment(
      REPO,
      HEAD,
      [sec('CI', 'ci', '**ci:** ✅\n- **Failed step:** x'), sec('E2E', 'e2e', 'two', OLD)],
      by,
    );
    expect(parseSections(body)).toEqual([
      sec('CI', 'ci', '**ci:** ✅\n- **Failed step:** x'),
      sec('E2E', 'e2e', 'two', OLD),
    ]);
    expect(parseSections('')).toEqual([]);
    expect(parseSections(body.replace(/\n/g, '\r\n'))).toHaveLength(2);
  });

  it('keeps the first of a job twice, and skips a marker that does not decode', () => {
    const one = `<!-- job-reports:section workflow=CI job=a sha=${HEAD} -->\nfirst\n${END}`;
    const two = `<!-- job-reports:section workflow=CI job=a sha=${HEAD} -->\nsecond\n${END}`;
    const bad = `<!-- job-reports:section workflow=%E0%A4%A job=b sha=x -->\nbad\n${END}`;
    expect(parseSections([one, two, bad].join('\n\n'))).toEqual([sec('CI', 'a', 'first')]);
  });
});

describe('mergeSections', () => {
  it("replaces the run's workflow's sections, keeps the others, by workflow then job order", () => {
    const existing = [sec('E2E', 'e2e'), sec('CI', 'ci', 'old'), sec('CI', 'gone', 'old')];
    const own = [sec('CI', 'ci', 'new'), sec('CI', 'build', 'new')];
    expect(mergeSections(existing, own, 'CI')).toEqual([
      sec('CI', 'ci', 'new'),
      sec('CI', 'build', 'new'),
      sec('E2E', 'e2e'),
    ]);
    expect(mergeSections([sec('Visual', 'v'), sec('CI', 'c')], [sec('E2E', 'e')], 'E2E')).toEqual([
      sec('CI', 'c'),
      sec('E2E', 'e'),
      sec('Visual', 'v'),
    ]);
  });
});

describe('composeComment', () => {
  it('heads it with the commit, marks each section and names the run that updated it', () => {
    const body = composeComment(REPO, HEAD, [sec('CI', 'ci', '**ci:** ✅ fine')], by);
    expect(body).toBe(
      [
        MARKER,
        '### Job reports · `69e83c5`',
        '',
        `<!-- job-reports:section workflow=CI job=ci sha=${HEAD} -->`,
        '**ci:** ✅ fine',
        END,
        '',
        '<sub>Updated by Job reports after each run, last after [CI #412](https://github.com/jbhirsh/BoardGames/actions/runs/9).</sub>',
      ].join('\n'),
    );
  });

  it("labels a section from an earlier commit, and escapes what it can't trust", () => {
    const body = composeComment(
      REPO,
      HEAD,
      [sec('Visual regression', 'visual', 'v <!-- x', OLD), sec('E', 'e', 't', 'nope')],
      { ...by, workflow: 'C[I]' },
    );
    expect(body).toContain('workflow=Visual%20regression job=visual');
    expect(body).toContain(`v &lt;!-- x\n${END}\n<sub>From an earlier commit, \`1a2b3c4\`.</sub>`);
    expect(body).toContain(`${END}\n<sub>From an earlier commit.</sub>`);
    expect(body).toContain('[C\\[I\\] #412]');
    expect(composeComment(REPO, 'x', [], by)).toContain('### Job reports · `unknown`');
  });

  it("cuts a comment over GitHub's limit at a line, keeping the cut section's marker", () => {
    const line = 'y'.repeat(999);
    const big = Array.from({ length: 40 }, () => line).join('\n');
    const body = composeComment(REPO, HEAD, [sec('A', 'a', big), sec('B', 'b', big)], by);
    expect(body.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(body).toContain(
      "…cut here: the comment would be over GitHub's limit of 65,536 characters.",
    );
    expect(body).toContain('[the reports site](https://jbhirsh.github.io/BoardGames)');
    const kept = parseSections(body);
    expect(kept.map((s) => s.job)).toEqual(['a', 'b']);
    expect(kept[1].text.split('\n').length).toBeLessThan(40);
    expect(body.endsWith('</sub>')).toBe(true);
    // A section with no line that fits is left out, and a repository with
    // no Pages address isn't linked.
    const one = composeComment('', HEAD, [sec('A', 'a', 'z'.repeat(MAX_CHARS))], by);
    expect(parseSections(one)).toEqual([]);
    expect(one).toContain("on its run's page.");
  });
});

describe('statusOf and explain', () => {
  it("reads a call's status from itself or gh's message", () => {
    expect(statusOf(Object.assign(new Error('x'), { status: 403 }))).toBe(403);
    expect(statusOf(httpError(422))).toBe(422);
    expect(statusOf(new Error('timeout'))).toBeNull();
    expect(statusOf('odd')).toBeNull();
  });

  it('is a notice when the token may not comment, a warning otherwise', () => {
    expect(explain(httpError(403), '#7')).toMatch(/^::notice::.*#7.*pull-requests: write/);
    expect(explain(httpError(500), '#7')).toBe(
      '::warning::job-reports: no comment on #7: gh: Something (HTTP 500)',
    );
    expect(explain('odd', 'run 9')).toBe('::warning::job-reports: no comment on run 9: odd');
  });
});

describe('pullRequestsOf', () => {
  const run = { name: 'CI', run_number: 1, head_sha: HEAD, html_url: '' };

  it("takes the run's own pull requests in this repository", () => {
    const { api } = fakeGitHub();
    const listed = [
      { number: 7, url: `https://api.github.com/repos/${REPO}/pulls/7` },
      { number: 3, url: 'https://api.github.com/repos/someone/else/pulls/3' },
      { number: 7 },
    ];
    expect(pullRequestsOf(api, REPO, { ...run, pull_requests: listed })).toEqual([7]);
  });

  it("else looks up open ones from this repository by the run's commit", () => {
    const { api } = fakeGitHub({
      byCommit: [
        { number: 7, state: 'open', head: { repo: { full_name: 'JBHirsh/BoardGames' } } },
        { number: 8, state: 'closed', head: { repo: { full_name: REPO } } },
        { number: 9, state: 'open', head: { repo: { full_name: 'fork/BoardGames' } } },
        { number: 10, state: 'open', head: { repo: null } },
      ],
    });
    expect(pullRequestsOf(api, REPO, run)).toEqual([7]);
    expect(pullRequestsOf(() => ({}), REPO, run)).toEqual([]);
  });
});

describe('findComment and jobOrder', () => {
  it('finds the comment that starts with the marker, over pages, or none', () => {
    const bot = { login: AUTHOR };
    const page = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      body: `> ${MARKER} quoted`,
      user: bot,
    }));
    /** @type {import('./comment.mjs').Api} */
    const api = (_m, route) =>
      route.endsWith('page=1')
        ? page
        : [
            { id: 500, body: null, user: bot },
            // The marker in someone else's comment doesn't make it this one.
            { id: 499, body: `${MARKER}\nplanted`, user: { login: 'someone' } },
            { id: 498, body: `${MARKER}\nno author` },
            { id: 501, body: `${MARKER}\nx`, user: bot },
          ];
    expect(findComment(api, REPO, 7)).toEqual({ id: 501, body: `${MARKER}\nx` });
    expect(findComment(() => ({}), REPO, 7)).toBeNull();
    let calls = 0;
    expect(
      findComment(
        () => {
          calls++;
          return page;
        },
        REPO,
        7,
      ),
    ).toBeNull();
    expect(calls).toBe(PAGES);
  });

  it("orders the run's jobs by artifact slug, or not at all when the API won't say", () => {
    const { api } = fakeGitHub({ jobs: ['ci', 'E2E Tests (Playwright)', 'ci'] });
    expect([...jobOrder(api, REPO, '9')]).toEqual([
      ['ci', 0],
      ['e2e-tests-playwright', 1],
    ]);
    expect(jobOrder(() => ({}), REPO, '9').size).toBe(0);
    const failing = fakeGitHub({
      fail: { 'GET repos/jbhirsh/BoardGames/actions/runs/9/jobs': httpError(500) },
    });
    expect(jobOrder(failing.api, REPO, '9').size).toBe(0);
  });
});

describe('keepComments', () => {
  it('creates the comment on the first run, its sections in job order', () => {
    const gh = fakeGitHub({
      jobs: ['ci', 'Lint'],
      sections: {
        zeta: '**Zeta:** ✅',
        lint: '**Lint:** ✅',
        ci: '**ci:** ❌ 1 of 3 tests failed',
      },
    });
    expect(keepComments(env, gh.api, gh.download)).toEqual([
      'Posted the job reports comment on #7.',
    ]);
    expect(gh.comments).toHaveLength(1);
    expect(parseSections(gh.comments[0].body).map((s) => s.job)).toEqual(['ci', 'lint', 'zeta']);
  });

  it('edits it in place on a later run, and leaves it alone when nothing changed', () => {
    const gh = fakeGitHub({ sections: { ci: '**ci:** ✅' } });
    keepComments(env, gh.api, gh.download);
    const again = fakeGitHub({ comments: gh.comments, sections: { ci: '**ci:** ❌ broke' } });
    expect(keepComments(env, again.api, again.download)).toEqual([
      'Updated the job reports comment on #7.',
    ]);
    expect(again.comments).toHaveLength(1);
    expect(again.comments[0].body).toContain('**ci:** ❌ broke');
    expect(
      again.calls.some((c) => c.startsWith('PATCH repos/jbhirsh/BoardGames/issues/comments/100')),
    ).toBe(true);
    const same = fakeGitHub({ comments: again.comments, sections: { ci: '**ci:** ❌ broke' } });
    expect(keepComments(env, same.api, same.download)).toEqual([
      'The job reports comment on #7 is already up to date.',
    ]);
    expect(same.calls.some((c) => /^(PATCH|POST) /.test(c))).toBe(false);
  });

  it("keeps the other workflow's sections, labelled when from an earlier commit", () => {
    const e2e = composeComment(
      REPO,
      OLD,
      [sec('E2E', 'e2e', '**E2E:** ✅', OLD), sec('CI', 'ci', 'old', OLD)],
      by,
    );
    const gh = fakeGitHub({
      comments: [{ id: 1, body: e2e }],
      sections: { ci: '**ci:** ✅ new' },
    });
    keepComments(env, gh.api, gh.download);
    const sections = parseSections(gh.comments[0].body);
    expect(sections).toEqual([
      sec('CI', 'ci', '**ci:** ✅ new'),
      sec('E2E', 'e2e', '**E2E:** ✅', OLD),
    ]);
    expect(gh.comments[0].body).toContain('<sub>From an earlier commit, `1a2b3c4`.</sub>');
    expect(gh.comments[0].body).toContain('### Job reports · `69e83c5`');
  });

  it("skips a run for a commit that's no longer the pull request's head", () => {
    const gh = fakeGitHub({ prHead: 'f'.repeat(40), sections: { ci: 'x' } });
    expect(keepComments(env, gh.api, gh.download)).toEqual([
      "::notice::job-reports: #7 is at fffffff now, newer than this run's 69e83c5; its comment is left to that commit's runs.",
    ]);
    expect(gh.comments).toEqual([]);
    expect(gh.calls.some((c) => c.includes('/comments'))).toBe(false);
  });

  it('logs a 403 as a notice and skips, and any other failure as a warning', () => {
    const denied = fakeGitHub({
      sections: { ci: 'x' },
      fail: { 'POST repos/jbhirsh/BoardGames/issues/7/comments': httpError(403) },
    });
    const [line] = keepComments(env, denied.api, denied.download);
    expect(line).toMatch(
      /^::notice::job-reports: no comment on #7: the token can't write it \(HTTP 403/,
    );
    const broken = fakeGitHub({
      sections: { ci: 'x' },
      fail: { 'GET repos/jbhirsh/BoardGames/actions/runs/9': httpError(502) },
    });
    expect(keepComments(env, broken.api, broken.download)).toEqual([
      '::warning::job-reports: no comment on run 9: gh: Something (HTTP 502)',
    ]);
  });

  it('posts nothing without a pull request, sections or reports', () => {
    const push = fakeGitHub({ listed: [], sections: { ci: 'x' } });
    expect(keepComments(env, push.api, push.download)).toEqual([
      'Run 9 has no open pull request, so no comment.',
    ]);
    const old = fakeGitHub({ sections: { ci: '-', e2e: '  \n' } });
    expect(keepComments(env, old.api, old.download)).toEqual([
      'Run 9 has no job sections, so no comment.',
    ]);
    const none = fakeGitHub();
    expect(keepComments(env, none.api, none.download)).toEqual([
      'Run 9 has no job reports, so no comment.',
    ]);
    expect(keepComments({ RUN_ID: 'x' }, none.api, none.download)).toEqual([
      '::warning::job-reports: GITHUB_REPOSITORY and RUN_ID are needed to comment.',
    ]);
    expect([...push.calls, ...old.calls, ...none.calls].some((c) => /^(PATCH|POST) /.test(c))).toBe(
      false,
    );
  });
});

describe('main', () => {
  it('logs each line and never throws', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const gh = fakeGitHub({ sections: { ci: 'x' } });
    main(env, gh.api, gh.download);
    main(env, gh.api, () => {
      throw new Error('gone');
    });
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      'Posted the job reports comment on #7.',
      'Run 9 has no job reports, so no comment.',
    ]);
    log.mockRestore();
  });
});

describe('realDownload', () => {
  it("copies artifacts already downloaded inside the run, and has none when they're missing", () => {
    const from = mkdtempSync(path.join(tmpdir(), 'artifacts-'));
    const to = mkdtempSync(path.join(tmpdir(), 'copied-'));
    try {
      mkdirSync(path.join(from, 'job-summary-ci'));
      writeFileSync(path.join(from, 'job-summary-ci', 'section.md'), '**ci:** ✅');
      realDownload({ ARTIFACTS: from })('9', to);
      expect(readFileSync(path.join(to, 'job-summary-ci', 'section.md'), 'utf8')).toBe(
        '**ci:** ✅',
      );
      const empty = mkdtempSync(path.join(tmpdir(), 'empty-'));
      expect(() => realDownload({ ARTIFACTS: empty })('9', to)).toThrow('no artifacts');
      rmSync(empty, { recursive: true });
      expect(() => realDownload({ ARTIFACTS: path.join(from, 'nope') })('9', to)).toThrow();
    } finally {
      rmSync(from, { recursive: true });
      rmSync(to, { recursive: true });
    }
  });
});

describe('clean', () => {
  it('trims, drops carriage returns and opens no marker', () => {
    expect(clean('  a\r\n<!-- b -->  ')).toBe('a\n&lt;!-- b -->');
  });

  it('mentions no one, and changes nothing the second time', () => {
    const once = clean('**Failed:** resolves @types/node for @jbhirsh, mail a@b.c, @ alone');
    expect(once).toBe('**Failed:** resolves @​types/node for @​jbhirsh, mail a@​b.c, @ alone');
    expect(clean(once)).toBe(once);
  });
});
