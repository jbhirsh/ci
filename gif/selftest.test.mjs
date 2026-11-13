import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { selftest } from './selftest.mjs';

/**
 * An app with these files (its .github/ci.json among them, if given), and a
 * stand-in Playwright of release `version` unless `playwright` is false.
 *
 * @param {Record<string, string>} files
 * @param {string | false} [playwright]
 * @param {string} [version]
 */
function app(
  files,
  playwright = 'module.exports = { webkit: { launch() {} } };',
  version = '1.64.1',
) {
  const root = mkdtempSync(path.join(tmpdir(), 'gif-selftest-'));
  writeFileSync(path.join(root, 'package.json'), '{"type": "module"}');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  if (playwright !== false) {
    const dir = path.join(root, 'node_modules', '@playwright', 'test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'package.json'),
      '{"name": "@playwright/test", "main": "index.cjs"}',
    );
    writeFileSync(path.join(dir, 'index.cjs'), playwright);
    const core = path.join(root, 'node_modules', 'playwright-core');
    mkdirSync(core, { recursive: true });
    writeFileSync(
      path.join(core, 'package.json'),
      JSON.stringify({ name: 'playwright-core', version }),
    );
  }
  return root;
}

/** @param {Record<string, unknown>} gif */
const ciJson = (gif) => JSON.stringify({ gif });

describe('selftest', () => {
  it('checks an app with no gif settings against the defaults, and nothing more', async () => {
    const log = vi.fn();
    expect(await selftest(app({}, false), log)).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      'gif: no gif settings; the defaults parse, nothing more to check',
    );
  });

  it("passes a web app whose setup and scenarios load, passing over the scenarios' helpers", async () => {
    const log = vi.fn();
    const root = app({
      '.github/ci.json': ciJson({ setup: 'gif-setup.mjs', scenarios: 'scenarios' }),
      'gif-setup.mjs': 'export default { async beforeSetup() {} };',
      'scenarios/flow.mjs': 'export default { async play() {} };',
      'scenarios/helper.mjs': 'export const shared = 1;',
    });
    expect(await selftest(root, log)).toEqual([]);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'gif: settings parse (source web)',
      'gif: setup module gif-setup.mjs loads',
      `gif: ${path.join('scenarios', 'helper.mjs')} is a helper (no default export)`,
      'gif: 1 scenario(s) in scenarios load',
      "gif: the app's Playwright 1.64.1 resolves, with WebKit and page.screencast",
    ]);
  });

  it("names a Playwright from before page.screencast's frames", async () => {
    const root = app({ '.github/ci.json': ciJson({ fps: 10 }) }, undefined, '1.63.9');
    expect(await selftest(root, () => {})).toEqual([
      "the app's Playwright 1.63.9 predates page.screencast's frames: update it to 1.64 or later",
    ]);
    const newer = app({ '.github/ci.json': ciJson({ fps: 10 }) }, undefined, '2.0.0');
    expect(await selftest(newer, () => {})).toEqual([]);
  });

  it('passes an app whose CI records videos, with nothing to load', async () => {
    expect(
      await selftest(app({ '.github/ci.json': ciJson({ source: 'ci-videos' }) }, false), () => {}),
    ).toEqual([]);
  });

  it('checks that the scenarios folder of an app whose CI records videos holds a flow', async () => {
    const gif = { source: 'ci-videos', scenarios: 'e2e/gifs' };
    /** @type {string[]} */
    const logs = [];
    expect(
      await selftest(
        app(
          {
            '.github/ci.json': ciJson(gif),
            'e2e/gifs/swipe.yaml': 'appId: x',
            'e2e/gifs/shared/start.yaml': 'appId: x',
          },
          false,
        ),
        (line) => logs.push(line),
      ),
    ).toEqual([]);
    expect(logs).toContain('gif: 1 flow(s) in e2e/gifs');
    expect(await selftest(app({ '.github/ci.json': ciJson(gif) }, false), () => {})).toEqual([
      'gif.scenarios: no folder e2e/gifs',
    ]);
    expect(
      await selftest(
        app({ '.github/ci.json': ciJson(gif), 'e2e/gifs/notes.md': '' }, false),
        () => {},
      ),
    ).toEqual(['gif.scenarios: no flow in e2e/gifs']);
  });

  it('names every problem it finds', async () => {
    const root = app(
      {
        '.github/ci.json': ciJson({ setup: 'gif-setup.mjs', scenarios: 'scenarios' }),
        'gif-setup.mjs': 'export default { before() {} };',
        'scenarios/old.mjs': 'export default { async run() {} };',
        'scenarios/broken.mjs': 'throw new Error("cannot load");',
      },
      'module.exports = {};',
    );
    expect(await selftest(root, () => {})).toEqual([
      'gif-setup.mjs: unknown key "before"',
      expect.stringMatching(/^scenarios[\\/]broken\.mjs: cannot load$/),
      expect.stringMatching(/^scenarios[\\/]old\.mjs: unknown key "run"$/),
      expect.stringMatching(/^scenarios[\\/]old\.mjs: play\(page, gif\) is missing$/),
      "the app's Playwright has no webkit.launch",
    ]);
  });

  it('names a setup module or scenarios folder that is missing, settings it cannot read, and a Playwright that fails', async () => {
    const broken = 'throw new Error("no browser here");';
    expect(
      await selftest(
        app(
          {
            '.github/ci.json': ciJson({ setup: 'nope.mjs', scenarios: 'none' }),
            'node_modules/playwright/package.json': '{"name": "playwright", "main": "index.cjs"}',
            'node_modules/playwright/index.cjs': broken,
          },
          broken,
        ),
        () => {},
      ),
    ).toEqual([
      'nope.mjs: pr-gif: no such file: nope.mjs',
      'gif.scenarios: no folder none',
      'Playwright: no browser here',
    ]);
    expect(await selftest(app({ '.github/ci.json': ciJson({ fps: 0 }) }), () => {})).toEqual([
      'settings: gif.fps must be a number above 0',
    ]);
    expect(
      await selftest(
        app({ '.github/ci.json': ciJson({ scenarios: 'empty' }), 'empty/notes.md': '' }),
        () => {},
      ),
    ).toEqual(['gif.scenarios: no scenario in empty']);
  });
});
