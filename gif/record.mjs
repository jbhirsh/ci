// Recording a page for a GIF, with the pointer and keys drawn in
// (overlay.mjs). Frames come from Chrome's screencast, which sends one for
// each repaint without holding the page up, stamped with when it was
// painted: motion comes out at 15-25 frames a second where screenshots
// managed 2-5, and a still page costs nothing. Playwright's own video
// recorder needs an ffmpeg build of its own; the system ffmpeg joins these
// (ffmpeg.mjs).

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OVERLAY_SCRIPT } from './overlay.mjs';
import {
  HOLDS,
  concatList,
  cropFilter,
  frameName,
  pngSize,
  restsOutside,
  thinner,
  timeline,
} from './timeline.mjs';

/** @typedef {import('./timeline.mjs').Clip} Clip */
/** @typedef {import('./timeline.mjs').Holds} Holds */
/** @typedef {import('./timeline.mjs').Move} Move */
/** @typedef {import('./timeline.mjs').Rest} Rest */
/** @typedef {import('./timeline.mjs').Shot} Shot */
/** @typedef {import('./timeline.mjs').Tick} Tick */

/**
 * @typedef {object} ScreencastFrame A frame of Chrome's screencast (Page.screencastFrame).
 * @property {string} data the PNG, base64
 * @property {number} sessionId
 * @property {{ deviceWidth: number; timestamp?: number }} metadata deviceWidth: the viewport's width in CSS pixels; timestamp: when it was painted, in seconds
 */

/**
 * @typedef {{
 *   on(event: 'Page.screencastFrame', listener: (frame: ScreencastFrame) => void): unknown;
 *   send(method: 'Page.startScreencast' | 'Page.stopScreencast' | 'Page.screencastFrameAck', params?: object): Promise<unknown>;
 *   detach(): Promise<void>;
 * }} Screencast What recordFrames needs of a CDP session.
 */

/**
 * @typedef {object} Recordable What recordFrames needs of a Playwright page: a page passes as is.
 * @property {() => { newCDPSession(page: never): Promise<Screencast> }} context
 * @property {(script: string) => Promise<unknown>} evaluate
 * @property {(event: 'domcontentloaded', listener: () => unknown) => unknown} on
 * @property {(event: 'domcontentloaded', listener: () => unknown) => unknown} off
 */

/**
 * @typedef {object} Recording What a recording took: the frames Chrome sent, the GIF frames they made, how long it ran, and where the pointer rested out of shot.
 * @property {number} sent
 * @property {number} stills
 * @property {number} seconds
 * @property {Rest[]} rests
 */

/** How long recordFrames waits for the screencast's first frame. */
export const FIRST_FRAME_MS = 5000;

/**
 * Draws the pointer and key presses on every page `context` opens after
 * this call: call it before the first page loads.
 *
 * @param {{ addInitScript(script: { content: string }): Promise<unknown> }} context
 */
export async function showPointer(context) {
  await context.addInitScript({ content: OVERLAY_SCRIPT });
}

/**
 * Waits, up to `timeout` ms, for the pictures in view to finish loading (or
 * failing), so a recording doesn't open on blank cards: a lazy one in view
 * counts from its src, before it has started; one with no src, out of view
 * or not laid out doesn't count. Ones further down load as they're scrolled
 * to. Warns, rather than failing, when they hadn't by then.
 *
 * @param {{ waitForFunction(script: string, arg: undefined, options: { timeout: number }): Promise<unknown>; isClosed(): boolean }} page
 * @param {number} [timeout]
 * @returns {Promise<boolean>} whether they had
 */
export async function waitForPictures(page, timeout = 20_000) {
  try {
    await page.waitForFunction(PICTURES_LOADED, undefined, { timeout });
    return true;
  } catch {
    if (!page.isClosed()) {
      console.warn(`pr-gif: some pictures in view hadn't loaded after ${timeout / 1000} s`);
    }
    return false;
  }
}

/** The check waitForPictures runs in the page. */
export const PICTURES_LOADED = `[...document.images].every((img) => {
  const box = img.getBoundingClientRect();
  const inView = box.bottom > 0 && box.top < innerHeight && box.width > 0;
  return !inView || !img.getAttribute('src') || img.complete;
})`;

/**
 * The page's clock to ours, from the first frame: the screencast stamps
 * frames in seconds since the epoch, which the overlay's ticks share; if a
 * browser ever stamps them otherwise (over 10 s off), frames are placed by
 * the offset to when the first one arrived instead.
 *
 * @param {number} stampMs the first frame's stamp, in ms
 * @param {number} now when it arrived, ms since the epoch
 */
export function clockOffset(stampMs, now) {
  return Math.abs(now - stampMs) > 10_000 ? now - stampMs : 0;
}

/**
 * Records `clip` (CSS pixels from the viewport's top left) into `dir` until
 * the returned function is called; that resolves once the last frame is
 * written, and throws if the page never painted one within FIRST_FRAME_MS.
 * Frames are thinned to about `fps` a second (timeline.mjs's thinner): each
 * frame of motion adds to the GIF's size, and 15 keeps a few seconds of a
 * moving row to a few MB. It writes the kept frames, `frames.ffconcat`, the
 * timeline framesToGif plays (each frame for as long as it was on screen,
 * repeats merged, a long still start and end cut short, stalls cut), and
 * `crop.txt`, which cuts the clip from the whole viewport in the frames' own
 * pixels (a device scale factor of 2 paints twice as many). It warns when the
 * pointer rested outside the clip, where the GIF can't show it. `dir` is
 * emptied first, so an earlier run's frames can't mix in.
 *
 * @param {Recordable} page
 * @param {Clip} clip
 * @param {string} dir
 * @param {{ fps?: number; holds?: Holds }} [options]
 * @returns {Promise<() => Promise<Recording>>}
 */
export async function recordFrames(page, clip, dir, { fps = 15, holds = HOLDS } = {}) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // The page itself, which the structural type can't say without naming
  // Playwright's own.
  const cdp = await page
    .context()
    .newCDPSession(/** @type {never} */ (/** @type {unknown} */ (page)));
  const start = Date.now();
  /** @type {Shot[]} */
  const shots = [];
  /** @type {ReturnType<typeof thinner<{ at: number; png: Buffer }>>} */
  const thin = thinner(1000 / fps);
  let sent = 0;
  let scale = 1;
  /** @type {number | null} */
  let offset = null;
  /** @type {() => void} */
  let first = () => {};
  /** @type {Promise<void>} */
  const firstFrame = new Promise((done) => (first = done));
  /** @param {{ at: number; png: Buffer } | null} frame */
  const keep = (frame) => {
    if (!frame) return;
    const file = frameName(shots.length);
    writeFileSync(path.join(dir, file), frame.png);
    shots.push({ file, at: frame.at, hash: createHash('sha1').update(frame.png).digest('hex') });
  };
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const png = Buffer.from(data, 'base64');
    const now = Date.now();
    if (sent === 0) scale = pngSize(png).width / metadata.deviceWidth;
    sent++;
    let at = now;
    if (metadata.timestamp !== undefined) {
      offset ??= clockOffset(metadata.timestamp * 1000, now);
      at = metadata.timestamp * 1000 + offset;
    }
    keep(thin.push({ at, png }));
    first();
    // Unacknowledged, it sends no more.
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  // For the key labels, which keep inside what is recorded, and the ticks,
  // which watch it: set again on each page a scenario loads.
  const setClip = () =>
    page.evaluate(`window.__prGifClip = ${JSON.stringify(clip)}`).catch(() => {});
  page.on('domcontentloaded', setClip);
  await setClip();
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  return async () => {
    try {
      await Promise.race([
        firstFrame,
        new Promise((_, failed) =>
          setTimeout(
            () => failed(new Error(`recordFrames: no frame came in ${FIRST_FRAME_MS / 1000} s`)),
            FIRST_FRAME_MS,
          ).unref(),
        ),
      ]);
    } finally {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
      page.off('domcontentloaded', setClip);
    }
    const end = Date.now();
    keep(thin.flush());
    await page.evaluate('delete window.__prGifClip').catch(() => {});
    const ticks = /** @type {Tick[]} */ (
      (await page.evaluate('window.__prGifTicks || []').catch(() => [])) ?? []
    );
    const stills = timeline(shots, end, holds, { ticks, frame: 1000 / fps });
    writeFileSync(path.join(dir, 'frames.ffconcat'), concatList(stills));
    writeFileSync(path.join(dir, 'crop.txt'), cropFilter(clip, scale));
    const moves = /** @type {Move[]} */ (
      (await page.evaluate('window.__prGifMoves || []').catch(() => [])) ?? []
    );
    const rests = restsOutside(moves, clip, start, end);
    for (const r of rests) {
      console.warn(
        `pr-gif: the pointer rested out of shot at (${r.x}, ${r.y}) for ${r.ms} ms, ${r.at} ms in; keep it inside the clip`,
      );
    }
    return { sent, stills: stills.length, seconds: (end - start) / 1000, rests };
  };
}
