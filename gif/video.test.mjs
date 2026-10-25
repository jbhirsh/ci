import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PALETTE } from './ffmpeg.mjs';
import {
  END_HOLD_S,
  LEAD_S,
  MIN_CUT_S,
  RING_MIN_PIXELS,
  RING_TOLERANCE,
  TAIL_S,
  TOUCH_AFTER_S,
  TOUCH_JOIN_S,
  TOUCH_LEAD_S,
  activeWindow,
  cutFilter,
  finalDelayCs,
  gifFilter,
  keptStretches,
  keptTimes,
  lastChangeIn,
  parseColor,
  ringPixels,
  touchSpans,
  videoSideBySideFilter,
} from './video.mjs';

/** sift's ring, #E11D48. */
const RING = parseColor('#E11D48');

describe('parseColor', () => {
  it('reads a #rrggbb colour, with or without its #, in either case', () => {
    expect(RING).toEqual([0xe1, 0x1d, 0x48]);
    expect(parseColor('ff3B30')).toEqual([0xff, 0x3b, 0x30]);
    expect(() => parseColor('#fff')).toThrow('not a #rrggbb colour: #fff');
  });
});

describe('keptTimes', () => {
  it("reads the kept frames' times from showinfo's lines and nothing else", () => {
    const stderr = [
      "Input #0, mov,mp4, from 'clip.mov':",
      '[Parsed_showinfo_1 @ 0x6000] n:   0 pts:      0 pts_time:0       duration:512',
      '[Parsed_mpdecimate_0 @ 0x6001] pts_time:9.9 drop',
      '[Parsed_showinfo_1 @ 0x6000] n:   1 pts:  30720 pts_time:2.0667  duration:512',
      '[Parsed_showinfo_1 @ 0x6000] n:   2 pts:  61440 pts_time: 4      duration:512',
      'frame=   3 fps=0.0 q=-0.0 Lsize=N/A time=00:00:06.00',
    ].join('\n');
    expect(keptTimes(stderr)).toEqual([0, 2.0667, 4]);
    expect(keptTimes('')).toEqual([]);
  });
});

describe('activeWindow', () => {
  it('keeps from just before the first change to just after the last', () => {
    expect(activeWindow([0, 2, 2.5, 4], 10)).toEqual({ start: 2 - LEAD_S, end: 4 + TAIL_S });
  });

  it('never reaches past either end of the video', () => {
    expect(activeWindow([0, 0.2, 5.6], 6)).toEqual({ start: 0, end: 6 });
  });

  it('ignores the opening still, so a video that never changes has no window', () => {
    expect(activeWindow([0], 6)).toBeNull();
    expect(activeWindow([], 6)).toBeNull();
    expect(activeWindow([0, 3], 6, 0, 0)).toBeNull();
  });

  it('takes the lead and tail it is given, rounded to the millisecond', () => {
    expect(activeWindow([0, 1.23456, 2], 10, 0.1, 0.2)).toEqual({ start: 1.135, end: 2.2 });
  });
});

describe('finalDelayCs and lastChangeIn', () => {
  it('holds the closing still for as long as it lasted, and no longer', () => {
    expect(finalDelayCs(2, 4)).toBe(200);
    expect(finalDelayCs(2, 3.5)).toBe(150);
    // A clock ticking to the end leaves a short last frame: never stretched.
    expect(finalDelayCs(3.4, 3.5)).toBe(10);
    expect(finalDelayCs(3.5, 3.5)).toBe(0);
    expect(finalDelayCs(4, 3.5)).toBe(0);
  });

  it('finds the last change inside the window, relative to its start', () => {
    const times = [0, 2, 3, 4, 9];
    expect(lastChangeIn(times, { start: 1.5, end: 5 })).toBe(2.5);
    // The opening still at 0 is never a change.
    expect(lastChangeIn([0], { start: 0, end: 5 })).toBe(0);
    expect(lastChangeIn([0, 9], { start: 1, end: 5 })).toBe(0);
  });

  it('counts a change right on either edge of the window as inside it', () => {
    expect(lastChangeIn([0, 2, 5], { start: 2, end: 5 })).toBe(3);
    expect(lastChangeIn([0, 2, 6], { start: 2, end: 5 })).toBe(0);
  });
});

describe('cutting the waits between touches', () => {
  it("counts the ring's pixels, near enough for compression, and never Remove's red", () => {
    /** @param {number[][]} rgb */
    const pixels = (...rgb) => Uint8Array.from(rgb.flat());
    const ring = /** @type {[number, number, number]} */ ([...RING]);
    const blurred = [ring[0] + 10, ring[1] + 12, ring[2] - 8];
    const removeRed = [0xff, 0x3b, 0x30];
    expect(ringPixels(pixels(ring, blurred, removeRed, [255, 255, 255], [0, 0, 0]), RING)).toBe(2);
    expect(ringPixels(pixels([ring[0] + RING_TOLERANCE, ring[1], ring[2]]), RING)).toBe(0);
    expect(ringPixels(new Uint8Array(0), RING)).toBe(0);
  });

  it('finds each touch as a stretch of frames showing the ring', () => {
    const times = [0, 1, 1.1, 1.3, 1.5, 3, 3.1, 5];
    const many = RING_MIN_PIXELS;
    const counts = [0, many, many, many - 1, many, 0, many, many - 1];
    // 1.3 shows too little, but 1.5 is within TOUCH_JOIN_S of 1.1: one drag.
    expect(1.5 - 1.1).toBeLessThanOrEqual(TOUCH_JOIN_S);
    expect(touchSpans(times, counts)).toEqual([
      { start: 1, end: 1.5 },
      { start: 3.1, end: 3.1 },
    ]);
    // Further apart than that, two touches.
    expect(touchSpans([0, 0.6], [many, many])).toEqual([
      { start: 0, end: 0 },
      { start: 0.6, end: 0.6 },
    ]);
    expect(
      touchSpans(
        times,
        counts.map(() => 0),
      ),
    ).toEqual([]);
  });

  it('keeps each touch with a lead-in and its result, the last with a closing hold, and cuts the waits', () => {
    const kept = keptStretches(
      [
        { start: 2, end: 2.5 },
        { start: 8, end: 8.1 },
      ],
      20,
    );
    expect(kept).toEqual([
      { start: 2 - TOUCH_LEAD_S, end: 2.5 + TOUCH_AFTER_S },
      { start: 8 - TOUCH_LEAD_S, end: 8.1 + END_HOLD_S },
    ]);
  });

  it('joins stretches a short wait apart, and stays inside the video', () => {
    const gap = MIN_CUT_S / 2;
    const first = { start: 0.1, end: 1 };
    const second = { start: 1 + TOUCH_AFTER_S + TOUCH_LEAD_S + gap, end: 4 };
    expect(keptStretches([first, second], 4.5)).toEqual([{ start: 0, end: 4.5 }]);
    expect(keptStretches([], 10)).toBeNull();
  });

  it('joins the kept stretches at a steady frame rate', () => {
    expect(
      cutFilter([
        { start: 1, end: 2.5 },
        { start: 6, end: 7 },
      ]),
    ).toBe(
      '[0:v]fps=30,trim=start=1:end=2.5,setpts=PTS-STARTPTS[s0];' +
        '[0:v]fps=30,trim=start=6:end=7,setpts=PTS-STARTPTS[s1];' +
        '[s0][s1]concat=n=2:v=1:a=0[cut]',
    );
  });
});

describe('the ffmpeg filters', () => {
  it('one GIF: frame rate, still frames dropped, scaled sharp, one palette', () => {
    expect(gifFilter({ width: 360, fps: 15 })).toBe(
      `fps=15,mpdecimate,scale=360:-1:flags=lanczos,${PALETTE}`,
    );
  });

  it("side by side: each side cut to its window, labelled, the shorter held to the longer's length", () => {
    const filter = videoSideBySideFilter(
      { width: 720, fps: 15 },
      { start: 1, end: 4 },
      { start: 2, end: 7 },
      "/f/Bold's.ttf",
      2.1667,
    );
    const [left, right, joined] = filter
      .split(';[l][r]')[0]
      .split(';')
      .concat(filter.split(';[l][r]')[1]);
    expect(left).toBe(
      '[0:v]trim=start=1:end=4,setpts=PTS-STARTPTS,fps=15,' +
        // Fitted into one box (360 wide, the taller side's shape), so the
        // two heights always match.
        'scale=360:780:force_original_aspect_ratio=decrease:flags=lanczos,pad=360:780:(ow-iw)/2:(oh-ih)/2,' +
        "drawtext=fontfile='/f/Bold'\\''s.ttf':text='Before':fontsize=22:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8:x=(w-text_w)/2:y=12," +
        'tpad=stop_mode=clone:stop_duration=2[l]',
    );
    expect(right).toContain('[1:v]trim=start=2:end=7,');
    expect(right).toContain("text='After'");
    expect(right).toContain('tpad=stop_mode=clone:stop_duration=0[r]');
    expect(joined).toBe(`hstack=inputs=2,mpdecimate,${PALETTE}`);
  });

  it('side by side with no font file leaves the font to ffmpeg', () => {
    const filter = videoSideBySideFilter(
      { width: 400, fps: 10 },
      { start: 0, end: 1 },
      { start: 0, end: 1 },
      null,
      1.5,
    );
    expect(filter).toContain('scale=200:300:');
    expect(filter).toContain('pad=200:300:');
    expect(filter).toContain("drawtext=text='Before'");
    expect(filter).not.toContain('fontfile');
  });
});

describe('keptStretches, for any touches', () => {
  it('stays inside the video, in order, never overlapping', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 0, max: 60, noNaN: true }), { maxLength: 30 }),
        fc.float({ min: 1, max: 90, noNaN: true }),
        (raw, duration) => {
          const times = [...raw].sort((a, b) => a - b);
          const spans = touchSpans(
            times,
            times.map(() => RING_MIN_PIXELS),
          );
          const kept = keptStretches(spans, duration) ?? [];
          for (const [i, w] of kept.entries()) {
            expect(w.start).toBeGreaterThanOrEqual(0);
            expect(w.end).toBeLessThanOrEqual(Math.round(duration * 1000) / 1000 + 0.001);
            if (i > 0) expect(w.start).toBeGreaterThan(kept[i - 1].end);
          }
        },
      ),
    );
  });
});
