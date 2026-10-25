import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Everything with a side effect is a stand-in: no builds, no browser, no
// ffmpeg, no git. What's left is the order cli.mjs does things in, and what
// it hands each part.
const calls = vi.hoisted(() => /** @type {string[]} */ ([]));
const fakes = vi.hoisted(() => ({
  /** @type {unknown} */
  playwright: undefined,
  /** @type {string | null} */
  playwrightFails: null,
}));

vi.mock('./build.mjs', () => ({
  addBaseTree: vi.fn((/** @type {string} */ _root, /** @type {string} */ ref) =>
    calls.push(`base ${ref}`),
  ),
  build: vi.fn((/** @type {{ cwd: string; mode?: string }} */ { mode }) =>
    calls.push(`build ${mode}`),
  ),
  git: vi.fn((/** @type {string} */ _root, /** @type {string[]} */ ...args) => {
    calls.push(`git ${args.join(' ')}`);
    if (args[0] === 'remote') return 'https://github.com/jbhirsh/BoardGames.git';
    if (args[0] === 'rev-parse') return 'abc1234';
    return '';
  }),
  serve: vi.fn(() => {
    calls.push('serve');
    return Promise.resolve(`http://127.0.0.1:${4000 + calls.length}`);
  }),
  stopServers: vi.fn(() => Promise.resolve()),
}));
vi.mock('./ffmpeg.mjs', async () => {
  const fs = await import('node:fs');
  const nodePath = await import('node:path');
  /** @param {string} out */
  const write = (out) => {
    fs.mkdirSync(nodePath.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'GIF89a');
  };
  return {
    checkFfmpeg: vi.fn((/** @type {boolean} */ labels) => calls.push(`ffmpeg ${labels}`)),
    framesToGif: vi.fn(
      (
        /** @type {string} */ dir,
        /** @type {string} */ out,
        /** @type {{ width: number }} */ { width },
      ) => {
        calls.push(`gif ${nodePath.basename(dir)} ${nodePath.basename(out)} ${width}`);
        write(out);
      },
    ),
    sideBySide: vi.fn(
      (
        /** @type {string} */ _b,
        /** @type {string} */ _a,
        /** @type {string} */ out,
        /** @type {{ width: number }} */ { width },
      ) => {
        calls.push(`side ${nodePath.basename(out)} ${width}`);
        write(out);
      },
    ),
  };
});
vi.mock('./record.mjs', () => ({
  showPointer: vi.fn(() => Promise.resolve(calls.push('pointer'))),
  waitForPictures: vi.fn(() => Promise.resolve(calls.push('pictures'))),
  recordFrames: vi.fn((/** @type {unknown} */ _page, /** @type {unknown} */ clip) => {
    calls.push(`record ${JSON.stringify(clip)}`);
    return Promise.resolve(() => {
      calls.push('stop');
      return Promise.resolve({ sent: 10, stills: 5, seconds: 1, rests: [] });
    });
  }),
}));
vi.mock('./publish.mjs', async (actual) => ({
  ...(await actual()),
  publishFiles: vi.fn(
    (
      /** @type {unknown} */ _git,
      /** @type {[string, string][]} */ files,
      /** @type {{ message: string; branch: string; push: boolean }} */ options,
    ) => {
      calls.push(
        `publish ${files.map(([file]) => file).join(',')} ${options.branch} ${options.push}`,
      );
      return 'f00d';
    },
  ),
}));
vi.mock('./videos.mjs', () => ({
  main: vi.fn((/** @type {string[]} */ argv) =>
    Promise.resolve(calls.push(`videos ${argv.join(' ')}`)),
  ),
}));
vi.mock('../lib/app.mjs', async (actual) => ({
  ...(await actual()),
  importFromApp: vi.fn((/** @type {string} */ name) => {
    if (name === 'vite') return Promise.reject(new Error('no vite'));
    if (name === '@playwright/test' && fakes.playwrightFails !== '@playwright/test') {
      return Promise.resolve({ default: fakes.playwright });
    }
    if (name === 'playwright') return Promise.resolve(fakes.playwright);
    return Promise.reject(new Error(`no ${name}`));
  }),
}));

const { appPlaywright, main } = await import('./cli.mjs');
const publish = await import('./publish.mjs');

/**
 * A browser whose pages note what's done with them.
 *
 * @param {{ width: number; height: number }} [viewport]
 */
function fakeBrowser(viewport = { width: 402, height: 874 }) {
  const page = {
    goto: vi.fn((/** @type {string} */ url) => Promise.resolve(calls.push(`goto ${url}`))),
    viewportSize: () => viewport,
  };
  const context = {
    newPage: vi.fn(() => Promise.resolve(page)),
    close: vi.fn(() => Promise.resolve(calls.push('context closed'))),
  };
  const browser = {
    newContext: vi.fn((/** @type {object} */ options) => {
      calls.push(`context ${JSON.stringify(options)}`);
      return Promise.resolve(context);
    }),
    close: vi.fn(() => Promise.resolve(calls.push('browser closed'))),
  };
  const launch = vi.fn((/** @type {object} */ options) => {
    calls.push(`launch ${JSON.stringify(options)}`);
    return Promise.resolve(browser);
  });
  return { browser, launch, page };
}

const SCENARIO = `
export default {
  name: 'flow',
  path: '/start',
  async setup(_page, gif) { globalThis.gifCalls.push('scenario setup ' + gif.side); },
  async ready(_page, gif) { globalThis.gifCalls.push('scenario ready ' + typeof gif.glide); },
  async play(_page, gif) { globalThis.gifCalls.push('play ' + gif.side + ' ' + gif.origin.slice(0, 16)); },
};
`;
const SETUP = `
export default {
  options: { fixtures: { type: 'boolean' } },
  async beforeSetup(_page, ctx) { globalThis.gifCalls.push('before setup ' + ctx.side + ' ' + ctx.options.fixtures); },
  async afterSetup(_page, ctx) { globalThis.gifCalls.push('after setup ' + ctx.side); },
  async check(_page, ctx) { globalThis.gifCalls.push('check ' + ctx.side); },
};
`;

/**
 * An app with a scenario, a setup module and the gif settings given.
 *
 * @param {Record<string, unknown>} gif
 * @param {Record<string, string>} [files]
 */
function app(gif, files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'gif-cli-'));
  mkdirSync(path.join(root, '.github'));
  writeFileSync(path.join(root, '.github', 'ci.json'), JSON.stringify({ gif }));
  writeFileSync(path.join(root, 'package.json'), '{"type": "module"}');
  for (const [file, text] of Object.entries({
    'flow.mjs': SCENARIO,
    'setup.mjs': SETUP,
    ...files,
  })) {
    writeFileSync(path.join(root, file), text);
  }
  process.env.APP_ROOT = root;
  return root;
}

/** @type {import('vitest').MockInstance} */
let log;
beforeEach(() => {
  calls.length = 0;
  Object.assign(globalThis, { gifCalls: calls });
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  fakes.playwrightFails = null;
});
afterEach(() => {
  delete process.env.APP_ROOT;
  vi.restoreAllMocks();
});

describe('main, for a web app', () => {
  it('builds both, records the scenario against each around the setup module, and publishes', async () => {
    const { launch } = fakeBrowser();
    fakes.playwright = { chromium: { launch } };
    const root = app({ setup: 'setup.mjs', build: { mode: 'test' }, cellWidth: 420 });
    await main(['flow.mjs', '--dir', '263', '--fixtures', '--chromium', '/opt/chrome'], {});
    const side = (/** @type {string} */ name) => [
      expect.stringMatching(
        /^context \{"viewport":\{"width":402,"height":874\},"deviceScaleFactor":1,"colorScheme":"light","reducedMotion":"no-preference","serviceWorkers":"block"\}$/,
      ),
      'pointer',
      `before setup ${name} true`,
      `scenario setup ${name}`,
      `after setup ${name}`,
      expect.stringMatching(/^goto http:\/\/127\.0\.0\.1:\d+\/start$/),
      'scenario ready function',
      'pictures',
      `check ${name}`,
      'record {"x":0,"y":0,"width":402,"height":874}',
      expect.stringMatching(new RegExp(`^play ${name} http://127.0.0.1`)),
      'stop',
      `check ${name}`,
      'context closed',
    ];
    expect(calls).toEqual([
      'ffmpeg false',
      'git remote get-url origin',
      'base origin/main',
      'build test',
      'build test',
      'launch {"executablePath":"/opt/chrome","handleSIGINT":false,"handleSIGTERM":false}',
      'serve',
      ...side('before'),
      'serve',
      ...side('after'),
      'gif frames-before flow-before.gif 402',
      'gif frames-after flow-after.gif 402',
      'git rev-parse --short HEAD',
      'publish 263/flow-before.gif,263/flow-after.gif screenshots true',
      'browser closed',
      expect.stringMatching(/^git worktree remove --force .*base$/),
    ]);
    const printed = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(printed).toContain(
      `pr-gif: ${path.join(root, 'pr-gif', 'flow', 'flow-before.gif')} is 0 KB`,
    );
    expect(printed).toContain(
      publish.markdownTable(
        'jbhirsh/BoardGames',
        'f00d',
        [
          {
            name: 'flow',
            before: '263/flow-before.gif',
            after: '263/flow-after.gif',
            sideBySide: null,
          },
        ],
        { width: 420, base: 'main' },
      ),
    );
    const [, , options] = /** @type {[unknown, unknown, { message: string }]} */ (
      vi.mocked(publish.publishFiles).mock.calls[0]
    );
    expect(options.message).toMatch(
      /^Add the flow GIFs for 263\n\nRecorded from local builds of origin\/main and abc1234/,
    );
  });

  it('records only "after" for new UI, writing locally without --dir', async () => {
    const { launch } = fakeBrowser();
    fakes.playwright = { chromium: { launch } };
    app({});
    await main(['flow.mjs', '--after-only', '--width', '300', '--keep'], {});
    expect(calls).not.toContain('base origin/main');
    expect(calls.filter((c) => c.startsWith('build'))).toEqual(['build undefined']);
    expect(calls).toContain('gif frames-after flow-after.gif 300');
    expect(calls.some((c) => c.startsWith('publish'))).toBe(false);
    expect(calls.some((c) => c.startsWith('git remote'))).toBe(false);
    expect(log.mock.calls.map(([line]) => String(line))).toContainEqual(
      expect.stringMatching(/^pr-gif: kept /),
    );
  });

  it("joins the two side by side, at twice the window's width, a scenario's own window and clip", async () => {
    const { launch } = fakeBrowser({ width: 1100, height: 640 });
    fakes.playwright = { chromium: { launch } };
    app(
      { scale: 2 },
      {
        'wide.mjs': `export default {
          viewport: { width: 1100, height: 640 },
          colorScheme: 'dark',
          clip: async (page) => ({ x: 0, y: 80, width: page.viewportSize().width, height: 100 }),
          async play() {},
        };`,
      },
    );
    await main(['wide.mjs', '--side-by-side', '--dir', '9', '--no-push'], {});
    expect(calls).toContain('ffmpeg true');
    expect(calls).toContain('side wide-side-by-side.gif 1000');
    expect(calls).toContain('record {"x":0,"y":80,"width":1100,"height":100}');
    expect(calls.find((c) => c.startsWith('context {'))).toContain(
      '"deviceScaleFactor":2,"colorScheme":"dark"',
    );
    expect(calls).toContain('publish 9/wide-side-by-side.gif screenshots false');
  });

  it('refuses a scenario or setup module of the wrong shape, before building anything', async () => {
    app(
      { setup: 'setup.mjs' },
      {
        'old.mjs': 'export default { async run() {} };',
        'bad.mjs': 'export default { before() {} };',
      },
    );
    await expect(main(['old.mjs'], {})).rejects.toThrow(
      'pr-gif: old.mjs: unknown key "run"; play(page, gif) is missing',
    );
    app({ setup: 'bad.mjs' }, { 'bad.mjs': 'export default { before() {} };' });
    await expect(main(['flow.mjs'], {})).rejects.toThrow('pr-gif: bad.mjs: unknown key "before"');
    expect(calls.some((c) => c.startsWith('build'))).toBe(false);
  });

  it('cleans up after a failure, and passes it on', async () => {
    const launch = vi.fn(() => Promise.reject(new Error('no browser')));
    fakes.playwright = { chromium: { launch } };
    app({});
    await expect(main(['flow.mjs'], {})).rejects.toThrow('no browser');
    expect(calls.at(-1)).toMatch(/^git worktree remove --force /);
  });
});

describe('main, for an app whose CI records videos', () => {
  it('hands over to videos.mjs', async () => {
    app({ source: 'ci-videos' });
    await main(['189', '--side-by-side'], {});
    expect(calls).toEqual(['videos 189 --side-by-side']);
  });
});

describe('appPlaywright', () => {
  it("takes Playwright Test's exports from its CommonJS default, or else playwright's own", async () => {
    const { launch } = fakeBrowser();
    const test = Object.assign(() => {}, { chromium: { launch } });
    fakes.playwright = test;
    expect((await appPlaywright('/app')).chromium.launch).toBe(launch);
    fakes.playwrightFails = '@playwright/test';
    fakes.playwright = { chromium: { launch } };
    expect((await appPlaywright('/app')).chromium.launch).toBe(launch);
  });
});
