import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFiles } from '../review/testApp.mjs';
import { report, run } from './check-body.mjs';

const BAD = '## Goal\n\nOnly this.';
const GOOD = '## Goal\n\nx\n\n## Changes\n\n### 1. y\n\n## Checklist\n\n## Revisions\n';

describe('report', () => {
  it('leaves an app without sharedTemplate alone, whatever the description', () => {
    expect(report({ body: BAD }, false)).toEqual({
      code: 0,
      message: 'PR description: ok (the app has not set visuals.sharedTemplate).',
    });
  });

  it('passes a description in the shape, and fails one that is not, saying how to fix it', () => {
    expect(report({ body: GOOD }, true).code).toBe(0);
    const out = report({ body: BAD }, true);
    expect(out.code).toBe(1);
    expect(out.message).toMatch(/^::error::This PR's description isn't in the shared shape\./);
    expect(out.message).toContain('  - add the heading `## Changes`');
    expect(out.message).toContain('.github/pull_request_template.md');
    expect(out.message).toContain('re-runs this check');
  });

  it('passes a draft, a closed PR, Dependabot and a bot branch, saying why', () => {
    expect(report({ body: BAD, draft: true }, true).message).toMatch(/a draft/);
    expect(report({ body: BAD, state: 'closed' }, true).message).toMatch(/closed PR/);
    expect(report({ body: BAD, author: 'dependabot[bot]' }, true).message).toMatch(/Dependabot/);
    expect(report({ body: BAD, headRef: 'bot/readme-screenshots' }, true).message).toMatch(
      /bot's PR/,
    );
  });

  it('checks a PR with no description', () => {
    expect(report({ body: undefined }, true).code).toBe(1);
  });
});

describe('run', () => {
  const app = (/** @type {Record<string, unknown>} */ visuals) => {
    const root = mkdtempSync(path.join(tmpdir(), 'app-'));
    writeFiles(root, { '.github/ci.json': JSON.stringify({ visuals }) });
    return root;
  };

  it("reads the app's setting and the PR from the environment", () => {
    const env = { PR_BODY: BAD, PR_AUTHOR: 'me', PR_STATE: 'open', PR_DRAFT: 'false' };
    expect(run(env, app({})).code).toBe(0);
    expect(run(env, app({ sharedTemplate: true })).code).toBe(1);
    expect(run({ ...env, PR_DRAFT: 'true' }, app({ sharedTemplate: true })).code).toBe(0);
    expect(run({ ...env, PR_HEAD_REF: 'bot/x' }, app({ sharedTemplate: true })).code).toBe(0);
  });
});
