// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OVERLAY_SCRIPT } from './overlay.mjs';
import {
  FIRST_FRAME_MS,
  PICTURES_LOADED,
  clockOffset,
  recordFrames,
  showPointer,
  waitForPictures,
} from './record.mjs';
import { frameName } from './timeline.mjs';

/** @typedef {import('./record.mjs').ScreencastFrame} ScreencastFrame */

// jsdom's, which this file runs in (the repo's lint knows Node's globals).
const { document } = globalThis;

const temp = () => mkdtempSync(path.join(tmpdir(), 'gif-record-'));
/**
 * Any fake, as the structural type a function asks for.
 *
 * @param {unknown} fake
 */
const as = (fake) => /** @type {never} */ (fake);

describe('showPointer', () => {
  it('draws the overlay from an init script, on every page the context opens', async () => {
    const addInitScript = vi.fn(() => Promise.resolve());
    await showPointer({ addInitScript });
    expect(addInitScript).toHaveBeenCalledWith({ content: OVERLAY_SCRIPT });
  });
});

describe('waitForPictures', () => {
  it('waits for the pictures in view', async () => {
    const waitForFunction = vi.fn(() => Promise.resolve());
    expect(await waitForPictures({ waitForFunction, isClosed: () => false }, 5000)).toBe(true);
    expect(waitForFunction).toHaveBeenCalledWith(PICTURES_LOADED, undefined, { timeout: 5000 });
  });

  it('gives up with a warning, not an error, after 20 s by default; silently on a closed page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const waitForFunction = vi.fn(() => Promise.reject(new Error('Timeout')));
      expect(await waitForPictures({ waitForFunction, isClosed: () => false })).toBe(false);
      expect(waitForFunction).toHaveBeenCalledWith(PICTURES_LOADED, undefined, { timeout: 20_000 });
      expect(warn).toHaveBeenCalledWith("pr-gif: some pictures in view hadn't loaded after 20 s");
      await waitForPictures({ waitForFunction, isClosed: () => true });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('counts a picture loaded or broken, out of view, or with no src', () => {
    // The check itself, run here against jsdom's images.
    const check = () => /** @type {boolean} */ (new Function(`return ${PICTURES_LOADED}`)());
    const img = document.createElement('img');
    document.body.append(img);
    /**
     * @param {number} top
     * @param {number} [width]
     */
    const box = (top, width = 100) =>
      vi.spyOn(img, 'getBoundingClientRect').mockReturnValue(
        /** @type {ReturnType<typeof document.body.getBoundingClientRect>} */ ({
          top,
          bottom: top + 50,
          width,
        }),
      );
    /** @param {boolean} value */
    const complete = (value) =>
      Object.defineProperty(img, 'complete', { value, configurable: true });
    try {
      box(10);
      // A lazy picture in view that hasn't started yet still counts.
      img.setAttribute('src', 'https://upload.wikimedia.org/a.jpg');
      img.loading = 'lazy';
      complete(false);
      expect(check()).toBe(false);
      // Loaded, or broken: either way, what the site shows.
      complete(true);
      expect(check()).toBe(true);
      complete(false);
      // Below the fold, above it, or not laid out.
      box(5000);
      expect(check()).toBe(true);
      box(-60);
      expect(check()).toBe(true);
      box(10, 0);
      expect(check()).toBe(true);
      // No src.
      box(10);
      img.removeAttribute('src');
      expect(check()).toBe(true);
    } finally {
      img.remove();
    }
  });
});

describe('clockOffset', () => {
  it("trusts stamps on the epoch's clock, and shifts any other to the first frame's arrival", () => {
    expect(clockOffset(1_000_000, 1_000_050)).toBe(0);
    expect(clockOffset(1_000_000, 1_009_999)).toBe(0);
    expect(clockOffset(5000, 1_700_000_000_000)).toBe(1_700_000_000_000 - 5000);
  });
});

/**
 * A PNG's first 24 bytes, its size in the header, and `tag` after.
 *
 * @param {number} width
 * @param {number} height
 * @param {string} [tag]
 */
function png(width, height, tag = '') {
  const head = Buffer.alloc(24);
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.from(tag)]);
}

describe('recordFrames', () => {
  /**
   * A page whose screencast sends a frame every 5 ms once started, each
   * stamped (in seconds) as `stamps` says, and alike every `same` frames,
   * until it's stopped; its overlay reports `ticks` and `moves`.
   *
   * @param {{ stamps?: (n: number) => number | undefined; width?: number; silent?: boolean; same?: number; moves?: unknown; ticks?: unknown; evaluateFails?: boolean }} [options]
   */
  function fakePage({
    stamps = () => Date.now() / 1000,
    width = 1100,
    silent = false,
    same = 1,
    moves = [],
    ticks = [],
    evaluateFails = false,
  } = {}) {
    /** @type {((frame: ScreencastFrame) => void) | undefined} */
    let listener;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let sending;
    let n = 0;
    /** @type {(() => unknown)[]} */
    const loads = [];
    const cdp = {
      on: vi.fn(
        (/** @type {string} */ _event, /** @type {(frame: ScreencastFrame) => void} */ fn) => {
          listener = fn;
        },
      ),
      send: vi.fn((/** @type {string} */ method) => {
        if (method === 'Page.startScreencast' && !silent) {
          sending = setInterval(() => {
            const i = n++;
            listener?.({
              data: png(width, 640, `frame ${Math.floor(i / same)}`).toString('base64'),
              sessionId: i,
              metadata: { deviceWidth: 1100, timestamp: stamps(i) },
            });
          }, 5);
        }
        if (method === 'Page.stopScreencast') clearInterval(sending);
        return Promise.resolve();
      }),
      detach: vi.fn(() => Promise.resolve()),
    };
    const page = {
      context: () => ({ newCDPSession: vi.fn(() => Promise.resolve(cdp)) }),
      evaluate: vi.fn((/** @type {string} */ script) => {
        if (evaluateFails) return Promise.reject(new Error('page closed'));
        if (script.includes('__prGifTicks ||')) return Promise.resolve(ticks);
        if (script.includes('__prGifMoves ||')) return Promise.resolve(moves);
        return Promise.resolve(undefined);
      }),
      on: vi.fn((/** @type {string} */ _event, /** @type {() => unknown} */ fn) => loads.push(fn)),
      off: vi.fn(),
    };
    return { page, cdp, sent: () => n, loads };
  }
  /**
   * @param {string} dir
   * @param {number} i
   */
  const frameText = (dir, i) =>
    readFileSync(path.join(dir, frameName(i)))
      .subarray(24)
      .toString();

  it('keeps the frames painted until stopped, thinned, with their timeline and crop', async () => {
    const dir = path.join(temp(), 'frames');
    // Whatever was there goes.
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'stale.png'), 'old');
    const { page, cdp, sent, loads } = fakePage({ stamps: (n) => 1_700_000_000 + n * 0.1 });
    const clip = { x: 0, y: 80, width: 900, height: 400 };
    const stop = await recordFrames(as(page), clip, dir);
    // The clip is set on the page now, and again on each page it loads.
    expect(page.evaluate).toHaveBeenCalledWith(`window.__prGifClip = ${JSON.stringify(clip)}`);
    expect(loads).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 60));
    const recording = await stop();
    expect(recording.sent).toBe(sent());
    expect(recording.sent).toBeGreaterThan(3);
    // 100 ms apart by their stamps: every one kept, each its own GIF frame.
    expect(recording.stills).toBe(recording.sent);
    expect(recording.rests).toEqual([]);
    const files = readdirSync(dir).sort();
    expect(files).toContain('frames.ffconcat');
    expect(files).toContain('crop.txt');
    expect(files).not.toContain('stale.png');
    expect(frameText(dir, 0)).toBe('frame 0');
    expect(readFileSync(path.join(dir, 'crop.txt'), 'utf8')).toBe('crop=900:400:0:80');
    const list = readFileSync(path.join(dir, 'frames.ffconcat'), 'utf8');
    expect(
      list.startsWith(
        `ffconcat version 1.0\nfile '${frameName(0)}'\noption framerate 100\nduration 0.100\n`,
      ),
    ).toBe(true);
    // Every frame as PNG, each acknowledged so the next comes.
    expect(cdp.send.mock.calls[0]).toEqual([
      'Page.startScreencast',
      { format: 'png', everyNthFrame: 1 },
    ]);
    const acks = cdp.send.mock.calls.filter(([method]) => method === 'Page.screencastFrameAck');
    expect(acks).toHaveLength(recording.sent);
    expect(cdp.detach).toHaveBeenCalledTimes(1);
    expect(page.off).toHaveBeenCalledWith('domcontentloaded', loads[0]);
    expect(page.evaluate).toHaveBeenCalledWith('delete window.__prGifClip');
  });

  it('merges frames alike into one, and thins a fast stream to the frame rate asked', async () => {
    const dir = temp();
    // A frame every 5 ms by its stamp, every 4 alike.
    const { page } = fakePage({ stamps: (n) => 1_700_000_000 + n * 0.005, same: 4 });
    const stop = await recordFrames(as(page), { x: 0, y: 0, width: 10, height: 10 }, dir, {
      fps: 50,
    });
    await new Promise((r) => setTimeout(r, 80));
    const { sent, stills } = await stop();
    expect(stills).toBeLessThan(sent / 3);
  });

  it('crops in the frames’ pixels when they’re drawn at a higher density', async () => {
    const dir = temp();
    const { page } = fakePage({ width: 2200 });
    const stop = await recordFrames(as(page), { x: 0, y: 80, width: 1100, height: 560 }, dir);
    await new Promise((r) => setTimeout(r, 20));
    await stop();
    expect(readFileSync(path.join(dir, 'crop.txt'), 'utf8')).toBe('crop=2200:1120:0:160');
  });

  it('goes by when frames arrive if they aren’t stamped, or stamped on another clock', async () => {
    for (const stamps of [() => undefined, (/** @type {number} */ n) => 5 + n * 0.02]) {
      const dir = temp();
      const { page } = fakePage({ stamps });
      const stop = await recordFrames(as(page), { x: 0, y: 0, width: 10, height: 10 }, dir);
      await new Promise((r) => setTimeout(r, 60));
      const { stills, seconds } = await stop();
      expect(stills).toBeGreaterThan(0);
      expect(seconds).toBeLessThan(5);
      const durations = [
        ...readFileSync(path.join(dir, 'frames.ffconcat'), 'utf8').matchAll(/duration ([\d.]+)/g),
      ].map((m) => Number(m[1]));
      for (const d of durations) expect(d).toBeLessThan(2);
    }
  });

  it('warns when the pointer rested outside the clip, from the moves the overlay kept', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { page } = fakePage({ moves: [{ x: 950, y: 10, t: Date.now() - 5000 }] });
      const stop = await recordFrames(as(page), { x: 0, y: 0, width: 900, height: 400 }, temp());
      await new Promise((r) => setTimeout(r, 600));
      const { rests } = await stop();
      expect(rests).toHaveLength(1);
      expect(rests[0]).toMatchObject({ x: 950, y: 10, at: 0 });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/^pr-gif: the pointer rested out of shot at \(950, 10\)/),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("still finishes when the page can't be asked anything any more", async () => {
    const { page } = fakePage({ evaluateFails: true });
    const stop = await recordFrames(as(page), { x: 0, y: 0, width: 10, height: 10 }, temp());
    await new Promise((r) => setTimeout(r, 20));
    const { stills, rests } = await stop();
    expect(stills).toBeGreaterThan(0);
    expect(rests).toEqual([]);
  });

  it('gives up on a screencast that sends nothing, still stopping it', async () => {
    vi.useFakeTimers();
    try {
      const { page, cdp } = fakePage({ silent: true });
      const stop = await recordFrames(as(page), { x: 0, y: 0, width: 10, height: 10 }, temp());
      const failed = expect(stop()).rejects.toThrow('recordFrames: no frame came in 5 s');
      await vi.advanceTimersByTimeAsync(FIRST_FRAME_MS);
      await failed;
      expect(cdp.send).toHaveBeenLastCalledWith('Page.stopScreencast');
      expect(cdp.detach).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
