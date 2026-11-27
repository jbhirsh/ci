import { describe, expect, it } from 'vitest';
import { mockupMayChange, settings } from './settings.ts';
import type { Settings } from './settings.ts';

const ok = { workflow: 'visual.yml', job: 'visual', folders: ['tests/visual/*-snapshots/'] };

describe('settings', () => {
  it('is null without the key', () => {
    expect(settings({})).toBeNull();
  });

  it('reads the settings and fills the defaults', () => {
    expect(settings(ok)).toEqual({
      workflow: 'visual.yml',
      job: 'visual',
      folders: ['tests/visual/*-snapshots'],
      ratio: 0,
      minor: 0.001,
      columns: [],
      mockupPaths: [],
    });
    const s = settings({
      ...ok,
      ratio: 0.01,
      columns: [{ label: 'Mobile', file: '{state}-mobile-linux.png' }],
      mockupPaths: ['src/**'],
    });
    expect(s?.columns).toEqual([{ label: 'Mobile', file: ['{state}-mobile-linux.png'] }]);
    expect(s?.ratio).toBe(0.01);
    expect(settings({ ...ok, minor: 0.05 })?.minor).toBe(0.05);
  });

  it('refuses what it can not use', () => {
    for (const [bad, why] of [
      [{ ...ok, extra: 1 }, /unknown key: extra/],
      [{ ...ok, workflow: 'CI' }, /workflow/],
      [{ ...ok, job: '' }, /job/],
      [{ ...ok, ratio: 1 }, /ratio/],
      [{ ...ok, minor: 2 }, /minor/],
      [{ ...ok, minor: 'x' }, /minor/],
      [{ ...ok, folders: [] }, /folders/],
      [{ ...ok, folders: ['../x'] }, /folders/],
      [{ ...ok, mockupPaths: ['/abs'] }, /mockupPaths/],
      [{ ...ok, columns: [] }, /visual-review\.columns/],
    ] as [Record<string, unknown>, RegExp][]) {
      expect(() => settings(bad)).toThrow(why);
    }
  });
});

describe('mockupMayChange', () => {
  it('takes only mockupPaths, and never a lockfile', () => {
    const s = settings({
      ...ok,
      mockupPaths: ['src/**', 'package-lock.json', 'web/**'],
    }) as Settings;
    expect(mockupMayChange('src/App.tsx', s)).toBe(true);
    expect(mockupMayChange('.github/workflows/ci.yml', s)).toBe(false);
    expect(mockupMayChange('package-lock.json', s)).toBe(false);
    expect(mockupMayChange('web/yarn.lock', s)).toBe(false);
  });
});
