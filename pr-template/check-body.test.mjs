import { describe, expect, it } from 'vitest';
import { main, report, run } from './check-body.mjs';

const BAD = '## Goal\n\nOnly this.';
const GOOD =
  '## Goal\n\nx. Closes #1.\n\n## Changes\n\n### 1. y\n\n<!-- pr-changes:change:1 -->\n<!-- /pr-changes:change:1 -->\n\n## Checklist\n\n## Revisions\n';

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
