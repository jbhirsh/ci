import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PHONE, VIDEO_DEFAULTS, loadSettings, parseSettings } from './settings.mjs';

describe('parseSettings', () => {
  it("fills in every default: a phone's window, served on 127.0.0.1, published to screenshots", () => {
    expect(parseSettings({})).toEqual({
      source: 'web',
      setup: undefined,
      scenarios: undefined,
      viewport: PHONE,
      scale: 1,
      host: '127.0.0.1',
      build: { mode: undefined, env: {}, unsetEnv: [] },
      fps: 15,
      branch: 'screenshots',
      cellWidth: 400,
      videos: VIDEO_DEFAULTS,
    });
    expect(PHONE).toEqual({ width: 402, height: 874 });
  });

  it('takes every setting an app gives', () => {
    expect(
      parseSettings({
        source: 'web',
        setup: 'scripts/gif-setup.ts',
        scenarios: 'scripts/gif-scenarios',
        viewport: { width: 1100, height: 640 },
        scale: 2,
        host: 'localhost',
        build: { mode: 'test', env: { VERCEL_ENV: 'production' }, unsetEnv: ['SENTRY_AUTH_TOKEN'] },
        fps: 25,
        branch: 'pics',
        cellWidth: 420,
      }),
    ).toMatchObject({
      setup: 'scripts/gif-setup.ts',
      scenarios: 'scripts/gif-scenarios',
      viewport: { width: 1100, height: 640 },
      scale: 2,
      host: 'localhost',
      build: { mode: 'test', env: { VERCEL_ENV: 'production' }, unsetEnv: ['SENTRY_AUTH_TOKEN'] },
      fps: 25,
      branch: 'pics',
      cellWidth: 420,
    });
    expect(
      parseSettings({
        source: 'ci-videos',
        videos: {
          workflow: 'e2e.yml',
          artifact: 'videos',
          inputs: { only_gifs: 'yes' },
          scenariosInput: 'from',
          ringColor: '#00ff00',
          width: 300,
          fps: 10,
        },
      }).videos,
    ).toEqual({
      workflow: 'e2e.yml',
      artifact: 'videos',
      inputs: { only_gifs: 'yes' },
      scenariosInput: 'from',
      ringColor: '#00ff00',
      width: 300,
      fps: 10,
    });
  });

  it.each([
    [{ sorce: 'web' }, 'gif: unknown setting sorce'],
    [{ source: 'ios' }, 'gif.source must be "web" or "ci-videos"'],
    [{ setup: '/etc/passwd' }, 'gif.setup must be a path inside the app'],
    [{ scenarios: '../other' }, 'gif.scenarios must be a path inside the app'],
    [{ setup: 3 }, 'gif.setup must be a string'],
    [{ viewport: [402, 874] }, 'gif.viewport must be { width, height }'],
    [{ viewport: { width: 402 } }, 'gif.viewport.height must be a number above 0'],
    [{ scale: 0 }, 'gif.scale must be a number above 0'],
    [{ host: 'local host' }, 'gif.host must be a string'],
    [{ build: 'test' }, 'gif.build must be { mode, env, unsetEnv }'],
    [{ build: { unsetEnv: 'A' } }, 'gif.build.unsetEnv must be a list of names'],
    [{ build: { env: { A: 1 } } }, 'gif.build.env must map names to strings'],
    [{ videos: [] }, 'gif.videos must be an object'],
    [{ videos: { ringColor: 'red' } }, 'gif.videos.ringColor must be a string'],
    [{ videos: { workflow: 'ci' } }, 'gif.videos.workflow must be a string'],
  ])('refuses %j', (raw, why) => {
    expect(() => parseSettings(raw)).toThrow(why);
  });

  it('never throws anything but its own errors, for any value of any setting', () => {
    const keys = [
      'source',
      'setup',
      'scenarios',
      'viewport',
      'scale',
      'host',
      'build',
      'fps',
      'branch',
      'cellWidth',
      'videos',
    ];
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom(...keys), fc.anything()), (raw) => {
        try {
          parseSettings(raw);
        } catch (error) {
          expect(String(error)).toMatch(/^Error: gif[.:]/);
        }
      }),
    );
  });
});

describe('loadSettings', () => {
  it("reads the app's gif key, or the defaults when it has none", () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gif-settings-'));
    expect(loadSettings(root).source).toBe('web');
    mkdirSync(path.join(root, '.github'));
    writeFileSync(
      path.join(root, '.github', 'ci.json'),
      '{"gif": {"source": "ci-videos"}, "mutation": {}}',
    );
    expect(loadSettings(root).source).toBe('ci-videos');
  });
});
