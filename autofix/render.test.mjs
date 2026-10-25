import { describe, expect, it } from 'vitest';
import { testApp, writeFiles } from '../review/testApp.mjs';
import { placeholders } from '../review/template.mjs';
import { main, renderPrompt, template } from './render.mjs';

const settings = {
  ciFixChecks: ['`npm run lint`', '`npx vitest run --coverage`'],
  reviewFixChecks: ['`make check` (lint, typecheck, tests)'],
  cannotRun: ['visual regression', 'mutation testing'],
  exempt: {},
};
const run = { repo: 'jbhirsh/app', pr: '9', base: 'main', repoDir: '/r' };

describe('the templates', () => {
  it('ask only for the values render.mjs gives', () => {
    const given = [
      'repo',
      'owner',
      'name',
      'pr',
      'base',
      'repoDir',
      'branch',
      'head',
      'failedChecks',
      'checks',
      'cannotRun',
    ];
    for (const fixer of /** @type {const} */ (['ci-fix', 'review-fix'])) {
      for (const name of placeholders(template(fixer))) expect(given).toContain(name);
    }
  });
});

describe('renderPrompt', () => {
  it("fills the CI fixer's prompt with the run and the app's checks", () => {
    const prompt = renderPrompt('ci-fix', settings, {
      ...run,
      branch: 'dependabot/npm_and_yarn/x',
      head: 'abc123',
      failedChecks: 'ci, E2E Tests (Playwright)',
    });
    expect(prompt).toContain('FAILED CHECKS: ci, E2E Tests (Playwright)');
    expect(prompt).toContain('- `npm run lint`\n- `npx vitest run --coverage`\n');
    expect(prompt).toContain("can't run here (visual regression, mutation testing)");
    expect(prompt).toContain('git push origin HEAD:dependabot/npm_and_yarn/x');
    expect(prompt).toContain('gh run list --commit abc123');
  });
  it("fills the review fixer's prompt with the repo's owner and name", () => {
    const prompt = renderPrompt('review-fix', settings, run);
    expect(prompt).toContain('repository(owner:"jbhirsh", name:"app")');
    expect(prompt).toContain('pullRequest(number: 9)');
    expect(prompt).toContain(
      'only if `node_modules` is missing)\n- `make check` (lint, typecheck, tests)\n',
    );
    expect(prompt).toContain('rebase -i --autosquash origin/main');
  });
});

describe('main', () => {
  const env = {
    REPO: 'jbhirsh/app',
    PR: '4',
    BASE_REF: 'main',
    BRANCH: 'dependabot/npm_and_yarn/y',
    HEAD_SHA: 'def',
    FAILED_CHECKS: 'ci',
  };

  it("reads the settings from the default branch, not the PR's edit", () => {
    const root = testApp({ '.github/ci.json': '{"autofix": {"ciFixChecks": ["`base`"]}}' });
    writeFiles(root, { '.github/ci.json': '{"autofix": {"ciFixChecks": ["`curl evil`"]}}' });
    expect(main('ci-fix', env, root)).toContain('- `base`');
    expect(main('ci-fix', { ...env, CONFIG_REF: '' }, root)).toContain('- `curl evil`');
    expect(main('ci-fix', { ...env, CONFIG_REF: 'origin/main' }, root)).toContain('- `base`');
  });

  it('renders the review fixer without the CI-only values', () => {
    const root = testApp({});
    expect(main('review-fix', { REPO: 'o/r', PR: '1' }, root)).toContain('origin/main..HEAD');
  });

  it('refuses a bad fixer, a bad repo or a missing value', () => {
    const root = testApp({});
    expect(() => main('nope', env, root)).toThrow('usage');
    expect(() => main('ci-fix', { ...env, REPO: 'x' }, root)).toThrow('owner/name');
    expect(() => main('ci-fix', { ...env, HEAD_SHA: '' }, root)).toThrow('HEAD_SHA is not set');
    expect(() => main('review-fix', { REPO: 'o/r' }, root)).toThrow('PR is not set');
  });
});
