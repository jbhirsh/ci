import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { USAGE, defaultWidth, parseOptions, scenarioName } from './options.mjs';
import { parseSettings } from './settings.mjs';

const settings = parseSettings({});

describe('parseOptions', () => {
  it('takes a scenario, with the defaults from the settings', () => {
    expect(parseOptions(['scripts/gif-scenarios/example.ts'], { settings })).toEqual({
      scenario: 'scripts/gif-scenarios/example.ts',
      dir: undefined,
      push: true,
      base: 'origin/main',
      afterOnly: false,
      sideBySide: false,
      width: undefined,
      fps: 15,
      scale: 1,
      mode: undefined,
      chromium: undefined,
      branch: 'screenshots',
      repo: undefined,
      keep: false,
      app: {},
    });
    const fog = parseSettings({ scale: 2, fps: 20, branch: 'pics', build: { mode: 'test' } });
    expect(parseOptions(['a.ts'], { settings: fog })).toMatchObject({
      scale: 2,
      fps: 20,
      branch: 'pics',
      mode: 'test',
    });
  });

  it('takes every option, in any order, over the settings', () => {
    expect(
      parseOptions(
        [
          '--side-by-side',
          '--dir',
          '263',
          '--no-push',
          '--base',
          'origin/release',
          '--width',
          '900',
          '--fps',
          '20',
          '--scale',
          '1.5',
          '--mode',
          'production',
          '--chromium',
          '/opt/chrome',
          '--branch',
          'pics',
          '--repo',
          'jbhirsh/fog-and-frontier',
          '--keep',
          'flow.ts',
        ],
        { settings },
      ),
    ).toEqual({
      scenario: 'flow.ts',
      dir: '263',
      push: false,
      base: 'origin/release',
      afterOnly: false,
      sideBySide: true,
      width: 900,
      fps: 20,
      scale: 1.5,
      mode: 'production',
      chromium: '/opt/chrome',
      branch: 'pics',
      repo: 'jbhirsh/fog-and-frontier',
      keep: true,
      app: {},
    });
    expect(parseOptions(['a.ts', '--after-only'], { settings }).afterOnly).toBe(true);
  });

  it('takes a Chromium from PR_GIF_CHROMIUM or PLAYWRIGHT_CHROMIUM_EXECUTABLE, which --chromium overrides', () => {
    expect(
      parseOptions(['a.ts'], { settings, env: { PR_GIF_CHROMIUM: '/env/chrome' } }).chromium,
    ).toBe('/env/chrome');
    expect(
      parseOptions(['a.ts'], { settings, env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE: '/pw/chrome' } })
        .chromium,
    ).toBe('/pw/chrome');
    expect(
      parseOptions(['a.ts'], { settings, env: { PR_GIF_CHROMIUM: '' } }).chromium,
    ).toBeUndefined();
    expect(
      parseOptions(['a.ts', '--chromium', '/flag/chrome'], {
        settings,
        env: { PR_GIF_CHROMIUM: '/env/chrome' },
      }).chromium,
    ).toBe('/flag/chrome');
  });

  it("takes the setup module's own options, with their defaults", () => {
    const appOptions = /** @type {const} */ ({
      fixtures: { type: 'boolean' },
      production: { type: 'string', default: 'https://x.app' },
    });
    expect(parseOptions(['a.ts', '--fixtures'], { settings, appOptions }).app).toEqual({
      fixtures: true,
      production: 'https://x.app',
    });
    expect(
      parseOptions(['a.ts', '--production', 'https://y.app'], { settings, appOptions }).app,
    ).toEqual({
      fixtures: undefined,
      production: 'https://y.app',
    });
    expect(() =>
      parseOptions(['a.ts'], { settings, appOptions: { dir: { type: 'string' } } }),
    ).toThrow("the setup module's --dir clashes with the recorder's own");
  });

  it.each([
    [[], 'one scenario, please'],
    [['a.ts', 'b.ts'], 'one scenario, please'],
    [['a.ts', '--colour'], "Unknown option '--colour'"],
    [['a.ts', '--fps', '0'], '--fps takes a number above 0'],
    [['a.ts', '--width', 'wide'], '--width takes a number above 0'],
    [['a.ts', '--scale', 'none'], '--scale takes a number above 0'],
    [['a.ts', '--side-by-side', '--after-only'], '--side-by-side needs a before'],
    [['a.ts', '--dir', '../up'], '--dir is one folder name'],
    [['a.ts', '--dir', 'a/b'], '--dir is one folder name'],
    [['a.ts', '--dir', '..'], '--dir is one folder name'],
    [['a.ts', '--dir', '.'], '--dir is one folder name'],
    [['a.ts', '--repo', 'just-a-name'], '--repo must be owner/name'],
    [['a.ts', '--no-push'], '--no-push is for publishing: give --dir too'],
  ])('refuses %j, saying why', (argv, why) => {
    expect(() => parseOptions(argv, { settings })).toThrow(why);
  });

  it('says how to call it when the command line itself is wrong', () => {
    expect(() => parseOptions([], { settings })).toThrow(USAGE);
    expect(() => parseOptions(['a.ts', '--colour'], { settings })).toThrow(USAGE);
    expect(parseOptions(['a.ts', '--dir', 'v1.2'], { settings }).dir).toBe('v1.2');
  });

  it('never accepts a --dir that leaves its folder', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (dir) => {
        try {
          const parsed = parseOptions(['a.ts', '--dir', dir], { settings }).dir ?? '';
          expect(parsed).toMatch(/^[\w.-]+$/);
          expect(parsed).not.toMatch(/^\.+$/);
        } catch (error) {
          expect(String(error)).toMatch(/--dir|Option|argument/);
        }
      }),
    );
  });
});

describe('defaultWidth', () => {
  it("keeps a phone's frames at their size, and caps a wide window", () => {
    expect(defaultWidth(390, false)).toBe(390);
    expect(defaultWidth(900, false)).toBe(700);
  });

  it('puts two of them side by side, 8px apart, each in even pixels', () => {
    expect(defaultWidth(390, true)).toBe(788);
    expect(defaultWidth(375, true)).toBe(756);
    expect(defaultWidth(900, true)).toBe(1000);
  });
});

describe('scenarioName', () => {
  it("is the scenario's own name, or its file's", () => {
    expect(scenarioName('scripts/gif-scenarios/open-activity.ts', undefined)).toBe('open-activity');
    expect(scenarioName('flow.mjs', 'review-count')).toBe('review-count');
    expect(scenarioName('a\\b\\c.ts', 3)).toBe('c');
  });
});
