// The pure half of turning a recorded video into a GIF (videos.mjs): for an
// app whose CI records its scenarios as videos (sift's iOS Simulator runs,
// with each touch drawn as a ring), not frames from a browser.
//
// - Real speed: the video is real time. Repeated still frames are dropped
//   (mpdecimate) but each kept frame keeps its own timestamp, and the GIF is
//   written with variable frame timing, so a pause lasts as long as it did.
// - Waits cut: a recording spends most of its time on the test driver
//   finding the next element (a playing clock keeps the screen from ever
//   settling, so it waits out its timeouts). The touches are found by the
//   drawn ring's colour, and only the time around each (TOUCH_LEAD_S before,
//   TOUCH_AFTER_S after, to see what it did) is kept; the waits between are
//   cut. A recording with no ring keeps its whole length, idle ends trimmed.
// - Idle ends trimmed: the GIF keeps from LEAD_S before the first change on
//   screen to TAIL_S after the last. No frame is held longer than it was on
//   screen: a forced hold freezes whatever moves (a playback clock) and
//   reads as a stutter at the loop. A scenario that wants a still ending
//   ends on a pause.
// - Sharp: a Simulator records at its native 3x; scaling down with lanczos
//   keeps text crisp.
// - Small: one palette for the whole clip (ffmpeg.mjs's PALETTE).

import { PALETTE } from './ffmpeg.mjs';

export const LEAD_S = 0.5;
export const TAIL_S = 1;
/** How close a recorded pixel must be to the ring's colour to count (see ringPixels). */
export const RING_TOLERANCE = 28;
/** A frame shows a touch once this many ring pixels show, at 1/3 scale. */
export const RING_MIN_PIXELS = 30;
/** Kept before a touch, and after it (to see what it did). */
export const TOUCH_LEAD_S = 0.4;
export const TOUCH_AFTER_S = 1.2;
/** Kept after the last touch: the end holds a moment before the loop. */
export const END_HOLD_S = 1.5;
/** Touch frames closer than this are one touch (a drag, a ring fading). */
export const TOUCH_JOIN_S = 0.5;
/** A wait shorter than this between kept stretches isn't worth a cut. */
export const MIN_CUT_S = 0.6;

/**
 * @typedef {object} Window A stretch of a video, in seconds.
 * @property {number} start
 * @property {number} end
 */

/**
 * @typedef {object} GifOptions
 * @property {number} width
 * @property {number} fps
 */

/** @param {number} n */
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * The timestamps (s) of the frames mpdecimate kept, from ffmpeg's stderr
 * with `showinfo` after it: the first frame, then each one that changed.
 *
 * @param {string} stderr
 */
export function keptTimes(stderr) {
  return [...stderr.matchAll(/Parsed_showinfo\S*\s.*?pts_time:\s*([\d.]+)/g)].map((m) =>
    Number(m[1]),
  );
}

/**
 * The part of the video worth keeping: from just before the first change
 * on screen to just after the last. Null when nothing ever changed.
 *
 * @param {readonly number[]} times
 * @param {number} duration
 * @param {number} [lead]
 * @param {number} [tail]
 * @returns {Window | null}
 */
export function activeWindow(times, duration, lead = LEAD_S, tail = TAIL_S) {
  // The first kept frame is the opening still, not a change.
  const changes = times.slice(1);
  if (changes.length === 0) return null;
  const start = Math.max(0, changes[0] - lead);
  const end = Math.min(duration, changes[changes.length - 1] + tail);
  return end > start ? { start: round3(start), end: round3(end) } : null;
}

/**
 * How long (centiseconds) the GIF's last frame should stay up: as long as
 * it was on screen. A GIF gets a frame's length from the next frame's
 * start, so the closing still (from the last change to the end) would
 * otherwise flash by: ffmpeg's -final_delay holds it. Times are relative to
 * the GIF's start.
 *
 * @param {number} lastChange
 * @param {number} end
 */
export function finalDelayCs(lastChange, end) {
  return Math.max(0, Math.round((end - lastChange) * 100));
}

/**
 * The last change on screen inside a window, relative to its start.
 *
 * @param {readonly number[]} times
 * @param {Window} window
 */
export function lastChangeIn(times, window) {
  const inside = times.slice(1).filter((t) => t >= window.start && t <= window.end);
  return round3((inside.length > 0 ? inside[inside.length - 1] : window.start) - window.start);
}

/**
 * The colour a `#rrggbb` setting names, as [r, g, b].
 *
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function parseColor(hex) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

/**
 * How many pixels of an RGB frame are the drawn ring's colour `ring`, within
 * `tolerance` (sift's ring, #E11D48, and its Remove red, #FF3B30, are about
 * 48 apart, so 28 keeps the red out while the video's compression keeps the
 * ring in).
 *
 * @param {Uint8Array} rgb
 * @param {readonly [number, number, number]} ring
 * @param {number} [tolerance]
 */
export function ringPixels(rgb, ring, tolerance = RING_TOLERANCE) {
  const [r, g, b] = ring;
  const limit = tolerance * tolerance;
  let count = 0;
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const dr = rgb[i] - r;
    const dg = rgb[i + 1] - g;
    const db = rgb[i + 2] - b;
    if (dr * dr + dg * dg + db * db < limit) count += 1;
  }
  return count;
}

/**
 * The stretches of the video where a touch shows, from each frame's ring count.
 *
 * @param {readonly number[]} times
 * @param {readonly number[]} counts
 * @param {number} [minPixels]
 * @returns {Window[]}
 */
export function touchSpans(times, counts, minPixels = RING_MIN_PIXELS) {
  /** @type {Window[]} */
  const spans = [];
  times.forEach((t, i) => {
    if (counts[i] < minPixels) return;
    const last = spans[spans.length - 1];
    if (last && t - last.end <= TOUCH_JOIN_S) last.end = t;
    else spans.push({ start: t, end: t });
  });
  return spans;
}

/**
 * The stretches to keep: each touch with TOUCH_LEAD_S before and
 * TOUCH_AFTER_S after (END_HOLD_S after the last), joined where the wait
 * between them is shorter than MIN_CUT_S. Null when there's no touch.
 *
 * @param {readonly Window[]} spans
 * @param {number} duration
 * @returns {Window[] | null}
 */
export function keptStretches(spans, duration) {
  if (spans.length === 0) return null;
  /** @type {Window[]} */
  const kept = [];
  spans.forEach((span, i) => {
    const after = i === spans.length - 1 ? END_HOLD_S : TOUCH_AFTER_S;
    const next = {
      start: Math.max(0, span.start - TOUCH_LEAD_S),
      end: Math.min(duration, span.end + after),
    };
    const last = kept[kept.length - 1];
    if (last && next.start - last.end < MIN_CUT_S) last.end = Math.max(last.end, next.end);
    else kept.push(next);
  });
  return kept.map((w) => ({ start: round3(w.start), end: round3(w.end) }));
}

/**
 * An ffmpeg filter graph joining the kept stretches of input 0 into [cut].
 * A Simulator records a frame only when the screen changes, so each stretch
 * is first made a steady frame rate: cut as it is, one would end at its last
 * change and lose the still time after it.
 *
 * @param {readonly Window[]} stretches
 */
export function cutFilter(stretches) {
  const parts = stretches.map(
    (w, i) => `[0:v]fps=30,trim=start=${w.start}:end=${w.end},setpts=PTS-STARTPTS[s${i}]`,
  );
  const inputs = stretches.map((_, i) => `[s${i}]`).join('');
  return `${parts.join(';')};${inputs}concat=n=${stretches.length}:v=1:a=0[cut]`;
}

/**
 * One video to one GIF: real timing, still frames dropped, scaled sharp.
 *
 * @param {GifOptions} options
 */
export function gifFilter({ width, fps }) {
  return `fps=${fps},mpdecimate,scale=${width}:-1:flags=lanczos,${PALETTE}`;
}

/**
 * A label drawn across the top of a side of the side-by-side GIF.
 *
 * @param {string} text
 * @param {string | null} fontfile
 */
function label(text, fontfile) {
  const font = fontfile ? `fontfile='${fontfile.replace(/'/g, "'\\''")}':` : '';
  return `drawtext=${font}text='${text}':fontsize=22:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8:x=(w-text_w)/2:y=12`;
}

/**
 * Before and after next to each other, labelled, playing in step: each
 * side is cut to its own active window and the shorter one holds its last
 * frame until the longer one ends. `aspect` is the taller recording's
 * height over its width: both sides are fitted into that box, as hstack
 * needs equal heights (recordings from different simulators differ).
 *
 * @param {GifOptions} options
 * @param {Window} before
 * @param {Window} after
 * @param {string | null} fontfile
 * @param {number} aspect
 */
export function videoSideBySideFilter({ width, fps }, before, after, fontfile, aspect) {
  const half = Math.round(width / 2);
  const height = 2 * Math.round((half * aspect) / 2);
  /** @param {Window} w */
  const length = (w) => w.end - w.start;
  const longest = Math.max(length(before), length(after));
  /**
   * @param {number} input
   * @param {Window} w
   * @param {string} text
   * @param {string} out
   */
  const side = (input, w, text, out) =>
    `[${input}:v]trim=start=${w.start}:end=${w.end},setpts=PTS-STARTPTS,fps=${fps},` +
    `scale=${half}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${half}:${height}:(ow-iw)/2:(oh-ih)/2,${label(text, fontfile)},` +
    `tpad=stop_mode=clone:stop_duration=${round3(longest - length(w))}[${out}]`;
  return [
    side(0, before, 'Before', 'l'),
    side(1, after, 'After', 'r'),
    `[l][r]hstack=inputs=2,mpdecimate,${PALETTE}`,
  ].join(';');
}
