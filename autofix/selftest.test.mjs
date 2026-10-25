import { describe, expect, it } from 'vitest';
import { testApp } from '../review/testApp.mjs';
import { selftest } from './selftest.mjs';

// Workflows written as JSON, which is YAML, so JSON.parse can stand in for
// the app's YAML parser.
const workflow = (/** @type {unknown} */ doc) => JSON.stringify(doc);
const STUB = {
  name: 'Claude Auto-Fix PR Comments',
  on: { workflow_run: { workflows: ['CI', 'Claude Review'], types: ['completed'] } },
  jobs: { autofix: { steps: [{ uses: 'jbhirsh/ci/autofix@main' }] } },
};
const WORKFLOWS = {
  '.github/workflows/claude-autofix.yml': workflow(STUB),
  '.github/workflows/ci.yml': workflow({ name: 'CI', on: 'pull_request' }),
  '.github/workflows/claude-review.yml': workflow({ name: 'Claude Review', on: ['pull_request'] }),
};
const parse = { parse: JSON.parse };

describe('selftest', () => {
  it('passes an app with no settings, and one with its own checks', async () => {
    expect((await selftest(testApp(WORKFLOWS), parse)).join('\n')).toContain('1 CI-fix check(s)');
    const root = testApp({
      ...WORKFLOWS,
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest' } }),
      Makefile: 'check:\n\tnpm run lint\n',
      '.github/ci.json': JSON.stringify({
        autofix: {
          ciFixChecks: ['`npm run lint`', '`npm test`'],
          reviewFixChecks: ['`make check`'],
        },
      }),
    });
    const log = (await selftest(root, parse)).join('\n');
    expect(log).toContain('2 CI-fix check(s), 1 review-fix check(s)');
    expect(log).toContain('commands: every listed check runs in the app');
    expect(log).toContain('review-fix prompt: renders');
    expect(log).toContain('triggers: CI, Claude Review; exempt: none');
  });
  it('fails on settings that do not parse', async () => {
    const root = testApp({ ...WORKFLOWS, '.github/ci.json': '{"autofix": {"ciFixChecks": [1]}}' });
    await expect(selftest(root, parse)).rejects.toThrow('must be a list');
  });
  it('fails a check the app cannot run', async () => {
    const root = testApp({
      ...WORKFLOWS,
      '.github/ci.json': JSON.stringify({ autofix: { ciFixChecks: ['`npm run lint`'] } }),
    });
    await expect(selftest(root, parse)).rejects.toThrow('no "lint" script');
  });
  it('fails a pull-request workflow missing from the trigger list', async () => {
    const root = testApp({
      ...WORKFLOWS,
      '.github/workflows/e2e.yml': workflow({ name: 'E2E', on: { pull_request: null } }),
    });
    await expect(selftest(root, parse)).rejects.toThrow('e2e.yml ("E2E") runs on pull requests');
    const exempt = testApp({
      ...WORKFLOWS,
      '.github/workflows/e2e.yml': workflow({ name: 'E2E', on: { pull_request: null } }),
      '.github/ci.json': JSON.stringify({ autofix: { exempt: { E2E: 'why' } } }),
    });
    expect((await selftest(exempt, parse)).join('\n')).toContain('exempt: E2E');
  });
  it("skips the trigger check while the app's autofix isn't this action", async () => {
    const root = testApp({
      ...WORKFLOWS,
      '.github/workflows/claude-autofix.yml': workflow({ ...STUB, jobs: {} }),
      '.github/workflows/e2e.yml': workflow({ name: 'E2E', on: 'pull_request' }),
    });
    expect((await selftest(root, parse)).join('\n')).toContain('triggers: not checked');
    expect((await selftest(testApp({}), parse)).join('\n')).toContain('triggers: not checked');
  });
});
