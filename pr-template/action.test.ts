import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const read = (/** @type {string} */ name) => readFileSync(new URL(name, import.meta.url), 'utf8');
/** @type {{ runs: { steps: { uses?: string, env?: Record<string, string>, run?: string }[] } }} */
const action = parse(read('./action.yml'));
const script = read('./check-body.ts');

describe('the PR description action', () => {
  const checkStep = action.runs.steps.find((step) => step.run);

  it('passes the check every variable its run() reads, each from the PR event', () => {
    const wanted = new Set([...script.matchAll(/\benv\.(PR_[A-Z_]+)/g)].map((m) => m[1]));
    expect(wanted.size).toBeGreaterThan(0);
    expect(new Set(Object.keys(checkStep?.env ?? {}))).toEqual(wanted);
    for (const value of Object.values(checkStep?.env ?? {})) {
      expect(value).toMatch(/^\$\{\{ github\.event\.(pull_request\.)?[a-z_.]+ \}\}$/);
    }
  });

  it('runs only the check, with no checkout and no token, so the job can hold no permissions', () => {
    expect(checkStep?.run).toBe('node "$GITHUB_ACTION_PATH/check-body.ts"');
    expect(action.runs.steps.filter((step) => step.run)).toHaveLength(1);
    expect(JSON.stringify(action.runs)).not.toMatch(/checkout|github-token|secrets\./);
  });
});
