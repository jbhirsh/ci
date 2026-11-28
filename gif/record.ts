// Recording a page for a GIF, with the pointer and keys drawn in
// (overlay.ts), in WebKit (cli.ts). Frames come from Playwright's
// screencast, which sends one for each repaint without holding the page up,
// stamped with when it was painted: motion comes out at 15-25 frames a
// second where screenshots managed 2-5, and a still page costs nothing.
// Playwright's own video recorder needs an ffmpeg build of its own; the
// system ffmpeg joins these frames (ffmpeg.ts). What the screencast does
// that this file makes up for:
//   - it sends JPEGs, saved as .jpg, at QUALITY;
//   - unless given a size it fits frames to 800 px and ignores the device
//     scale factor, so it's asked for the page's viewport times its
//     devicePixelRatio (whole even pixels, as Playwright rounds them); the
//     frames' density is still read from the first one's size, so the crop
//     fits what came;
//   - it stamps frames in wall-clock ms. Playwright moves WebKit's paint
//     times onto Date.now() as of the first frame's arrival, so they run
//     that frame's encoding and delivery (tens of ms) behind the overlay's
//     ticks: a stall can be cut a little early or late, which no clock here
//     can correct;
//   - WebKit drops the fps asked for and sends a frame per repaint, so the
//     thinner below caps it.

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KEY_LABEL, OVERLAY_SCRIPT } from './overlay.ts';
import {
  HOLDS,
  concatList,
  cropFilter,
  frameName,
  jpegSize,
  pageKeyLabel,
  restsOutside,
  thinner,
  timeline,
} from './timeline.ts';
import type { Clip, Holds, Move, Rest, Shot, Tick } from './timeline.ts';

/** A frame of Playwright's page.screencast. */
export type ScreencastFrame = {
  /** the JPEG */
  data: Buffer;
  /** when it was painted, in ms since the epoch */
  timestamp: number;
};

/** What recordFrames needs of Playwright's page.screencast. */
export type Screencast = {
  start: (options: {
    onFrame: (frame: ScreencastFrame) => void;
    size: { width: number; height: number };
    quality: number;
  }) => Promise<unknown>;
  stop: () => Promise<void>;
};

/** What recordFrames needs of a Playwright page: a page passes as is. */
export type Recordable = {
  /** undefined in a Playwright before it had one */
  screencast: Screencast | undefined;
  viewportSize: () => { width: number; height: number } | null;
  evaluate: (script: string) => Promise<unknown>;
  on: (event: 'domcontentloaded', listener: () => unknown) => unknown;
  off: (event: 'domcontentloaded', listener: () => unknown) => unknown;
};

/**
 * What a recording took: the frames the browser sent, the GIF frames they made, how long it ran,
 * and where the pointer rested out of shot.
 */
export type Recording = {
  sent: number;
  stills: number;
  seconds: number;
  rests: Rest[];
};

/** How long recordFrames waits for the screencast's first frame. */
export const FIRST_FRAME_MS = 5000;

/**
 * The JPEG quality frames are taken at: Playwright's own default, named
 * here so a change to it can't change the GIFs. The GIF's 256 colours lose
 * far more than q90's artefacts do.
 */
export const QUALITY = 90;

/**
 * Draws the pointer and key presses on every page `context` opens after
 * this call: call it once, before the first page loads (Playwright refuses
 * a binding's name twice). The overlay asks Node to name each key (the
 * KEY_LABEL binding), so no function's source goes into the page.
 */
export async function showPointer(context: {
  exposeBinding(
    name: string,
    binding: (source: unknown, sent: unknown) => unknown,
  ): Promise<unknown>;
  addInitScript(script: { content: string }): Promise<unknown>;
}) {
  await context.exposeBinding(KEY_LABEL, (_, sent) => pageKeyLabel(sent));
  await context.addInitScript({ content: OVERLAY_SCRIPT });
}

/**
 * Waits, up to `timeout` ms, for the pictures in view to finish loading (or
 * failing), so a recording doesn't open on blank cards: a lazy one in view
 * counts from its src, before it has started; one with no src, out of view
 * or not laid out doesn't count. Ones further down load as they're scrolled
 * to. Warns, rather than failing, when they hadn't by then.
 *
 * @returns whether they had
 */
export async function waitForPictures(
  page: {
    waitForFunction(script: string, arg: undefined, options: { timeout: number }): Promise<unknown>;
    isClosed(): boolean;
  },
  timeout = 20_000,
): Promise<boolean> {
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
 * frames on the epoch's clock, which the overlay's ticks share; if a
 * browser ever stamps them otherwise (over 10 s off), frames are placed by
 * the offset to when the first one arrived instead.
 *
 * @param stampMs the first frame's stamp, in ms
 * @param now when it arrived, ms since the epoch
 */
export function clockOffset(stampMs: number, now: number) {
  return Math.abs(now - stampMs) > 10_000 ? now - stampMs : 0;
}

/**
 * Records `clip` (CSS pixels from the viewport's top left) into `dir` until
 * the returned function is called; that resolves once the last frame is
 * written, and throws if the page never painted one within FIRST_FRAME_MS.
 * Frames are thinned to about `fps` a second (timeline.ts's thinner): each
 * frame of motion adds to the GIF's size, and 15 keeps a few seconds of a
 * moving row to a few MB. It writes the kept frames, `frames.ffconcat`, the
 * timeline framesToGif plays (each frame for as long as it was on screen,
 * repeats merged, a long still start and end cut short, stalls cut), and
 * `crop.txt`, which cuts the clip from the whole viewport in the frames' own
 * pixels (a device scale factor of 2 paints twice as many). It warns when the
 * pointer rested outside the clip, where the GIF can't show it. `dir` is
 * emptied first, so an earlier run's frames can't mix in.
 */
export async function recordFrames(
  page: Recordable,
  clip: Clip,
  dir: string,
  { fps = 15, holds = HOLDS }: { fps?: number; holds?: Holds } = {},
): Promise<() => Promise<Recording>> {
  const { screencast } = page;
  if (!screencast) {
    throw new Error(
      "pr-gif records with page.screencast, which the app's Playwright lacks: update it",
    );
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const start = Date.now();
  const shots: Shot[] = [];
  const thin: ReturnType<typeof thinner<{ at: number; image: Buffer }>> = thinner(1000 / fps);
  let sent = 0;
  let offset: number | null = null;
  let first: () => void = () => {};
  const firstFrame: Promise<void> = new Promise((done) => (first = done));
  const keep = (frame: { at: number; image: Buffer } | null) => {
    if (!frame) return;
    const file = frameName(shots.length);
    writeFileSync(path.join(dir, file), frame.image);
    shots.push({ file, at: frame.at, hash: createHash('sha1').update(frame.image).digest('hex') });
  };
  // cli.ts opens every page with a viewport.
  const viewport = page.viewportSize() as { width: number; height: number };
  const density = Number(await page.evaluate('devicePixelRatio'));
  // Playwright rounds the size down to even pixels, so it's asked for what
  // it would round to.
  const even = (n: number) => Math.floor(n * density) & ~1;
  const size = { width: even(viewport.width), height: even(viewport.height) };
  // What was asked for, until the first frame says what came: crop.txt has
  // to cut the frames as they are.
  let frame: { width: number; height: number } = size;
  const onFrame = ({ data, timestamp }: ScreencastFrame) => {
    const now = Date.now();
    if (sent === 0) frame = jpegSize(data) ?? size;
    sent++;
    offset ??= clockOffset(timestamp, now);
    keep(thin.push({ at: timestamp + offset, image: data }));
    first();
  };
  // For the key labels, which keep inside what is recorded, and the ticks,
  // which watch it: set again on each page a scenario loads.
  const setClip = () =>
    page.evaluate(`window.__prGifClip = ${JSON.stringify(clip)}`).catch(() => {});
  page.on('domcontentloaded', setClip);
  await setClip();
  await screencast.start({ onFrame, size, quality: QUALITY });
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
      await screencast.stop().catch(() => {});
      page.off('domcontentloaded', setClip);
    }
    const end = Date.now();
    keep(thin.flush());
    await page.evaluate('delete window.__prGifClip').catch(() => {});
    const ticks = ((await page.evaluate('window.__prGifTicks || []').catch(() => [])) ??
      []) as Tick[];
    const stills = timeline(shots, end, holds, { ticks, frame: 1000 / fps });
    writeFileSync(path.join(dir, 'frames.ffconcat'), concatList(stills));
    writeFileSync(path.join(dir, 'crop.txt'), cropFilter(clip, frame, viewport));
    const moves = ((await page.evaluate('window.__prGifMoves || []').catch(() => [])) ??
      []) as Move[];
    const rests = restsOutside(moves, clip, start, end);
    for (const r of rests) {
      console.warn(
        `pr-gif: the pointer rested out of shot at (${r.x}, ${r.y}) for ${r.ms} ms, ${r.at} ms in; keep it inside the clip`,
      );
    }
    return { sent, stills: stills.length, seconds: (end - start) / 1000, rests };
  };
}
