// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OVERLAY_SCRIPT } from './overlay.mjs';
import {
  FIRST_FRAME_MS,
  PICTURES_LOADED,
  QUALITY,
  clockOffset,
  recordFrames,
  showPointer,
  waitForPictures,
} from './record.mjs';
import { frameName } from './timeline.mjs';

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
 * A JPEG's start: an APP0 segment, then a frame header of this size, and
 * `tag` after.
 *
 * @param {number} width
 * @param {number} height
 * @param {string} [tag]
 */
function jpeg(width, height, tag = '') {
  const head = Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
  ]);
  return Buffer.concat([head, Buffer.from(tag)]);
}

describe('recordFrames', () => {
  // The fake page's screencast and the recording's clock both run on a fake
  // one, so a loaded machine can't change how many frames come, or when.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A page whose screencast sends a JPEG every 5 ms once started, each
   * stamped (in ms) as `stamps` says, alike every `same` frames, and of the
   * size `size` gives in its header (none by default), until it's stopped;
   * its overlay reports `ticks` and `moves`.
   *
   * @param {{ stamps?: (n: number) => number; size?: { width: number; height: number }; viewport?: { width: number; height: number }; dpr?: number; silent?: boolean; same?: number; moves?: unknown; ticks?: unknown; evaluateFails?: boolean; noScreencast?: boolean }} [options]
   */
  function fakePage({
    stamps = () => Date.now() - 2,
    size,
    viewport = { width: 1100, height: 640 },
    dpr = 1,
    silent = false,
    same = 1,
    moves = [],
    ticks = [],
    evaluateFails = false,
    noScreencast = false,
  } = {}) {
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let sending;
    let n = 0;
    /** @type {(() => unknown)[]} */
    const loads = [];
    const screencast = {
      start: vi.fn(
        (
          /** @type {{ onFrame: (frame: { data: Buffer; timestamp: number }) => void }} */ {
            onFrame,
          },
        ) => {
          if (!silent) {
            sending = setInterval(() => {
              const i = n++;
              const tag = `frame ${Math.floor(i / same)}`;
              const data = size ? jpeg(size.width, size.height, tag) : Buffer.from(tag);
              onFrame({ data, timestamp: stamps(i) });
            }, 5);
          }
          return Promise.resolve({});
        },
      ),
      stop: vi.fn(() => {
        clearInterval(sending);
        return Promise.resolve();
      }),
    };
    const page = {
      screencast: noScreencast ? undefined : screencast,
      viewportSize: () => viewport,
      evaluate: vi.fn((/** @type {string} */ script) => {
        if (script === 'devicePixelRatio') return Promise.resolve(dpr);
        if (evaluateFails) return Promise.reject(new Error('page closed'));
        if (script.includes('__prGifTicks ||')) return Promise.resolve(ticks);
        if (script.includes('__prGifMoves ||')) return Promise.resolve(moves);
        return Promise.resolve(undefined);
      }),
      on: vi.fn((/** @type {string} */ _event, /** @type {() => unknown} */ fn) => loads.push(fn)),
      off: vi.fn(),
    };
    return { page, screencast, sent: () => n, loads };
  }
  /**
   * @param {string} dir
   * @param {number} i
   */
  const frameText = (dir, i) => readFileSync(path.join(dir, frameName(i))).toString();

  it('keeps the frames painted until stopped, thinned, with their timeline and crop', async () => {
    const dir = path.join(temp(), 'frames');
    // Whatever was there goes.
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'stale.jpg'), 'old');
    const { page, screencast, sent, loads } = fakePage({
      stamps: (n) => 1_700_000_000_000 + n * 100,
    });
    const clip = { x: 0, y: 80, width: 900, height: 400 };
    const stop = await recordFrames(as(page), clip, dir);
    // The clip is set on the page now, and again on each page it loads.
    expect(page.evaluate).toHaveBeenCalledWith(`window.__prGifClip = ${JSON.stringify(clip)}`);
    expect(loads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60);
    const recording = await stop();
    expect(recording.sent).toBe(sent());
    expect(recording.sent).toBeGreaterThan(3);
    // 100 ms apart by their stamps: every one kept, each its own GIF frame.
    expect(recording.stills).toBe(recording.sent);
    expect(recording.rests).toEqual([]);
    const files = readdirSync(dir).sort();
    expect(files).toContain('frames.ffconcat');
    expect(files).toContain('crop.txt');
    expect(files).not.toContain('stale.jpg');
    expect(files).toContain(frameName(0));
    expect(frameText(dir, 0)).toBe('frame 0');
    expect(readFileSync(path.join(dir, 'crop.txt'), 'utf8')).toBe('crop=900:400:0:80');
    const list = readFileSync(path.join(dir, 'frames.ffconcat'), 'utf8');
    expect(
      list.startsWith(
        `ffconcat version 1.0\nfile '${frameName(0)}'\noption framerate 100\nduration 0.100\n`,
      ),
    ).toBe(true);
    // The whole viewport at its density, at a set quality: without a size,
    // Playwright would fit frames to 800 px and drop the density.
    expect(screencast.start).toHaveBeenCalledWith(
      expect.objectContaining({ size: { width: 1100, height: 640 }, quality: QUALITY }),
    );
    expect(screencast.stop).toHaveBeenCalledTimes(1);
    expect(page.off).toHaveBeenCalledWith('domcontentloaded', loads[0]);
    expect(page.evaluate).toHaveBeenCalledWith('delete window.__prGifClip');
  });

  it('merges frames alike into one, and thins a fast stream to the frame rate asked', async () => {
    const dir = temp();
    // A frame every 5 ms by its stamp, every 4 alike.
    const { page } = fakePage({ stamps: (n) => 1_700_000_000_000 + n * 5, same: 4 });
    const stop = await recordFrames(as(page), { x: 0, y: 0, width: 10, height: 10 }, dir, {
      fps: 50,
    });
    await vi.advanceTimersByTimeAsync(80);
    const { sent, stills } = await stop();
    expect(stills).toBeLessThan(sent / 3);
  });

  it('asks for frames at the page’s density, and crops in their pixels', async () => {
    const dir = temp();
    const { page, screencast } = fakePage({ viewport: { width: 402, height: 874 }, dpr: 2 });
    const stop = await recordFrames(as(page), { x: 0, y: 80, width: 402, height: 400 }, dir);
    expect(screencast.start).toHaveBeenCalledWith(
      expect.objectContaining({ size: { width: 804, height: 1748 } }),
    );
    await vi.advanceTimersByTimeAsync(20);
    await stop();
    expect(readFileSync(path.join(dir, 'crop.txt'), 'utf8')).toBe('crop=804:800:0:160');
  });

  it('asks for whole even pixels, as Playwright rounds them, and crops by that', async () => {
    const dir = temp();
    const { page, screencast } = fakePage({ viewport: { width: 401, height: 301 } });
    const stop = await recordFrames(as(page), { x: 0, y: 0, width: 401, height: 301 }, dir);
    expect(screencast.start).toHaveBeenCalledWith(
      expect.objectContaining({ size: { width: 400, height: 300 } }),
    );
    await vi.advanceTimersByTimeAsync(20);
    await stop();
    expect(readFileSync(path.join(dir, 'crop.txt'), 'utf8')).toBe('crop=400:300:0:0');
  });

  it('crops by the size frames came at, when that isn’t the size asked for', async () => {
    const dir = temp();
    const { page } = fakePage({
      size: { width: 402, height: 874 },
      viewport: { width: 402, height: 874 },
      dpr: 2,
    });
    const stop = await recordFrames(as(page), { x: 0, y: 80, width: 402, height: 400 }, dir);
    await vi.advanceTimersByTimeAsync(20);
    await stop();
    expect(readFileSync(path.join(dir, 'crop.txt'), 'utf8')).toBe('crop=402:400:0:80');
  });

  it('goes by when frames arrive if they’re stamped on another clock', async () => {
    const dir = temp();
    const { page } = fakePage({ stamps: (n) => 5000 + n * 20 });
    const stop = await recordFrames(as(page), { x: 0, y: 0, width: 10, height: 10 }, dir);
    await vi.advanceTimersByTimeAsync(60);
    const { stills, seconds } = await stop();
    expect(stills).toBeGreaterThan(0);
    expect(seconds).toBeLessThan(5);
    const durations = [
      ...readFileSync(path.join(dir, 'frames.ffconcat'), 'utf8').matchAll(/duration ([\d.]+)/g),
    ].map((m) => Number(m[1]));
    for (const d of durations) expect(d).toBeLessThan(2);
  });

  it('warns when the pointer rested outside the clip, from the moves the overlay kept', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { page } = fakePage({ moves: [{ x: 950, y: 10, t: Date.now() - 5000 }] });
      const stop = await recordFrames(as(page), { x: 0, y: 0, width: 900, height: 400 }, temp());
      await vi.advanceTimersByTimeAsync(600);
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
    await vi.advanceTimersByTimeAsync(20);
    const { stills, rests } = await stop();
    expect(stills).toBeGreaterThan(0);
    expect(rests).toEqual([]);
  });

  it("says what to update when the app's Playwright has no page.screencast", async () => {
    const { page } = fakePage({ noScreencast: true });
    await expect(
      recordFrames(as(page), { x: 0, y: 0, width: 10, height: 10 }, temp()),
    ).rejects.toThrow("which the app's Playwright lacks: update it");
  });

  it('gives up on a screencast that sends nothing, still stopping it', async () => {
    const { page, screencast } = fakePage({ silent: true });
    const stop = await recordFrames(as(page), { x: 0, y: 0, width: 10, height: 10 }, temp());
    const failed = expect(stop()).rejects.toThrow('recordFrames: no frame came in 5 s');
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_MS);
    await failed;
    expect(screencast.stop).toHaveBeenCalled();
  });
});
