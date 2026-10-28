import { describe, expect, it } from 'vitest';
import { isShotName, settings, singleFolder } from './settings.mjs';

describe('settings', () => {
  it('fills in the defaults and trims trailing slashes', () => {
    expect(settings({ folders: ['e2e/*-snapshots/'], command: 'npm run x' })).toEqual({
      folders: ['e2e/*-snapshots'],
      command: 'npm run x',
      artifact: undefined,
      ratio: 0,
    });
  });

  it('reads an artifact and a ratio', () => {
    const s = settings({
      folders: ['e2e/screenshots/baselines'],
      artifact: { workflow: 'ci.yml', name: 'ios-screenshots' },
      ratio: 0.001,
    });
    expect(s.artifact).toEqual({ workflow: 'ci.yml', name: 'ios-screenshots' });
    expect(s.ratio).toBe(0.001);
  });

  it.each([
    [{}],
    [{ folders: [] }],
    [{ folders: 'e2e' }],
    [{ folders: [''] }],
    [{ folders: ['/abs'] }],
    [{ folders: ['../out'] }],
    [{ folders: [3] }],
  ])('refuses folders %j', (config) => {
    expect(() => settings(config)).toThrow(/folders must list/);
  });

  it.each([-0.1, 1, '0.1', Number.NaN])('refuses a ratio of %j', (ratio) => {
    expect(() => settings({ folders: ['a'], ratio })).toThrow(/ratio must be a share/);
  });

  it('refuses a command that is not text', () => {
    expect(() => settings({ folders: ['a'], command: ' ' })).toThrow(/command must be text/);
    expect(() => settings({ folders: ['a'], command: 1 })).toThrow(/command must be text/);
  });

  it('wants the workflow by its file name', () => {
    expect(() =>
      settings({ folders: ['a'], artifact: { workflow: 'CI', name: 'ios-screenshots' } }),
    ).toThrow(/file name \(ci.yml\)/);
  });

  it('refuses an incomplete artifact', () => {
    expect(() => settings({ folders: ['a'], artifact: { workflow: 'ci.yml' } })).toThrow(
      /needs a workflow and a name/,
    );
    expect(() => settings({ folders: ['a'], artifact: null })).toThrow(/needs a workflow/);
    expect(() => settings({ folders: ['a'], artifact: { workflow: 2, name: 'x' } })).toThrow(
      /artifact.workflow must be text/,
    );
  });
});

describe('singleFolder', () => {
  it('returns the one literal folder', () => {
    expect(singleFolder(settings({ folders: ['e2e/screenshots/baselines'] }))).toBe(
      'e2e/screenshots/baselines',
    );
  });

  it.each([[['a', 'b']], [['e2e/*-snapshots']], [['a/{b,c}']], [['a/b?']]])(
    'refuses %j',
    (folders) => {
      expect(() => singleFolder(settings({ folders }))).toThrow(/exactly one folder/);
    },
  );
});

describe('isShotName', () => {
  it('takes a bare PNG name only', () => {
    expect(isShotName('light-01-setup.png')).toBe(true);
    expect(isShotName('../x.png')).toBe(false);
    expect(isShotName('a/b.png')).toBe(false);
  });
});
