import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// gh, git, unzip, ffprobe, ffmpeg and curl are stand-ins answering from
// `world`; what's checked is what videos.mjs asks of them, and makes.
const world = vi.hoisted(() => ({
  /** @type {string[][]} */
  asked: [],
  /** @type {Record<string, unknown>} */
  api: {},
  /** @type {string | null} */
  dispatchError: null,
  /** @type {Record<string, string[]>} sides' video names, by artifact id */
  videos: {},
  /** @type {Buffer[]} the decoded frames each video streams */
  frames: [],
  decodeCode: 0,
  drawtext: true,
  curl: '200',
  /** @type {Set<string>} ffmpeg outputs that fail */
  failing: new Set(),
}));

/**
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ status: number; stdout: string | Buffer; stderr: string }}
 */
function answer(cmd, args) {
  world.asked.push([cmd, ...args]);
  const ok = (/** @type {string | Buffer} */ stdout, stderr = '') => ({
    status: 0,
    stdout,
    stderr,
  });
  if (cmd === 'git') return ok('https://github.com/jbhirsh/sift.git\n');
  if (cmd === 'gh') {
    const endpoint = args.find((a) => a.startsWith('repos/')) ?? '';
    if (args.includes('POST')) {
      if (world.dispatchError && args.includes('return_run_details=true')) {
        return { status: 1, stdout: '', stderr: world.dispatchError };
      }
      return ok(
        args.includes('return_run_details=true') ? JSON.stringify({ workflow_run_id: 12 }) : '',
      );
    }
    const zip = /actions\/artifacts\/(\d+)\/zip$/.exec(endpoint);
    if (zip) return ok(Buffer.from(`zip ${zip[1]}`));
    const key = Object.keys(world.api).find((k) => endpoint.startsWith(k));
    if (!key) return { status: 1, stdout: '', stderr: `no answer for ${endpoint}` };
    const value = world.api[key];
    const next =
      Array.isArray(value) && value.length > 1
        ? value.shift()
        : Array.isArray(value)
          ? value[0]
          : value;
    return ok(JSON.stringify(next));
  }
  if (cmd === 'unzip') {
    const into = args[args.indexOf('-d') + 1];
    const id = String(args[2]).includes('zip') ? '' : '';
    for (const name of world.videos[path.basename(into).split('-')[0]] ?? []) {
      const file = path.join(into, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `video ${id}`);
    }
    return ok('');
  }
  if (cmd === 'ffprobe') {
    if (args.includes('stream=width,height')) return ok('60,60\n');
    if (args.includes('frame=pts_time')) return ok(world.frames.map((_, i) => `${i},`).join('\n'));
    return ok('10\n');
  }
  if (cmd === 'ffmpeg') {
    if (args.includes('-filters')) return ok(world.drawtext ? ' T.C drawtext  V->V\n' : '');
    if (args.some((a) => a.includes('showinfo'))) {
      return ok(
        '',
        [
          '[Parsed_showinfo_1 @ 0] n:0 pts:0 pts_time:0',
          '[Parsed_showinfo_1 @ 0] n:1 pts:1 pts_time:2',
          '[Parsed_showinfo_1 @ 0] n:2 pts:2 pts_time:4',
        ].join('\n'),
      );
    }
    const out = args.at(-1) ?? '';
    if ([...world.failing].some((f) => out.endsWith(f)))
      return { status: 1, stdout: '', stderr: 'broken' };
    writeFileSync(out, 'GIF89a');
    return ok('');
  }
  if (cmd === 'curl') return ok(world.curl);
  return { status: 127, stdout: '', stderr: `no ${cmd}` };
}

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn((/** @type {string} */ cmd, /** @type {string[]} */ args) => answer(cmd, args)),
  spawn: vi.fn((/** @type {string} */ cmd, /** @type {string[]} */ args) => {
    world.asked.push([cmd, ...args]);
    const child = Object.assign(new EventEmitter(), { stdout: Readable.from(world.frames) });
    child.stdout.on('end', () => setImmediate(() => child.emit('close', world.decodeCode)));
    return child;
  }),
}));
vi.mock('./publish.mjs', async (actual) => ({
  ...(await actual()),
  publishFiles: vi.fn((/** @type {unknown} */ _git, /** @type {[string, string][]} */ files) => {
    world.asked.push(['publish', ...files.map(([file]) => file)]);
    return 'cafe';
  }),
}));

const videos = await import('./videos.mjs');
const { parseSettings } = await import('./settings.mjs');
const { publishFiles } = await import('./publish.mjs');
const { main, parseVideoArgs, timing } = videos;

const settings = parseSettings({ source: 'ci-videos', cellWidth: 260 });
// A frame of the decoder's 20 x 20 output: blank, or with the ring in it.
const blank = () => Buffer.alloc(20 * 20 * 3, 255);
const ringed = () => Buffer.from(Array.from({ length: 20 * 20 }, () => [0xe1, 0x1d, 0x48]).flat());

/** @type {import('vitest').MockInstance} */
let stdout;
/** @type {import('vitest').MockInstance} */
let stderr;
beforeEach(() => {
  Object.assign(timing, { pollMs: 1, waitLimitMs: 1000, startLimitMs: 1000 });
  world.asked = [];
  world.dispatchError = null;
  world.decodeCode = 0;
  world.drawtext = true;
  world.curl = '200';
  world.failing = new Set();
  world.frames = [blank(), ringed(), blank()];
  world.videos = {
    after: ['swipe.mp4', 'new-sheet.mp4'],
    before: ['swipe.mp4', 'failed/broken.mp4'],
  };
  world.api = {
    'repos/jbhirsh/sift/pulls/7': { head: { sha: 'a'.repeat(40) } },
    'repos/jbhirsh/sift/actions/workflows/ci.yml/runs?head_sha': [
      { workflow_runs: [] },
      { workflow_runs: [{ id: 11 }] },
    ],
    'repos/jbhirsh/sift/actions/workflows/ci.yml/runs?event=workflow_dispatch': {
      workflow_runs: [{ id: 5 }],
    },
    'repos/jbhirsh/sift/actions/runs/11/artifacts': {
      artifacts: [{ id: 101, name: 'ios-gif-videos' }],
    },
    'repos/jbhirsh/sift/actions/runs/12/artifacts': {
      artifacts: [{ id: 102, name: 'ios-gif-videos' }],
    },
    'repos/jbhirsh/sift/actions/runs/11': [
      { id: 11, status: 'in_progress' },
      { id: 11, status: 'completed', conclusion: 'success' },
    ],
    'repos/jbhirsh/sift/actions/runs/12': { id: 12, status: 'completed', conclusion: 'failure' },
  };
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

const logged = () => stderr.mock.calls.map(([line]) => String(line)).join('');
/** @param {string} cmd */
const asked = (cmd) => world.asked.filter(([c]) => c === cmd);

describe('parseVideoArgs', () => {
  const defaults = { width: 360, fps: 15 };

  it('takes the PR number, with the width and frame rate from the settings', () => {
    expect(parseVideoArgs(['189'], defaults)).toEqual({
      pr: 189,
      repo: undefined,
      sideBySide: false,
      width: 360,
      fps: 15,
      noBefore: false,
    });
  });

  it('takes each option, in any order', () => {
    expect(
      parseVideoArgs(
        ['--side-by-side', '--width', '300', '42', '--fps', '12', '--repo', 'a-b/c.d'],
        defaults,
      ),
    ).toEqual({ pr: 42, repo: 'a-b/c.d', sideBySide: true, width: 300, fps: 12, noBefore: false });
    expect(parseVideoArgs(['7', '--no-before'], defaults).noBefore).toBe(true);
  });

  it.each([
    [[], 'Give the PR number'],
    [['1', '2'], 'Unknown argument: 2'],
    [['1', '--wat'], 'Unknown argument: --wat'],
    [['1', '--width'], '--width needs a whole number above 0'],
    [['1', '--fps', '0'], '--fps needs a whole number above 0'],
    [['1', '--width', '2.5'], '--width'],
    [['1', '--repo', 'no slash'], '--repo needs owner/name'],
    [['1', '--repo', 'a/b; rm -rf /'], '--repo needs owner/name'],
    [['1', '--side-by-side', '--no-before'], '--side-by-side needs a before'],
  ])('turns away %j', (argv, why) => {
    expect(() => parseVideoArgs(argv, defaults)).toThrow(why);
  });
});

describe('main', () => {
  it("records main's run for before, cuts each video's waits, makes the GIFs, publishes, prints the table", async () => {
    await main(['7', '--side-by-side'], { root: '/app', settings });
    // The run by hand on main: the settings' inputs and the PR's head.
    const dispatch = asked('gh').find((a) => a.includes('POST')) ?? [];
    expect(dispatch).toEqual(
      expect.arrayContaining([
        'inputs[gifs_only]=true',
        `inputs[gif_scenarios_from]=${'a'.repeat(40)}`,
        'ref=main',
      ]),
    );
    expect(logged()).toContain('run 12 ended failure; using its videos anyway');
    expect(logged()).toContain("run 12's broken stopped before its last step; no GIF of it");
    expect(logged()).toContain('swipe.mp4: 1 touch stretch(es) kept');
    expect(logged()).toContain(
      'new-sheet: main has no recording of it (a new scenario?); after only',
    );
    // Every recording's waits cut, by the ring, before its GIF.
    expect(asked('ffmpeg').filter((a) => a.includes('[cut]'))).toHaveLength(3);
    expect(world.asked.find(([c]) => c === 'publish')).toEqual([
      'publish',
      '7/new-sheet-after.gif',
      '7/swipe-after.gif',
      '7/swipe-before.gif',
      '7/swipe-side-by-side.gif',
    ]);
    expect(vi.mocked(publishFiles).mock.calls[0][2]).toMatchObject({
      branch: 'screenshots',
      push: true,
    });
    const table = String(stdout.mock.calls.at(-1)?.[0]);
    expect(table).toContain(
      '| swipe | <img src="https://raw.githubusercontent.com/jbhirsh/sift/cafe/7/swipe-side-by-side.gif" width="520"> |',
    );
    expect(table).toContain(
      '| new-sheet | (none) | <img src="https://raw.githubusercontent.com/jbhirsh/sift/cafe/7/new-sheet-after.gif" width="260"> |',
    );
  });

  it('skips the before for a new screen, asks again without run details, warns of a link that fails', async () => {
    world.curl = '404';
    world.frames = [blank(), blank()];
    await main(['7', '--no-before', '--repo', 'jbhirsh/sift'], { root: '/app', settings });
    expect(asked('gh').some((a) => a.includes('POST'))).toBe(false);
    expect(asked('git')).toHaveLength(1);
    expect(logged()).toContain('no drawn touch found');
    expect(logged()).toContain('7/swipe-after.gif answered 404');
  });

  it('finds the run it started when GitHub won’t name it', async () => {
    world.dispatchError = 'HTTP 422: return_run_details is not a permitted key';
    world.api['repos/jbhirsh/sift/actions/workflows/ci.yml/runs?event=workflow_dispatch'] = [
      { workflow_runs: [{ id: 5 }] },
      { workflow_runs: [{ id: 5 }] },
      { workflow_runs: [{ id: 12 }, { id: 5 }] },
    ];
    await main(['7'], { root: '/app', settings });
    expect(asked('gh').filter((a) => a.includes('POST'))).toHaveLength(2);
    expect(world.asked.find(([c]) => c === 'publish')).toContain('7/swipe-before.gif');
  });

  it('keeps a video whole when cutting fails, and goes on without a GIF that fails', async () => {
    world.decodeCode = 1;
    world.failing = new Set(['new-sheet-after.gif']);
    await main(['7'], { root: '/app', settings });
    expect(logged()).toContain(
      'cutting its waits failed (decoding swipe.mp4 failed); keeping it whole',
    );
    expect(logged()).toContain('warning: new-sheet (after): ffmpeg');
    expect(world.asked.find(([c]) => c === 'publish')).toEqual([
      'publish',
      '7/swipe-after.gif',
      '7/swipe-before.gif',
    ]);
  });

  it('stops on what it cannot get past', async () => {
    await expect(main(['7', '--repo', 'someone/else'], { root: '/app', settings })).rejects.toThrow(
      "This clone's origin (https://github.com/jbhirsh/sift.git) isn't someone/else",
    );
    world.drawtext = false;
    await expect(main(['7', '--side-by-side'], { root: '/app', settings })).rejects.toThrow(
      'lacks (build it with freetype)',
    );
    world.drawtext = true;
    world.dispatchError = 'HTTP 403: forbidden';
    await expect(main(['7'], { root: '/app', settings })).rejects.toThrow(
      'Starting the run on main failed: HTTP 403',
    );
    world.dispatchError = null;
    world.api['repos/jbhirsh/sift/actions/runs/12'] = {
      id: 12,
      status: 'completed',
      conclusion: 'cancelled',
    };
    await expect(main(['7'], { root: '/app', settings })).rejects.toThrow('Run 12 was cancelled');
    world.api['repos/jbhirsh/sift/actions/runs/12'] = {
      id: 12,
      status: 'completed',
      conclusion: 'success',
    };
    world.api['repos/jbhirsh/sift/actions/runs/11/artifacts'] = { artifacts: [] };
    await expect(main(['7'], { root: '/app', settings })).rejects.toThrow(
      'Run 11 has no ios-gif-videos artifact',
    );
    world.api['repos/jbhirsh/sift/actions/runs/11/artifacts'] = {
      artifacts: [{ id: 101, name: 'ios-gif-videos' }],
    };
    world.videos.after = [];
    await expect(main(['7', '--no-before'], { root: '/app', settings })).rejects.toThrow(
      'recorded no GIF scenarios',
    );
    world.videos.after = ['swipe.mp4'];
    world.failing = new Set(['swipe-after.gif']);
    await expect(main(['7', '--no-before'], { root: '/app', settings })).rejects.toThrow(
      'No GIF could be made',
    );
  });

  it('gives up waiting on a run that never finishes or starts', async () => {
    Object.assign(timing, { waitLimitMs: 5, startLimitMs: 5 });
    world.api['repos/jbhirsh/sift/actions/runs/11'] = { id: 11, status: 'queued' };
    await expect(videos.waitForRun('jbhirsh/sift', 11)).rejects.toThrow(
      'Run 11 still queued after',
    );
    world.api['repos/jbhirsh/sift/actions/workflows/ci.yml/runs?head_sha'] = { workflow_runs: [] };
    await expect(videos.afterRun('jbhirsh/sift', 'ci.yml', 'abc')).rejects.toThrow(
      'No ci.yml run for abc',
    );
    world.dispatchError = 'HTTP 422';
    await expect(videos.beforeRun('jbhirsh/sift', settings.videos, 'abc')).rejects.toThrow(
      'The run on main never started',
    );
  });
});
