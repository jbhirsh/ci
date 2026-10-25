// The web recorder's command line (cli.mjs), read without side effects.
//
//   <scenario>            the scenario module, from the app's root
//   --dir <folder>        publish: commit the GIFs to the pictures branch under
//                         <folder>/ (the PR's number), push, and print the
//                         table for the PR description. Without it, the GIFs
//                         are only written to pr-gif/<scenario name>/.
//   --no-push             with --dir: commit, but leave pushing to you
//   --base <ref>          what "before" is built from (origin/main); a
//                         remote's ref is fetched first
//   --after-only          only "after", for UI that's new: nothing before
//   --side-by-side        one GIF of the two side by side, labelled, rather
//                         than two
//   --width <px>          each GIF's width, over the scenario's (or the
//                         window's up to 700; side by side, two of those, each
//                         up to 496)
//   --fps <n>             the most frames a second kept (the gif.fps setting)
//   --scale <n>           device pixels per CSS pixel (the gif.scale setting)
//   --mode <mode>         the Vite build mode (the gif.build.mode setting)
//   --chromium <path>     a Chromium to use (or PR_GIF_CHROMIUM, or
//                         PLAYWRIGHT_CHROMIUM_EXECUTABLE), if Playwright's own
//                         isn't installed
//   --branch <name>       the pictures branch (the gif.branch setting)
//   --repo <owner/name>   for the links (from the origin remote)
//   --keep                keep the work directory (builds, frames) to look at
// and whatever options the app's setup module adds (scenario.mjs).

import { parseArgs } from 'node:util';

/** @typedef {import('./settings.mjs').GifSettings} GifSettings */
/** @typedef {Record<string, { type: 'boolean' | 'string'; default?: boolean | string }>} OptionSpecs */

/**
 * @typedef {object} Options What cli.mjs was asked to do.
 * @property {string} scenario
 * @property {string | undefined} dir
 * @property {boolean} push
 * @property {string} base
 * @property {boolean} afterOnly
 * @property {boolean} sideBySide
 * @property {number | undefined} width
 * @property {number} fps
 * @property {number} scale
 * @property {string | undefined} mode
 * @property {string | undefined} chromium
 * @property {string} branch
 * @property {string | undefined} repo
 * @property {boolean} keep
 * @property {Record<string, string | boolean | undefined>} app the setup module's own options
 */

export const USAGE =
  'usage: gif <scenario> [--dir <PR>] [--no-push] [--base origin/main] [--after-only | --side-by-side] ' +
  '[--width <px>] [--fps <n>] [--scale <n>] [--mode <mode>] [--chromium <path>] [--branch <name>] ' +
  '[--repo owner/name] [--keep]';

/** @type {OptionSpecs} */
const OWN = {
  dir: { type: 'string' },
  'no-push': { type: 'boolean' },
  base: { type: 'string' },
  'after-only': { type: 'boolean' },
  'side-by-side': { type: 'boolean' },
  width: { type: 'string' },
  fps: { type: 'string' },
  scale: { type: 'string' },
  mode: { type: 'string' },
  chromium: { type: 'string' },
  branch: { type: 'string' },
  repo: { type: 'string' },
  keep: { type: 'boolean' },
};

/**
 * @param {string} flag
 * @param {unknown} value
 * @param {number | undefined} fallback
 */
function positive(flag, value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!(n > 0)) throw new Error(`${flag} takes a number above 0\n${USAGE}`);
  return n;
}

/**
 * Reads the command line (after node and the script). Throws, with the
 * usage, on anything it can't use. `appOptions` are the setup module's; one
 * named like the recorder's own is refused, as it would shadow it.
 *
 * @param {readonly string[]} argv
 * @param {{ settings: GifSettings; env?: Record<string, string | undefined>; appOptions?: OptionSpecs }} context
 * @returns {Options}
 */
export function parseOptions(argv, { settings, env = {}, appOptions = {} }) {
  const clash = Object.keys(appOptions).filter((name) => name in OWN);
  if (clash.length > 0)
    throw new Error(`the setup module's --${clash[0]} clashes with the recorder's own`);
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { ...OWN, ...appOptions },
    });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\n${USAGE}`, {
      cause: error,
    });
  }
  const { values, positionals } = parsed;
  /** @param {string} name */
  const str = (name) => {
    const v = values[name];
    return typeof v === 'string' ? v : undefined;
  };
  if (positionals.length !== 1) throw new Error(`one scenario, please\n${USAGE}`);
  const dir = str('dir');
  if (dir !== undefined && (!/^[\w.-]+$/.test(dir) || /^\.+$/.test(dir))) {
    throw new Error(`--dir is one folder name (letters, digits, . _ -), not ${dir}`);
  }
  const repo = str('repo');
  if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error('--repo must be owner/name');
  const afterOnly = values['after-only'] === true;
  const sideBySide = values['side-by-side'] === true;
  if (afterOnly && sideBySide) throw new Error('--side-by-side needs a before: drop --after-only');
  if (values['no-push'] === true && dir === undefined) {
    throw new Error('--no-push is for publishing: give --dir too');
  }
  /** @type {Record<string, string | boolean | undefined>} */
  const app = {};
  for (const [name, spec] of Object.entries(appOptions)) {
    const v = values[name];
    app[name] = Array.isArray(v) ? v[0] : (v ?? spec.default);
  }
  return {
    scenario: positionals[0],
    dir,
    push: values['no-push'] !== true,
    base: str('base') ?? 'origin/main',
    afterOnly,
    sideBySide,
    width: positive('--width', values.width, undefined),
    fps: /** @type {number} */ (positive('--fps', values.fps, settings.fps)),
    scale: /** @type {number} */ (positive('--scale', values.scale, settings.scale)),
    mode: str('mode') ?? settings.build.mode,
    chromium:
      str('chromium') || env.PR_GIF_CHROMIUM || env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    branch: str('branch') ?? settings.branch,
    repo,
    keep: values.keep === true,
    app,
  };
}

/**
 * A GIF's width when neither --width nor the scenario sets one: the window's
 * own, so a phone's frames aren't blown up, but no more than 700; side by
 * side, two of those (each at most 496) and the 8px between them.
 *
 * @param {number} viewportWidth
 * @param {boolean} sideBySide
 */
export function defaultWidth(viewportWidth, sideBySide) {
  if (!sideBySide) return Math.min(700, viewportWidth);
  // ffmpeg.mjs's sideBySideFilter splits its width into two even halves.
  const half = Math.floor(Math.min(496, viewportWidth) / 2) * 2;
  return 2 * half + 8;
}

/**
 * The name a scenario's GIFs go by: its own, or its file's.
 *
 * @param {string} file
 * @param {unknown} name
 */
export function scenarioName(file, name) {
  return typeof name === 'string' ? name : file.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
}
