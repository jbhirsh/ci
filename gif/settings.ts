// An app's settings for its PR GIFs: the `gif` key of its `.github/ci.json`
// (lib/app.mjs's appConfig). Every setting has a default, so an app without
// the key gets a web recorder with these defaults.
//
//   source     "web" (default): the app is a web app, recorded in WebKit,
//              Safari's engine, against local production builds of main and
//              the working tree (cli.ts). WebKit is installed once with
//              `npx playwright install --with-deps webkit`, in a Claude
//              cloud session too, where only Chromium comes installed.
//              "ci-videos": the app's CI records its scenarios as videos,
//              turned into GIFs here (videos.ts, which reads `videos`
//              below).
//   setup      the app's setup module, from its root (none by default): what
//              every recording of the app needs around a scenario, such as
//              stubbing its API or reading production's data (see cli.ts's
//              header for what it exports). Loaded like a scenario.
//   scenarios  the folder of the app's scenarios, from its root (none by
//              default): for a web app, its modules (scenario.ts), which
//              selftest.ts loads and checks; for "ci-videos", its Maestro
//              flows (sift's e2e/gifs), which its CI records. Either way, a
//              PR that adds or changes a file directly in it gets that
//              scenario's GIFs recorded and attached on its own
//              (pr-gif.yml, pr-gif-attach.yml); unset, nothing is automatic.
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
//              scenariosInput, ringColor, width, fps }, read by videos.ts.

import path from 'node:path';
import { appConfig } from '../lib/app.mjs';

export type BuildSettings = {
  mode: string | undefined;
  env: Record<string, string>;
  unsetEnv: string[];
};

export type VideoSettings = {
  /** the workflow file that records the videos */
  workflow: string;
  /** the artifact holding them, one .mp4 per scenario */
  artifact: string;
  /** the inputs that make a run by hand on main record only the scenarios */
  inputs: Record<string, string>;
  /** the input naming the commit whose scenarios that run records */
  scenariosInput: string;
  /** the drawn touch ring's colour, #rrggbb */
  ringColor: string;
  /** each GIF's width */
  width: number;
  fps: number;
};

export type GifSettings = {
  source: 'web' | 'ci-videos';
  setup: string | undefined;
  scenarios: string | undefined;
  viewport: { width: number; height: number };
  scale: number;
  host: string;
  build: BuildSettings;
  fps: number;
  branch: string;
  cellWidth: number;
  videos: VideoSettings;
};

/** A phone's window: the site is designed phone first. */
export const PHONE = { width: 402, height: 874 };

export const VIDEO_DEFAULTS: VideoSettings = {
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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function positive(name: string, value: unknown, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !(value > 0))
    throw new Error(`gif.${name} must be a number above 0`);
  return value;
}

function text(name: string, value: unknown, shape: RegExp = /^\S+$/) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !shape.test(value)) {
    throw new Error(`gif.${name} must be a string matching ${shape}`);
  }
  return value;
}

function strings(name: string, value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isObject(value) || Object.values(value).some((v) => typeof v !== 'string')) {
    throw new Error(`gif.${name} must map names to strings`);
  }
  return value as Record<string, string>;
}

/**
 * A path inside the app, from its root: never absolute, never up out of it.
 */
function inside(name: string, value: unknown) {
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
 */
export function parseSettings(raw: Record<string, unknown>): GifSettings {
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
      unsetEnv: unsetEnv as string[],
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
 */
export function loadSettings(root: string) {
  return parseSettings(appConfig('gif', root));
}
