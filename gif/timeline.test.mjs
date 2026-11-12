import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  HOLDS,
  concatList,
  cropFilter,
  frameName,
  jpegSize,
  keyLabel,
  restsOutside,
  scaledHeight,
  stillTime,
  thinner,
  timeline,
} from './timeline.mjs';

/** @typedef {import('./timeline.mjs').Shot} Shot */
/** @typedef {import('./timeline.mjs').Tick} Tick */

/**
 * @param {number} at
 * @param {string} [hash]
 * @returns {Shot}
 */
const shot = (at, hash = `h${at}`) => ({ file: `f${at}.png`, at, hash });

describe('timeline', () => {
  it('shows each frame until the next came, cutting a long start and end short', () => {
    expect(HOLDS).toEqual({ lead: 500, tail: 1500 });
    expect(timeline([shot(0), shot(900), shot(960), shot(1100)], 4000)).toEqual([
      { file: 'f0.png', ms: 500 },
      { file: 'f900.png', ms: 60 },
      { file: 'f960.png', ms: 140 },
      { file: 'f1100.png', ms: 1500 },
    ]);
  });

  it('holds nothing longer than it was on screen, so motion never freezes', () => {
    expect(timeline([shot(0), shot(70), shot(140)], 210).map((s) => s.ms)).toEqual([70, 70, 70]);
  });

  it('merges a run of identical frames into the first, shown for the whole run', () => {
    expect(
      timeline([shot(0), shot(100, 'a'), shot(160, 'a'), shot(230, 'a'), shot(400)], 1000),
    ).toEqual([
      { file: 'f0.png', ms: 100 },
      { file: 'f100.png', ms: 300 },
      { file: 'f400.png', ms: 600 },
    ]);
  });

  it("rounds to a GIF's hundredths, and never under 20 ms", () => {
    const stills = timeline([shot(0), shot(44), shot(48), shot(100)], 104);
    expect(stills.map((s) => s.ms)).toEqual([40, 20, 50, 20]);
  });

  it('takes its holds from the caller, and is empty with nothing recorded', () => {
    expect(timeline([shot(0), shot(800)], 2000, { lead: 200, tail: 300 }).map((s) => s.ms)).toEqual(
      [200, 300],
    );
    expect(timeline([shot(0)], 700)).toEqual([{ file: 'f0.png', ms: 700 }]);
    expect(timeline([], 100)).toEqual([]);
  });

  it('never shows a frame for under 20 ms or past its hold, whatever the times', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 100_000 }), { maxLength: 40 }), (gaps) => {
        let at = 0;
        const shots = gaps.map((gap, i) => shot((at += gap), `h${i % 3}`));
        const stills = timeline(shots, at + 50);
        for (const { ms } of stills) {
          expect(ms).toBeGreaterThanOrEqual(20);
          expect(ms % 10).toBe(0);
        }
        if (stills.length > 0) expect(stills.at(-1)?.ms).toBeLessThanOrEqual(1500);
      }),
    );
  });
});

describe('stillTime', () => {
  // A tick every 20 ms from 0 to 400, moving from 100 to 200.
  /** @type {Tick[]} */
  const ticks = Array.from({ length: 21 }, (_, i) => ({
    t: i * 20,
    moving: i * 20 > 100 && i * 20 <= 200,
  }));

  it('adds up the stretches between ticks in which nothing moved', () => {
    expect(stillTime(ticks, 0, 400)).toBe(300);
    expect(stillTime(ticks, 100, 200)).toBe(0);
    expect(stillTime(ticks, 150, 300)).toBe(100);
  });

  it('says nothing when no tick falls inside', () => {
    expect(stillTime(ticks, 401, 900)).toBeUndefined();
    expect(stillTime([], 0, 100)).toBeUndefined();
  });
});

describe("timeline, with the page's ticks", () => {
  const frame = 70;
  /**
   * @param {(t: number) => boolean} moving
   * @returns {Tick[]}
   */
  const ticksFor = (moving) =>
    Array.from({ length: 101 }, (_, i) => ({ t: i * 20, moving: moving(i * 20) }));

  it('cuts a stall, a long frame while things kept moving, to one frame', () => {
    const shots = [shot(0), shot(70), shot(140), shot(390), shot(460)];
    const ticks = ticksFor(() => true);
    expect(timeline(shots, 530, undefined, { ticks, frame }).map((s) => s.ms)).toEqual([
      70, 70, 70, 70, 70,
    ]);
  });

  it('keeps a long frame the page was still for, and cuts only the moving part', () => {
    const shots = [shot(0), shot(70), shot(140), shot(1140), shot(1210)];
    // Still from 140 to 1140: a press held, say.
    expect(
      timeline(shots, 1280, undefined, {
        ticks: ticksFor((t) => t <= 140 || t > 1140),
        frame,
      }).map((s) => s.ms),
    ).toEqual([70, 70, 1000, 70, 70]);
    // Moving for its first 300 ms, then still.
    expect(
      timeline(shots, 1280, undefined, {
        ticks: ticksFor((t) => t <= 440 || t > 1140),
        frame,
      }).map((s) => s.ms),
    ).toEqual([70, 70, 770, 70, 70]);
  });

  it('leaves a long frame be when no ticks cover it, and a short one always', () => {
    const shots = [shot(0), shot(70), shot(140), shot(3000)];
    const early = ticksFor(() => true).filter(({ t }) => t <= 140);
    expect(timeline(shots, 3070, undefined, { ticks: early, frame }).map((s) => s.ms)).toEqual([
      70, 70, 2860, 70,
    ]);
    expect(
      timeline([shot(0), shot(130), shot(200)], 270, undefined, {
        ticks: ticksFor(() => true),
        frame,
      }).map((s) => s.ms),
    ).toEqual([130, 70, 70]);
  });
});

describe('frameName', () => {
  it('numbers frames to four digits', () => {
    expect(frameName(0)).toBe('f0000.jpg');
    expect(frameName(42)).toBe('f0042.jpg');
    expect(frameName(1234)).toBe('f1234.jpg');
  });
});

describe('concatList', () => {
  it('gives each frame its duration at 100 a second, listing the last once more for ffmpeg to honour its own', () => {
    expect(
      concatList([
        { file: 'f0.png', ms: 500 },
        { file: 'f1.png', ms: 70 },
      ]),
    ).toBe(
      'ffconcat version 1.0\n' +
        "file 'f0.png'\noption framerate 100\nduration 0.500\n" +
        "file 'f1.png'\noption framerate 100\nduration 0.070\n" +
        "file 'f1.png'\noption framerate 100\n",
    );
    expect(concatList([])).toBe('ffconcat version 1.0\n');
  });
});

describe('thinner', () => {
  /**
   * Feeds frames at the given times, returning the times of those kept.
   *
   * @param {number[]} times
   * @param {number} [gap]
   */
  function keep(times, gap = 40) {
    /** @type {ReturnType<typeof thinner<{ at: number }>>} */
    const thin = thinner(gap);
    const kept = times.map((at) => thin.push({ at })).concat(thin.flush());
    return kept.flatMap((f) => (f ? [f.at] : []));
  }

  it('keeps about one frame per gap of a steady stream', () => {
    expect(keep([0, 17, 33, 50, 67, 83, 100])).toEqual([0, 50, 100]);
  });

  it('keeps the frame a movement settles on, however soon it came', () => {
    expect(keep([0, 10, 400])).toEqual([0, 10, 400]);
  });

  it('drops a frame painted no later than the one before it', () => {
    expect(keep([0, 50, 40, 50, 100])).toEqual([0, 50, 100]);
  });

  it('keeps the last frame, and has nothing to flush when nothing came', () => {
    expect(keep([0, 5])).toEqual([0, 5]);
    expect(thinner().flush()).toBeNull();
  });

  it('keeps frames in the order they were painted, and at least one', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5000 }), { minLength: 1, maxLength: 60 }),
        (raw) => {
          const kept = keep(raw);
          for (let i = 1; i < kept.length; i++) expect(kept[i]).toBeGreaterThan(kept[i - 1]);
          expect(kept.length).toBeGreaterThan(0);
        },
      ),
    );
  });
});

describe('jpegSize', () => {
  it('reads the frame header, past the segments before it, from a slice too', () => {
    const jpeg = Uint8Array.from([
      0, 0xff, 0xd8, 0xff, 0xe0, 0x00, 0x06, 0xff, 0xc0, 0x00, 0x00, 0xff, 0xff, 0xc2, 0x00, 0x11,
      0x08, 0x06, 0xd4, 0x03, 0x24, 0x03,
    ]);
    // The APP0 segment's bytes look like a header; its length skips them.
    expect(jpegSize(jpeg.subarray(1))).toEqual({ width: 804, height: 1748 });
  });

  it('finds none in what is not a JPEG, or has no header before the image data', () => {
    expect(jpegSize(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(jpegSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08]))).toBeNull();
    expect(jpegSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]))).toBeNull();
    expect(jpegSize(new Uint8Array(0))).toBeNull();
  });
});

describe('cropFilter', () => {
  it("cuts the clip from a frame at the frame's scale, in whole pixels", () => {
    const viewport = { width: 1100, height: 640 };
    expect(cropFilter({ x: 0, y: 133.4, width: 900, height: 254.6 }, viewport, viewport)).toBe(
      'crop=900:255:0:133',
    );
    expect(
      cropFilter(
        { x: 10, y: 20, width: 300, height: 200 },
        { width: 2200, height: 1280 },
        viewport,
      ),
    ).toBe('crop=600:400:20:40');
  });

  it('scales each axis on its own, when rounding to even pixels cut one more than the other', () => {
    // 400 x 874 at 1.25 is 500 x 1092.5, sent as 500 x 1092.
    const viewport = { width: 400, height: 874 };
    expect(cropFilter({ x: 0, y: 0, ...viewport }, { width: 500, height: 1092 }, viewport)).toBe(
      'crop=500:1092:0:0',
    );
  });

  it('never reaches past the frame, however the clip rounds', () => {
    const viewport = { width: 100, height: 100 };
    const frame = { width: 150, height: 150 };
    // 33.4 and 66.7 at 1.5 round to 50 and 100: one past the edge.
    expect(cropFilter({ x: 33.4, y: 33.4, width: 66.7, height: 66.7 }, frame, viewport)).toBe(
      'crop=100:100:50:50',
    );
  });
});

describe('scaledHeight', () => {
  it('keeps the aspect ratio, in even pixels', () => {
    expect(scaledHeight('crop=900:254:0:133', 496)).toBe(140);
    expect(scaledHeight('crop=900:255:0:133', 450)).toBe(128);
    expect(scaledHeight('crop=900:1:0:0', 100)).toBe(2);
  });
});

describe('restsOutside', () => {
  const clip = { x: 0, y: 100, width: 900, height: 200 };

  it('finds the pointer resting out of shot, from when recording started to when it moved on', () => {
    const moves = [
      { x: 450, y: 200, t: 1000 }, // in shot
      { x: 450, y: 500, t: 2000 }, // under the clip, for 800 ms
      { x: 450, y: 200, t: 2800 },
      { x: 10, y: 20, t: 3000 }, // over it, until the end
    ];
    expect(restsOutside(moves, clip, 500, 4000)).toEqual([
      { x: 450, y: 500, at: 1500, ms: 800 },
      { x: 10, y: 20, at: 2500, ms: 1000 },
    ]);
  });

  it('ignores a short pass out of shot, and a rest that ended before recording started', () => {
    const moves = [
      { x: 450, y: 900, t: 0 },
      { x: 450, y: 200, t: 600 },
      { x: 450, y: 900, t: 1000 },
      { x: 450, y: 200, t: 1300 },
    ];
    expect(restsOutside(moves, clip, 700, 2000)).toEqual([]);
  });

  it('counts a rest that began before recording only from its start, and an edge as in shot', () => {
    expect(restsOutside([{ x: 950, y: 200, t: 0 }], clip, 1000, 1400)).toEqual([]);
    expect(restsOutside([{ x: 950, y: 200, t: 0 }], clip, 1000, 1600)).toEqual([
      { x: 950, y: 200, at: 0, ms: 600 },
    ]);
    expect(restsOutside([{ x: 900, y: 300, t: 0 }], clip, 0, 5000)).toEqual([]);
  });

  it('finds nothing before the pointer first moves', () => {
    expect(restsOutside([], clip, 0, 5000)).toEqual([]);
  });
});

describe('keyLabel', () => {
  /**
   * @param {string} key
   * @param {Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }>} [mods]
   */
  const press = (key, mods = {}) =>
    keyLabel({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods });

  it('names keys as a keyboard does', () => {
    expect(press('Tab')).toBe('Tab');
    expect(press('Enter')).toBe('Enter');
    expect(press(' ')).toBe('Space');
    expect(press('ArrowRight')).toBe('→');
    expect(press('ArrowLeft')).toBe('←');
    expect(press('ArrowUp')).toBe('↑');
    expect(press('ArrowDown')).toBe('↓');
    expect(press('Escape')).toBe('Esc');
  });

  it('shows a character as typed, Shift and all', () => {
    expect(press('c')).toBe('c');
    expect(press('C', { shiftKey: true })).toBe('C');
    expect(press('?', { shiftKey: true })).toBe('?');
  });

  it('names the modifiers of a shortcut, with its letter a capital', () => {
    expect(press('Tab', { shiftKey: true })).toBe('Shift+Tab');
    expect(press('k', { ctrlKey: true })).toBe('Ctrl+K');
    expect(press('K', { metaKey: true, shiftKey: true })).toBe('Meta+Shift+K');
    expect(press('K', { ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+K');
    expect(press('ArrowLeft', { altKey: true })).toBe('Alt+←');
  });

  it('names nothing for a modifier on its own', () => {
    for (const key of ['Shift', 'Control', 'Alt', 'Meta']) {
      expect(press(key, { shiftKey: true })).toBeNull();
    }
  });

  it('never throws, and names something for any key but a modifier', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 12 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (key, shiftKey, ctrlKey, altKey, metaKey) => {
          const label = keyLabel({ key, shiftKey, ctrlKey, altKey, metaKey });
          const modifier = ['Shift', 'Control', 'Alt', 'Meta'].includes(key);
          expect(label === null).toBe(modifier);
        },
      ),
    );
  });
});
