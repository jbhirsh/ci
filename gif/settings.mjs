// An app's settings for its PR GIFs: the `gif` key of its `.github/ci.json`
// (lib/app.mjs's appConfig). Every setting has a default, so an app without
// the key gets a web recorder with these defaults.
//
//   source     "web" (default): the app is a web app, recorded in Chromium
//              against local production builds of main and the working tree
//              (cli.mjs). "ci-videos": the app's CI records its scenarios as
//              videos, turned into GIFs here (videos.mjs, which reads
//              `videos` below).
//   setup      the app's setup module, from its root (none by default): what
//              every recording of the app needs around a scenario, such as
//              stubbing its API or reading production's data (see cli.mjs's
//              header for what it exports). Loaded like a scenario.
//   scenarios  the folder of the app's scenarios, from its root (none by
//              default), for selftest.mjs to load each and check its shape.
//   viewport   the browser window a scenario gets unless it names one, in
//              CSS pixels: a phone's, 402 x 874 (the newest iPhone Pro's), by
//              default.
//   scale      device pixels per CSS pixel (1): 2 draws the page as a
//              high-density screen does, and the GIF scaled down from it is
//              the sharper.
//   host       the host each build is served on (127.0.0.1); "localhost" for
//              an app whose stubs let only that through.
//   build      how each build is made: { mode, env, unsetEnv }, the Vite
//              mode (Vite's own default unless set; --mode overrides it),
//              variables to set (e.g. VERCEL_ENV, to build as production
//              does) and ones to drop from the shell's (e.g. a token that
//              would upload source maps).
//   fps        the most frames a second a recording keeps (15; --fps).
//   branch     the pictures branch GIFs are published to (screenshots).
//   cellWidth  each GIF's width in the PR's table (400); side-by-side twice.
//   videos     for source "ci-videos": { workflow, artifact, inputs,
//              scenariosInput, ringColor, width, fps }, read by videos.mjs.

import path from 'node:path';
import { appConfig } from '../lib/app.mjs';

/**
 * @typedef {object} BuildSettings
 * @property {string | undefined} mode
 * @property {Record<string, string>} env
 * @property {string[]} unsetEnv
 */

/**
 * @typedef {object} VideoSettings
 * @property {string} workflow the workflow file that records the videos
 * @property {string} artifact the artifact holding them, one .mp4 per scenario
 * @property {Record<string, string>} inputs the inputs that make a run by hand on main record only the scenarios
 * @property {string} scenariosInput the input naming the commit whose scenarios that run records
 * @property {string} ringColor the drawn touch ring's colour, #rrggbb
 * @property {number} width each GIF's width
 * @property {number} fps
 */

/**
 * @typedef {object} GifSettings
 * @property {'web' | 'ci-videos'} source
 * @property {string | undefined} setup
 * @property {string | undefined} scenarios
 * @property {{ width: number; height: number }} viewport
 * @property {number} scale
 * @property {string} host
 * @property {BuildSettings} build
 * @property {number} fps
 * @property {string} branch
 * @property {number} cellWidth
 * @property {VideoSettings} videos
 */

/** A phone's window: the site is designed phone first. */
export const PHONE = { width: 402, height: 874 };

/** @type {VideoSettings} */
export const VIDEO_DEFAULTS = {
  workflow: 'ci.yml',
  artifact: 'ios-gif-videos',
  inputs: { gifs_only: 'true' },
  scenariosInput: 'gif_scenarios_from',
  ringColor: '#E11D48',
  width: 360,
  fps: 15,
};

const KEYS = [
  'source',
  'setup',
  'scenarios',
  'viewport',
  'scale',
  'host',
  'build',
  'fps',
  'branch',
  'cellWidth',
  'videos',
];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {string} name
 * @param {unknown} value
 * @param {number} fallback
 */
function positive(name, value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !(value > 0))
    throw new Error(`gif.${name} must be a number above 0`);
  return value;
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {RegExp} [shape]
 */
function text(name, value, shape = /^\S+$/) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !shape.test(value)) {
    throw new Error(`gif.${name} must be a string matching ${shape}`);
  }
  return value;
}

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function strings(name, value) {
  if (value === undefined) return {};
  if (!isObject(value) || Object.values(value).some((v) => typeof v !== 'string')) {
    throw new Error(`gif.${name} must map names to strings`);
  }
  return /** @type {Record<string, string>} */ (value);
}

/**
 * A path inside the app, from its root: never absolute, never up out of it.
 *
 * @param {string} name
 * @param {unknown} value
 */
function inside(name, value) {
  const given = text(name, value);
  if (given === undefined) return undefined;
  if (path.isAbsolute(given) || path.normalize(given).split(/[\\/]/)[0] === '..') {
    throw new Error(`gif.${name} must be a path inside the app`);
  }
  return given;
}

/**
 * The settings from a `gif` key's value, with every default filled in.
 * Throws, naming the setting, on one it can't use, and on a key it doesn't
 * know (a typo would otherwise be a default silently).
 *
 * @param {Record<string, unknown>} raw
 * @returns {GifSettings}
 */
export function parseSettings(raw) {
  const unknown = Object.keys(raw).filter((key) => !KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`gif: unknown setting ${unknown.join(', ')}`);
  const source = raw.source ?? 'web';
  if (source !== 'web' && source !== 'ci-videos') {
    throw new Error('gif.source must be "web" or "ci-videos"');
  }
  let viewport = PHONE;
  if (raw.viewport !== undefined) {
    if (!isObject(raw.viewport)) throw new Error('gif.viewport must be { width, height }');
    viewport = {
      // Both needed: null is never a default.
      width: positive('viewport.width', raw.viewport.width ?? null, 0),
      height: positive('viewport.height', raw.viewport.height ?? null, 0),
    };
  }
  const build = raw.build ?? {};
  if (!isObject(build)) throw new Error('gif.build must be { mode, env, unsetEnv }');
  const unsetEnv = build.unsetEnv ?? [];
  if (!Array.isArray(unsetEnv) || unsetEnv.some((v) => typeof v !== 'string')) {
    throw new Error('gif.build.unsetEnv must be a list of names');
  }
  const videos = raw.videos ?? {};
  if (!isObject(videos)) throw new Error('gif.videos must be an object');
  return {
    source,
    setup: inside('setup', raw.setup),
    scenarios: inside('scenarios', raw.scenarios),
    viewport,
    scale: positive('scale', raw.scale, 1),
    host: text('host', raw.host, /^[\w.-]+$/) ?? '127.0.0.1',
    build: {
      mode: text('build.mode', build.mode, /^[\w.-]+$/),
      env: strings('build.env', build.env),
      unsetEnv: /** @type {string[]} */ (unsetEnv),
    },
    fps: positive('fps', raw.fps, 15),
    branch: text('branch', raw.branch, /^[\w./-]+$/) ?? 'screenshots',
    cellWidth: positive('cellWidth', raw.cellWidth, 400),
    videos: {
      workflow:
        text('videos.workflow', videos.workflow, /^[\w.-]+\.ya?ml$/) ?? VIDEO_DEFAULTS.workflow,
      artifact: text('videos.artifact', videos.artifact) ?? VIDEO_DEFAULTS.artifact,
      inputs:
        videos.inputs === undefined
          ? VIDEO_DEFAULTS.inputs
          : strings('videos.inputs', videos.inputs),
      scenariosInput:
        text('videos.scenariosInput', videos.scenariosInput, /^\w+$/) ??
        VIDEO_DEFAULTS.scenariosInput,
      ringColor:
        text('videos.ringColor', videos.ringColor, /^#[0-9a-fA-F]{6}$/) ?? VIDEO_DEFAULTS.ringColor,
      width: positive('videos.width', videos.width, VIDEO_DEFAULTS.width),
      fps: positive('videos.fps', videos.fps, VIDEO_DEFAULTS.fps),
    },
  };
}

/**
 * The settings of the app at `root`.
 *
 * @param {string} root
 */
export function loadSettings(root) {
  return parseSettings(appConfig('gif', root));
}
