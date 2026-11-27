// Turning a web recording (record.ts's frames, timeline and crop) into a
// GIF with the system's ffmpeg, at the speed the page moved: each frame
// shown for as long as it was on screen, from the concat list recordFrames
// wrote. One palette for the whole clip, and only the changed rectangle
// rewritten per frame, keeps a few seconds of UI to a few hundred KB.
// video.ts builds the same palette into its filters for recorded videos.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { scaledHeight } from './timeline.ts';

export const PALETTE =
  'split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';

const crop = (dir: string) => readFileSync(path.join(dir, 'crop.txt'), 'utf8');

/**
 * The ffmpeg arguments that play each concat list in `inputs` through
 * `filter` into a looping GIF, each frame keeping its own duration (vfr).
 */
export function ffmpegArgs(inputs: readonly string[], filter: string, out: string) {
  const args = ['-y', '-loglevel', 'error'];
  for (const list of inputs) args.push('-f', 'concat', '-safe', '0', '-i', list);
  args.push('-filter_complex', filter, '-fps_mode', 'vfr', '-loop', '0', out);
  return args;
}

function ffmpeg(inputs: readonly string[], filter: string, out: string) {
  mkdirSync(path.dirname(out), { recursive: true });
  execFileSync('ffmpeg', ffmpegArgs(inputs, filter, out), { stdio: 'inherit' });
}

/**
 * Joins the frames recordFrames left in `dir` into a looping GIF at `out`,
 * scaled to `width`: frames recorded at a higher density than the GIF are
 * what keeps it sharp.
 */
export function framesToGif(dir: string, out: string, { width = 600 }: { width?: number } = {}) {
  ffmpeg(
    [path.join(dir, 'frames.ffconcat')],
    `[0:v]${crop(dir)},scale=${width}:-1:flags=lanczos,${PALETTE}`,
    out,
  );
}

// The band each half's label sits in, in GIF pixels.
const LABEL_BAND = 34;

/**
 * The filter that puts two recordings side by side, `width` wide, each under
 * its label, starting together; `crops` are their crop.txt. A change can make
 * the clip taller or shorter: the shorter is padded to the taller, as hstack
 * needs, and the shorter in time holds its last frame until the longer ends
 * (hstack's own way: it ends with the longest input).
 */
export function sideBySideFilter(
  crops: readonly [string, string],
  width: number,
  labels: readonly [string, string] = ['Before', 'After'],
) {
  const half = Math.floor((width - 8) / 4) * 2;
  const heights = crops.map((c) => scaledHeight(c, half));
  const tallest = Math.max(...heights);
  const side = (input: number, label: string) =>
    `[${input}:v]${crops[input]},scale=${half}:${heights[input]}:flags=lanczos,` +
    `pad=iw:${tallest}:0:0:color=white,` +
    `pad=iw:ih+${LABEL_BAND}:0:${LABEL_BAND}:color=0xf3f4f6,` +
    `drawtext=font=Sans:text='${label}':fontsize=18:fontcolor=0x1f2937:x=(w-text_w)/2:y=(${LABEL_BAND}-text_h)/2[s${input}]`;
  return `${side(0, labels[0])};${side(1, labels[1])};[s0]pad=iw+8:ih:0:0:color=white[l];[l][s1]hstack=inputs=2:shortest=0,${PALETTE}`;
}

/**
 * Joins two recordings of the same clip, before and after, into one GIF
 * `width` wide (sideBySideFilter). Two runs of a scenario never keep perfect
 * time, so the halves can drift by a beat. Suits a change to behaviour, seen
 * in one glance; a change to layout reads better as two GIFs, each at full
 * size.
 */
export function sideBySide(
  beforeDir: string,
  afterDir: string,
  out: string,
  { width = 900, labels }: { width?: number; labels?: [string, string] } = {},
) {
  ffmpeg(
    [path.join(beforeDir, 'frames.ffconcat'), path.join(afterDir, 'frames.ffconcat')],
    sideBySideFilter([crop(beforeDir), crop(afterDir)], width, labels),
    out,
  );
}

/**
 * Fails early, before anything is built or recorded, if ffmpeg is missing,
 * or the drawtext filter that side-by-side labels need (ffmpeg built without
 * libfreetype).
 */
export function checkFfmpeg(needsDrawtext: boolean) {
  let filters;
  try {
    filters = execFileSync('ffmpeg', ['-hide_banner', '-filters'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    throw new Error('pr-gif needs ffmpeg on the PATH', { cause: error });
  }
  if (needsDrawtext && !/\sdrawtext\s/.test(filters)) {
    throw new Error(
      "this ffmpeg has no drawtext filter (it's built without libfreetype), which side-by-side labels need",
    );
  }
}
