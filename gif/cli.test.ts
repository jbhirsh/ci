import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

// Everything with a side effect is a stand-in: no builds, no browser, no
// ffmpeg, no git. What's left is the order cli.ts does things in, and what
// it hands each part.
const calls = vi.hoisted(() => [] as string[]);
const fakes = vi.hoisted(() => ({
  playwright: undefined as unknown,
}));

vi.mock('./build.ts', () => ({
  addBaseTree: vi.fn((_root: string, ref: string) => calls.push(`base ${ref}`)),
  build: vi.fn(({ mode }: { cwd: string; mode?: string }) => calls.push(`build ${mode}`)),
  git: vi.fn((_root: string, ...args: string[]) => {
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
vi.mock('./ffmpeg.ts', async () => {
  const fs = await import('node:fs');
  const nodePath = await import('node:path');
  const write = (out: string) => {
    fs.mkdirSync(nodePath.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'GIF89a');
  };
  return {
    checkFfmpeg: vi.fn((labels: boolean) => calls.push(`ffmpeg ${labels}`)),
    framesToGif: vi.fn((dir: string, out: string, { width }: { width: number }) => {
      calls.push(`gif ${nodePath.basename(dir)} ${nodePath.basename(out)} ${width}`);
      write(out);
    }),
    sideBySide: vi.fn((_b: string, _a: string, out: string, { width }: { width: number }) => {
      calls.push(`side ${nodePath.basename(out)} ${width}`);
      write(out);
    }),
  };
});
vi.mock('./record.ts', () => ({
  showPointer: vi.fn(() => Promise.resolve(calls.push('pointer'))),
  waitForPictures: vi.fn(() => Promise.resolve(calls.push('pictures'))),
  recordFrames: vi.fn((_page: unknown, clip: unknown) => {
    calls.push(`record ${JSON.stringify(clip)}`);
    return Promise.resolve(() => {
      calls.push('stop');
      return Promise.resolve({ sent: 10, stills: 5, seconds: 1, rests: [] });
    });
  }),
}));
vi.mock('./publish.ts', async (actual) => ({
  ...(await actual()),
  publishFiles: vi.fn(
    (
      _git: unknown,
      files: [string, string][],
      options: { message: string; branch: string; push: boolean },
    ) => {
      calls.push(
        `publish ${files.map(([file]) => file).join(',')} ${options.branch} ${options.push}`,
      );
      return 'f00d';
    },
  ),
}));
vi.mock('./videos.ts', () => ({
  main: vi.fn((argv: string[]) => Promise.resolve(calls.push(`videos ${argv.join(' ')}`))),
}));
vi.mock('../lib/app.ts', async (actual) => ({
  ...(await actual()),
  importFromApp: vi.fn((name: string) => Promise.reject(new Error(`no ${name}`))),
  appPlaywright: vi.fn(() => Promise.resolve(fakes.playwright)),
}));

const { main } = await import('./cli.ts');
const publish = await import('./publish.ts');

/**
 * A browser whose pages note what's done with them.
 */
function fakeBrowser(viewport: { width: number; height: number } = { width: 402, height: 874 }) {
  const page = {
    goto: vi.fn((url: string) => Promise.resolve(calls.push(`goto ${url}`))),
    viewportSize: () => viewport,
  };
  const context = {
    newPage: vi.fn(() => Promise.resolve(page)),
    close: vi.fn(() => Promise.resolve(calls.push('context closed'))),
  };
  const browser = {
    newContext: vi.fn((options: object) => {
      calls.push(`context ${JSON.stringify(options)}`);
      return Promise.resolve(context);
    }),
    close: vi.fn(() => Promise.resolve(calls.push('browser closed'))),
  };
  const launch = vi.fn((options: object) => {
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
 */
function app(gif: Record<string, unknown>, files: Record<string, string> = {}) {
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

let log: MockInstance;
beforeEach(() => {
  calls.length = 0;
  Object.assign(globalThis, { gifCalls: calls });
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.APP_ROOT;
  vi.restoreAllMocks();
});

describe('main, for a web app', () => {
  it('builds both, records the scenario against each around the setup module, and publishes', async () => {
    const { launch } = fakeBrowser();
    fakes.playwright = { webkit: { launch } };
    const root = app({ setup: 'setup.mjs', build: { mode: 'test' }, cellWidth: 420 });
    await main(['flow.mjs', '--dir', '263', '--fixtures']);
    const side = (name: string) => [
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
      'launch {"handleSIGINT":false,"handleSIGTERM":false}',
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
    const [, , options] = vi.mocked(publish.publishFiles).mock.calls[0] as [
      unknown,
      unknown,
      { message: string },
    ];
    expect(options.message).toMatch(
      /^Add the flow GIFs for 263\n\nRecorded from local builds of origin\/main and abc1234/,
    );
  });

  it('records only "after" for new UI, writing locally without --dir', async () => {
    const { launch } = fakeBrowser();
    fakes.playwright = { webkit: { launch } };
    app({});
    await main(['flow.mjs', '--after-only', '--width', '300', '--keep']);
    expect(calls).not.toContain('base origin/main');
    expect(calls.filter((c) => c.startsWith('build'))).toEqual(['build undefined']);
    expect(calls).toContain('gif frames-after flow-after.gif 300');
    expect(calls.some((c) => c.startsWith('publish'))).toBe(false);
    expect(calls.some((c) => c.startsWith('git remote'))).toBe(false);
    expect(log.mock.calls.map(([line]) => String(line))).toContainEqual(
      expect.stringMatching(/^pr-gif: kept /),
    );
  });

  it('goes on with "after" alone when "before" fails and may, and only then', async () => {
    const { launch } = fakeBrowser();
    fakes.playwright = { webkit: { launch } };
    app({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const build = await import('./build.ts');
    vi.mocked(build.build).mockImplementationOnce(() => {
      throw new Error('main has no such screen');
    });
    await main(['flow.mjs', '--before-may-fail']);
    expect(calls).toContain('gif frames-after flow-after.gif 402');
    expect(calls.some((c) => c.includes('flow-before.gif'))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"before" failed (main has no such'));

    // Played, not built: the scenario stops on main's app.
    calls.length = 0;
    const record = await import('./record.ts');
    vi.mocked(record.recordFrames).mockImplementationOnce(() =>
      Promise.reject(new Error('no button')),
    );
    await main(['flow.mjs', '--before-may-fail']);
    expect(calls.filter((c) => c.startsWith('gif '))).toEqual([
      'gif frames-after flow-after.gif 402',
    ]);

    calls.length = 0;
    vi.mocked(record.recordFrames).mockImplementationOnce(() =>
      Promise.reject(new Error('no button')),
    );
    await expect(main(['flow.mjs'])).rejects.toThrow('no button');
  });

  it("joins the two side by side, at twice the window's width, a scenario's own window and clip", async () => {
    const { launch } = fakeBrowser({ width: 1100, height: 640 });
    fakes.playwright = { webkit: { launch } };
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
    await main(['wide.mjs', '--side-by-side', '--dir', '9', '--no-push']);
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
    await expect(main(['old.mjs'])).rejects.toThrow(
      'pr-gif: old.mjs: unknown key "run"; play(page, gif) is missing',
    );
    app({ setup: 'bad.mjs' }, { 'bad.mjs': 'export default { before() {} };' });
    await expect(main(['flow.mjs'])).rejects.toThrow('pr-gif: bad.mjs: unknown key "before"');
    expect(calls.some((c) => c.startsWith('build'))).toBe(false);
  });

  it('cleans up after a failure, and passes it on, saying how to install WebKit', async () => {
    const launch = vi.fn(() => Promise.reject(new Error('no browser')));
    fakes.playwright = { webkit: { launch } };
    app({});
    await expect(main(['flow.mjs'])).rejects.toMatchObject({
      message: expect.stringContaining('npx playwright install --with-deps webkit'),
      cause: new Error('no browser'),
    });
    expect(calls.at(-1)).toMatch(/^git worktree remove --force /);
  });
});

describe('main, for an app whose CI records videos', () => {
  it('hands over to videos.ts', async () => {
    app({ source: 'ci-videos' });
    await main(['189', '--side-by-side']);
    expect(calls).toEqual(['videos 189 --side-by-side']);
  });
});
