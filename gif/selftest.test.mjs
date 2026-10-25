import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { selftest } from './selftest.mjs';

/**
 * An app with these files (its .github/ci.json among them, if given), and a
 * stand-in Playwright unless `playwright` is false.
 *
 * @param {Record<string, string>} files
 * @param {string | false} [playwright]
 */
function app(files, playwright = 'module.exports = { chromium: { launch() {} } };') {
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
      "gif: the app's Playwright resolves",
    ]);
  });

  it('passes an app whose CI records videos, with nothing to load', async () => {
    expect(
      await selftest(app({ '.github/ci.json': ciJson({ source: 'ci-videos' }) }, false), () => {}),
    ).toEqual([]);
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
      "the app's Playwright has no chromium.launch",
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
