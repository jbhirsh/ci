// The pure half of the web recorder (record.mjs): turning a recording's
// frames into a GIF's timeline, spotting a pointer left outside the recorded
// area, and naming a key press for the overlay. No browser, no ffmpeg, no
// files, so all of it is unit tested.

/**
 * @typedef {object} Clip The part of the viewport recorded, in CSS pixels.
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {object} Shot A frame kept while recording: its file, when it was painted (ms), and a hash of its pixels.
 * @property {string} file
 * @property {number} at
 * @property {string} hash
 */

/**
 * @typedef {object} Still A frame of the GIF and how long it shows, in ms.
 * @property {string} file
 * @property {number} ms
 */

/**
 * @typedef {object} Holds The most the GIF dwells on its first and last frames, in ms.
 * @property {number} lead
 * @property {number} tail
 */

/**
 * @typedef {object} Tick One of the page's animation frames, as the overlay saw it: when (ms), and whether anything in the recorded area moved since the frame before (an animation or transition running there, the pointer, a key, the wheel).
 * @property {number} t
 * @property {boolean} moving
 */

/**
 * @typedef {object} Move A pointer position the overlay saw, at a time in ms.
 * @property {number} x
 * @property {number} y
 * @property {number} t
 */

/**
 * @typedef {object} Rest A stretch of the recording with the pointer still, outside the clip.
 * @property {number} x
 * @property {number} y
 * @property {number} at ms from the start of the recording
 * @property {number} ms
 */

/** @type {Holds} */
export const HOLDS = { lead: 500, tail: 1500 };

// Browsers show a GIF frame of under 20 ms for 100 ms, so a brief frame
// would stall the clip rather than flash by. GIF delays are whole
// hundredths of a second.
const MIN_MS = 20;
const TICK = 10;

/**
 * How long, of `from` to `to`, the page was still by its ticks (in time
 * order): the stretches between ticks in which nothing moved. Undefined
 * when no tick falls inside, as nothing then says either way.
 *
 * @param {readonly Tick[]} ticks
 * @param {number} from
 * @param {number} to
 * @returns {number | undefined}
 */
export function stillTime(ticks, from, to) {
  let still = 0;
  let previous = from;
  let seen = false;
  for (const { t, moving } of ticks) {
    if (t <= from) continue;
    if (t > to) break;
    if (!moving) still += t - previous;
    previous = t;
    seen = true;
  }
  return seen ? still : undefined;
}

/**
 * The GIF's frames from the recording, each shown until the next was
 * painted, so the clip plays at the speed the page moved however unevenly
 * the frames came.
 *   - Stalls are cut. Chrome sometimes paints nothing for a quarter-second
 *     on a busy machine while things are still moving, and the GIF would
 *     freeze there and then jump. A frame lasting over twice `frame` (the
 *     usual gap between frames kept) shows only for the time the page's
 *     `ticks` say it was still, plus one `frame`; without ticks, as long as
 *     it lasted.
 *   - A run of identical frames becomes one frame, shown for the run's
 *     whole time.
 *   - Nothing is held longer than it was on screen, so a page in motion
 *     never freezes. The first frame shows for at most `lead` (a still
 *     page before anything happens is dead air), and the last for at most
 *     `tail` (a beat before the loop starts again: a scenario that ends
 *     with a pause holds there).
 * `end` is when recording stopped. Durations round to a GIF's hundredths;
 * none is under 20 ms.
 *
 * @param {readonly Shot[]} shots
 * @param {number} end
 * @param {Holds} [holds]
 * @param {{ ticks?: readonly Tick[]; frame?: number }} [options]
 * @returns {Still[]}
 */
export function timeline(shots, end, holds = HOLDS, { ticks = [], frame = 1000 / 15 } = {}) {
  /** @type {{ file: string; hash: string; ms: number }[]} */
  const runs = [];
  shots.forEach((shot, i) => {
    const until = i + 1 < shots.length ? shots[i + 1].at : end;
    let ms = until - shot.at;
    const still = ms > 2 * frame ? stillTime(ticks, shot.at, until) : undefined;
    if (still !== undefined) ms = Math.min(ms, still + frame);
    const run = runs.at(-1);
    if (run?.hash === shot.hash) run.ms += ms;
    else runs.push({ file: shot.file, hash: shot.hash, ms });
  });
  return runs.map((run, i) => {
    let ms = run.ms;
    if (i === runs.length - 1) ms = Math.min(ms, holds.tail);
    else if (i === 0) ms = Math.min(ms, holds.lead);
    return { file: run.file, ms: Math.max(MIN_MS, Math.round(ms / TICK) * TICK) };
  });
}

/**
 * Thins a stream of frames to about one per `gap` ms, deciding on each as
 * the next arrives. Chrome's screencast sends one per repaint, up to 60 a
 * second: more than a GIF needs, and each kept frame costs its size. A
 * frame is kept if it came at least `gap` after the last one kept, or if it
 * stayed on screen at least `gap` (the next came that much later, or none
 * did): so the frame a movement settles on is never dropped, however soon
 * after the one before it came. push() takes each frame as it arrives and
 * returns the one before it if that one is kept; flush() returns the last.
 * Now and then the screencast sends a frame painted no later than the one
 * before it; shown after it, the GIF would flick back, so it is dropped.
 *
 * @template {{ at: number }} F
 * @param {number} [gap]
 * @returns {{ push(frame: F): F | null; flush(): F | null }}
 */
export function thinner(gap = 40) {
  /** @type {F | null} */
  let pending = null;
  let kept = -Infinity;
  /** @param {number} next */
  const decide = (next) => {
    const frame = pending;
    if (!frame || (next - frame.at < gap && frame.at - kept < gap)) return null;
    kept = frame.at;
    return frame;
  };
  return {
    push(frame) {
      if (pending && frame.at <= pending.at) return null;
      const done = decide(frame.at);
      pending = frame;
      return done;
    },
    flush() {
      const done = decide(Infinity);
      pending = null;
      return done;
    },
  };
}

/**
 * A kept frame's file name: f0000.png, f0001.png, …
 *
 * @param {number} n
 */
export function frameName(n) {
  return `f${String(n).padStart(4, '0')}.png`;
}

/**
 * The timeline as an ffmpeg concat list, which gives each frame its own
 * duration. Each image is read at 100 frames a second, a GIF's hundredths:
 * at the image reader's default 25, every duration would snap to 40 ms
 * steps. The demuxer ignores the last entry's duration unless the file is
 * listed once more after it, so it is.
 *
 * @param {readonly Still[]} stills
 */
export function concatList(stills) {
  const lines = ['ffconcat version 1.0'];
  /** @param {string} name */
  const file = (name) => [`file '${name}'`, 'option framerate 100'];
  for (const { file: name, ms } of stills) {
    lines.push(...file(name), `duration ${(ms / 1000).toFixed(3)}`);
  }
  const last = stills.at(-1);
  if (last) lines.push(...file(last.file));
  return `${lines.join('\n')}\n`;
}

/**
 * A PNG's size in pixels, from its header.
 *
 * @param {Uint8Array} png
 */
export function pngSize(png) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The ffmpeg crop that cuts `clip` (CSS pixels) from a frame of the whole
 * viewport `scale` times its size (the device scale factor), whole pixels.
 *
 * @param {Clip} clip
 * @param {number} scale
 */
export function cropFilter(clip, scale) {
  /** @param {number} n */
  const px = (n) => Math.round(n * scale);
  return `crop=${px(clip.width)}:${px(clip.height)}:${px(clip.x)}:${px(clip.y)}`;
}

/**
 * The height, in whole even pixels as ffmpeg's video wants, of a frame cut
 * by `crop` (a cropFilter) once scaled to `width`.
 *
 * @param {string} crop
 * @param {number} width
 */
export function scaledHeight(crop, width) {
  const [w, h] = crop.replace('crop=', '').split(':').map(Number);
  return Math.max(2, Math.round((h * width) / w / 2) * 2);
}

/**
 * Where the pointer sat still outside the recorded area for at least `min`
 * ms between `start` and `end`, so the GIF lost sight of it. Before its
 * first move the pointer is nowhere the overlay can draw, so that doesn't
 * count.
 *
 * @param {readonly Move[]} moves
 * @param {Clip} clip
 * @param {number} start
 * @param {number} end
 * @param {number} [min]
 * @returns {Rest[]}
 */
export function restsOutside(moves, clip, start, end, min = 500) {
  /** @param {Move} move */
  const inside = ({ x, y }) =>
    x >= clip.x && x <= clip.x + clip.width && y >= clip.y && y <= clip.y + clip.height;
  /** @type {Rest[]} */
  const rests = [];
  moves.forEach((move, i) => {
    const from = Math.max(move.t, start);
    const to = Math.min(i + 1 < moves.length ? moves[i + 1].t : end, end);
    if (to - from >= min && !inside(move)) {
      rests.push({ x: move.x, y: move.y, at: from - start, ms: to - from });
    }
  });
  return rests;
}

/**
 * @typedef {object} KeyPress The parts of a keydown the overlay names.
 * @property {string} key
 * @property {boolean} shiftKey
 * @property {boolean} ctrlKey
 * @property {boolean} altKey
 * @property {boolean} metaKey
 */

/**
 * How the overlay labels a key press: "Tab", "Shift+Tab", "→", "Space", a
 * character as typed ("c", "C", "?"), "Ctrl+K", "Ctrl+Shift+K". On its
 * own, a character already shows Shift (a capital, "?"), so it isn't named;
 * in a shortcut it is, and a letter is a capital, as shortcuts are written.
 * A modifier on its own names nothing: it shows with the key it modifies.
 * The overlay inlines this function's source, so it must stay
 * self-contained.
 *
 * @param {KeyPress} e
 * @returns {string | null}
 */
export function keyLabel(e) {
  /** @type {Record<string, string>} */
  const names = {
    ' ': 'Space',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Escape: 'Esc',
  };
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return null;
  const printable = e.key.length === 1 && e.key !== ' ';
  const chord = e.ctrlKey || e.altKey || e.metaKey;
  const mods = [
    e.ctrlKey && 'Ctrl',
    e.altKey && 'Alt',
    e.metaKey && 'Meta',
    e.shiftKey && (chord || !printable) && 'Shift',
  ].filter(Boolean);
  const name = names[e.key] ?? (printable && chord ? e.key.toUpperCase() : e.key);
  return [...mods, name].join('+');
}
