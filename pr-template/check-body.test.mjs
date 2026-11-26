import { describe, expect, it } from 'vitest';
import { main, report, run } from './check-body.mjs';

const BAD = '## Goal\n\nOnly this.';
const GOOD =
  '## Goal\n\nx. Closes #1.\n\n## Changes\n\n### 1. y\n\n<!-- pr-changes:change:1 -->\n[`abc1234`](https://x/commit/abc1234)\n<!-- /pr-changes:change:1 -->\n\n## Checklist\n\n## Revisions\n';

describe('report', () => {
  it('passes a description in the shape, and fails one that is not, saying how to fix it', () => {
    expect(report({ body: GOOD }).code).toBe(0);
    const out = report({ body: BAD });
    expect(out.code).toBe(1);
    expect(out.message).toMatch(/^::error::This PR's description isn't in the shared shape\./);
    expect(out.message).toContain('  - add the heading `## Changes`');
    expect(out.message).toContain('.github/pull_request_template.md');
    expect(out.message).toContain('re-runs this check');
  });

  it('checks a draft like any other PR, and passes a closed PR, Dependabot and a bot branch, saying why', () => {
    expect(report({ body: BAD, state: 'open' }).code).toBe(1);
    expect(report({ body: BAD, state: 'closed' }).message).toMatch(/closed PR/);
    expect(report({ body: BAD, author: 'dependabot[bot]' }).message).toMatch(/Dependabot/);
    expect(report({ body: BAD, headRef: 'bot/readme-screenshots' }).message).toMatch(/bot's PR/);
  });

  it("fails a description whose Revisions name another commit than the PR's head", () => {
    const body = `${GOOD}| Rev | Head |\n| --- | --- |\n| 1 (current) | [\`1111111\`](https://x) |\n`;
    expect(report({ body, headSha: '1111111aaaa' }).code).toBe(0);
    const out = report({ body, headSha: '2222222bbbb' });
    expect(out.code).toBe(1);
    expect(out.message).toContain('update Revisions');
  });

  it('passes the push to the check, and a PR that was not pushed to needs no pair', () => {
    const none = GOOD;
    expect(report({ body: none, action: 'opened' }).code).toBe(0);
    for (const action of ['edited', 'reopened', 'ready_for_review']) {
      expect(report({ body: none, action }).code).toBe(0);
    }
    const pushed = report({ body: none, action: 'synchronize' });
    expect(pushed.code).toBe(1);
    expect(pushed.message).toContain('pr-changes:revisions');
    expect(report({ body: none, action: 'synchronize', author: 'dependabot[bot]' }).code).toBe(0);
    expect(report({ body: none, action: 'synchronize', headRef: 'bot/x' }).code).toBe(0);
  });

  it('fails a current revision with no filled row, saying what to do, and passes closed, Dependabot and bot PRs (ci#140)', () => {
    const head = 'abcdef0'.padEnd(40, '1');
    const rows = (/** @type {string} */ row) =>
      `${GOOD}\n<!-- pr-changes:revisions -->\n<details open>\n<summary><b>👉 <a href="https://github.com/o/r/commit/${head}"><code>abcdef0</code></a></b> (current)</summary>\n\n| What changed | Why |\n| --- | --- |\n${row}\n\n</details>\n<!-- /pr-changes:revisions -->\n`;
    const empty = rows('|  |  |');
    for (const action of ['synchronize', 'edited']) {
      expect(report({ body: empty, headSha: head, action })).toEqual({
        code: 1,
        message: [
          "::error::This PR's description isn't in the shared shape.",
          "  - fill Revisions' current revision, `abcdef0`: its table has no row with both cells filled. In the description, write one row for each change this push made, both cells in plain words, such as `| The cap fails closed | It's the only paid API |` (each row opens with `|`; write a pipe in a cell as `\\|`). Do it once this push's `PR changes` run has ended: a run still going can write an older copy over your edit",
          "The template is the app's `.github/pull_request_template.md` (jbhirsh/ci's `.github/pull_request_template.md` is the master). Editing the description re-runs this check.",
        ].join('\n'),
      });
    }
    expect(report({ body: rows('| The cap | Paid |'), headSha: head, action: 'edited' }).code).toBe(
      0,
    );
    expect(report({ body: empty, headSha: head, state: 'closed' }).code).toBe(0);
    expect(report({ body: empty, headSha: head, author: 'dependabot[bot]' }).code).toBe(0);
    expect(report({ body: empty, headSha: head, headRef: 'bot/x' }).code).toBe(0);
  });

  it('checks a PR with no description', () => {
    expect(report({ body: undefined }).code).toBe(1);
  });
});

describe('run', () => {
  it('reads the PR from the environment', () => {
    const env = { PR_BODY: BAD, PR_AUTHOR: 'me', PR_STATE: 'open', PR_DRAFT: 'false' };
    expect(run(env).code).toBe(1);
    expect(run({ ...env, PR_DRAFT: 'true' }).code).toBe(1);
    const stale = `${GOOD}| Rev | Head |\n| --- | --- |\n| 1 (current) | [\`1111111\`](https://x) |\n`;
    const open = { ...env, PR_BODY: stale };
    expect(run({ ...open, PR_HEAD_SHA: '1111111aa' }).code).toBe(0);
    expect(run({ ...open, PR_HEAD_SHA: '2222222bb' }).code).toBe(1);
    expect(run({ ...env, PR_HEAD_REF: 'bot/x' }).code).toBe(0);
  });
});

describe('main', () => {
  it('prints the verdict and returns the exit code', () => {
    /** @type {string[]} */
    const out = [];
    expect(main({ PR_BODY: BAD, PR_STATE: 'open' }, (l) => out.push(l))).toBe(1);
    expect(out[0]).toMatch(/^::error::/);
    expect(main({ PR_BODY: GOOD, PR_STATE: 'open' }, (l) => out.push(l))).toBe(0);
    expect(out[1]).toBe('PR description: ok (in the shared shape).');
  });
});
