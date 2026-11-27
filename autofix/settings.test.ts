import { describe, expect, it } from 'vitest';
import { testApp } from '../review/testApp.ts';
import { autofixSettings, DEFAULT_CANNOT_RUN, DEFAULT_CHECKS } from './settings.ts';

const app = (/** @type {unknown} */ autofix) =>
  testApp({ '.github/ci.json': JSON.stringify({ autofix }) });

describe('autofixSettings', () => {
  it('defaults when the app has no key', () => {
    expect(autofixSettings({ root: testApp({}) })).toEqual({
      ciFixChecks: DEFAULT_CHECKS,
      reviewFixChecks: DEFAULT_CHECKS,
      cannotRun: DEFAULT_CANNOT_RUN,
      exempt: {},
      advisor: null,
    });
  });
  it("takes the app's lists, the review checks defaulting to the CI ones", () => {
    const root = app({ ciFixChecks: ['`a`', '`b`'], cannotRun: ['E2E'] });
    expect(autofixSettings({ root, ref: 'origin/main' })).toEqual({
      ciFixChecks: ['`a`', '`b`'],
      reviewFixChecks: ['`a`', '`b`'],
      cannotRun: ['E2E'],
      exempt: {},
      advisor: null,
    });
    const both = app({ ciFixChecks: ['`a`'], reviewFixChecks: ['`make check`'] });
    expect(autofixSettings({ root: both }).reviewFixChecks).toEqual(['`make check`']);
  });
  it('takes exemptions with their reasons, and refuses one without', () => {
    expect(
      autofixSettings({ root: app({ exempt: { 'PR pictures': 'pictures' } }) }).exempt,
    ).toEqual({
      'PR pictures': 'pictures',
    });
    for (const exempt of [['PR pictures'], { 'PR pictures': ' ' }, null]) {
      expect(() => autofixSettings({ root: app({ exempt }) })).toThrow('"autofix.exempt" must map');
    }
  });
  it('refuses a bad list or an unknown key', () => {
    expect(() => autofixSettings({ root: app({ ciFixChecks: 'npm test' }) })).toThrow(
      '"autofix.ciFixChecks" must be a list',
    );
    expect(() => autofixSettings({ root: app({ checks: [] }) })).toThrow(
      '"autofix.checks" is not a setting',
    );
  });
  it('reads the advisor, accepts the ignored "sdk" engine, and refuses bad ones', () => {
    expect(autofixSettings({ root: app({ engine: 'sdk', advisor: 'opus' }) })).toMatchObject({
      advisor: 'opus',
    });
    for (const engine of ['action', 'claude']) {
      expect(() => autofixSettings({ root: app({ engine }) })).toThrow('"autofix.engine"');
    }
    expect(() => autofixSettings({ root: app({ advisor: 'Opus!' }) })).toThrow('"autofix.advisor"');
  });
});
