import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ffmpeg itself isn't run here: what's asked of it is checked instead.
const exec = vi.hoisted(
  () =>
    /** @type {import('vitest').Mock<(cmd: string, args: string[], options?: object) => string>} */ (
      vi.fn(() => '')
    ),
);
vi.mock('node:child_process', () => ({ execFileSync: exec }));

const { PALETTE, checkFfmpeg, ffmpegArgs, framesToGif, sideBySide, sideBySideFilter } =
  await import('./ffmpeg.mjs');

/** @param {string} crop */
function recording(crop) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gif-ffmpeg-'));
  writeFileSync(path.join(dir, 'crop.txt'), crop);
  writeFileSync(path.join(dir, 'frames.ffconcat'), 'ffconcat version 1.0\n');
  return dir;
}

beforeEach(() => exec.mockClear());

describe('ffmpegArgs', () => {
  it('reads each concat list at its own durations, and writes a looping GIF with them', () => {
    expect(ffmpegArgs(['a.ffconcat', 'b.ffconcat'], 'FILTER', 'out.gif')).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      'a.ffconcat',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      'b.ffconcat',
      '-filter_complex',
      'FILTER',
      '-fps_mode',
      'vfr',
      '-loop',
      '0',
      'out.gif',
    ]);
  });
});

describe('framesToGif', () => {
  it('cuts the clip, scales down sharp, shares one palette, making the GIF’s folder first', () => {
    const dir = recording('crop=2200:1120:0:160');
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'gif-out-')), 'pics', 'after.gif');
    framesToGif(dir, out, { width: 480 });
    expect(exec).toHaveBeenCalledWith(
      'ffmpeg',
      ffmpegArgs(
        [path.join(dir, 'frames.ffconcat')],
        `[0:v]crop=2200:1120:0:160,scale=480:-1:flags=lanczos,${PALETTE}`,
        out,
      ),
      { stdio: 'inherit' },
    );
    framesToGif(dir, out);
    expect(exec.mock.calls[1][1]).toContain(
      `[0:v]crop=2200:1120:0:160,scale=600:-1:flags=lanczos,${PALETTE}`,
    );
  });
});

describe('sideBySideFilter', () => {
  it('labels each half, pads the shorter to the taller, and stacks them 8px apart', () => {
    expect(sideBySideFilter(['crop=900:254:0:133', 'crop=900:300:0:133'], 1000).split(';')).toEqual(
      [
        "[0:v]crop=900:254:0:133,scale=496:140:flags=lanczos,pad=iw:166:0:0:color=white,pad=iw:ih+34:0:34:color=0xf3f4f6,drawtext=font=Sans:text='Before':fontsize=18:fontcolor=0x1f2937:x=(w-text_w)/2:y=(34-text_h)/2[s0]",
        "[1:v]crop=900:300:0:133,scale=496:166:flags=lanczos,pad=iw:166:0:0:color=white,pad=iw:ih+34:0:34:color=0xf3f4f6,drawtext=font=Sans:text='After':fontsize=18:fontcolor=0x1f2937:x=(w-text_w)/2:y=(34-text_h)/2[s1]",
        '[s0]pad=iw+8:ih:0:0:color=white[l]',
        '[l][s1]hstack=inputs=2:shortest=0,split[a][b]',
        '[a]palettegen=max_colors=96:stats_mode=diff[p]',
        '[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
      ],
    );
    expect(sideBySideFilter(['crop=10:10:0:0', 'crop=10:10:0:0'], 500, ['main', 'PR'])).toContain(
      "text='PR'",
    );
  });
});

describe('sideBySide', () => {
  it('joins two recordings, each cut to its own clip', () => {
    const before = recording('crop=900:400:0:80');
    const after = recording('crop=1800:800:0:160');
    const out = path.join(before, 'side.gif');
    sideBySide(before, after, out, { width: 812 });
    expect(exec).toHaveBeenCalledWith(
      'ffmpeg',
      ffmpegArgs(
        [path.join(before, 'frames.ffconcat'), path.join(after, 'frames.ffconcat')],
        sideBySideFilter(['crop=900:400:0:80', 'crop=1800:800:0:160'], 812),
        out,
      ),
      { stdio: 'inherit' },
    );
    sideBySide(before, after, out);
    expect(exec.mock.calls[1][1]).toContain(
      sideBySideFilter(['crop=900:400:0:80', 'crop=1800:800:0:160'], 900),
    );
  });
});

describe('checkFfmpeg', () => {
  it('passes an ffmpeg with drawtext, or without it when no labels are needed', () => {
    exec.mockReturnValueOnce(' T.C drawtext   V->V  Draw text\n');
    expect(() => checkFfmpeg(true)).not.toThrow();
    exec.mockReturnValueOnce(' ... scale  V->V\n');
    expect(() => checkFfmpeg(false)).not.toThrow();
  });

  it('fails on a missing ffmpeg, or one without drawtext for side-by-side labels', () => {
    exec.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    expect(() => checkFfmpeg(false)).toThrow('pr-gif needs ffmpeg on the PATH');
    exec.mockReturnValueOnce(' ... scale  V->V\n');
    expect(() => checkFfmpeg(true)).toThrow('no drawtext filter');
  });
});
