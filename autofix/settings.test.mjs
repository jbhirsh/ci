import { describe, expect, it } from 'vitest';
import { testApp } from '../review/testApp.mjs';
import { autofixSettings, DEFAULT_CANNOT_RUN, DEFAULT_CHECKS } from './settings.mjs';

const app = (/** @type {unknown} */ autofix) =>
  testApp({ '.github/ci.json': JSON.stringify({ autofix }) });

describe('autofixSettings', () => {
  it('defaults when the app has no key', () => {
    expect(autofixSettings({ root: testApp({}) })).toEqual({
      ciFixChecks: DEFAULT_CHECKS,
      reviewFixChecks: DEFAULT_CHECKS,
      cannotRun: DEFAULT_CANNOT_RUN,
      exempt: {},
    });
  });
  it("takes the app's lists, the review checks defaulting to the CI ones", () => {
    const root = app({ ciFixChecks: ['`a`', '`b`'], cannotRun: ['E2E'] });
    expect(autofixSettings({ root, ref: 'origin/main' })).toEqual({
      ciFixChecks: ['`a`', '`b`'],
      reviewFixChecks: ['`a`', '`b`'],
      cannotRun: ['E2E'],
      exempt: {},
    });
    const both = app({ ciFixChecks: ['`a`'], reviewFixChecks: ['`make check`'] });
    expect(autofixSettings({ root: both }).reviewFixChecks).toEqual(['`make check`']);
  });
  it('takes exemptions with their reasons, and refuses one without', () => {
    expect(autofixSettings({ root: app({ exempt: { 'PR visuals': 'pictures' } }) }).exempt).toEqual(
      {
        'PR visuals': 'pictures',
      },
    );
    for (const exempt of [['PR visuals'], { 'PR visuals': ' ' }, null]) {
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
});
