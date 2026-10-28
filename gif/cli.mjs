// A PR's before/after GIFs in one command, run from an app's checkout (or
// with APP_ROOT set) by the app's bootstrap (its scripts/gif.mjs):
//
//   node ../ci/gif/cli.mjs <scenario> [options]      (options.mjs lists them)
//
// For a web app (the `gif.source` setting, settings.mjs), it builds the app
// twice, from --base (origin/main, in a temporary worktree sharing the
// checkout's node_modules) and from the working tree, uncommitted changes
// included (build.mjs). Each build is served with `vite preview`, and the
// scenario (scenario.mjs) is played against it in Chromium, from the app's
// own Playwright, with the pointer and key presses drawn in (overlay.mjs),
// each frame shown for as long as it was on screen (record.mjs, ffmpeg.mjs).
// The GIFs land in pr-gif/<name>/ in the checkout: <name>-before.gif and
// <name>-after.gif, or <name>-side-by-side.gif. With --dir <PR>, they're
// committed to the pictures branch under <PR>/ and pushed (publish.mjs), and
// the Before/After table for the PR description is printed, linked by that
// commit's SHA.
//
// What every recording of the app needs around its scenario (stubbing its
// API, reading production's data, refusing a recording with photos missing)
// is the app's setup module (the `gif.setup` setting; scenario.mjs says what
// it exports): pictures show the app as production shows it, and how that's
// done is each app's. The order, for each side:
//   a context with the window, scale and colour scheme, service workers
//   blocked (one answers requests before page.route sees them), and the
//   overlay; setup.beforeSetup; scenario.setup; setup.afterSetup; the page
//   opens; scenario.ready; the pictures in view load; setup.check; recording
//   starts; scenario.play; recording stops; setup.check again.
//
// Look through the GIFs before publishing: a few frames, the start,
// mid-action and the end. Ctrl-C stops the servers, removes the worktrees and
// the work directory before exiting.
//
// For an app whose CI records its scenarios as videos (source "ci-videos"),
// it hands over to videos.mjs, which reads its own command line.

import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appRoot, importFromApp } from '../lib/app.mjs';
import { addBaseTree, build, git, serve, stopServers } from './build.mjs';
import { checkFfmpeg, framesToGif, sideBySide } from './ffmpeg.mjs';
import { click, drag, glide, scroll, swipe } from './moves.mjs';
import { defaultWidth, parseOptions, scenarioName } from './options.mjs';
import {
  gitIn,
  gifNames,
  markdownTable,
  publishFiles,
  repoFromRemote,
  sizeNote,
} from './publish.mjs';
import { recordFrames, showPointer, waitForPictures } from './record.mjs';
import { loadModule, scenarioProblems, setupProblems } from './scenario.mjs';
import { loadSettings } from './settings.mjs';
import { main as videosMain } from './videos.mjs';

/** @typedef {import('./options.mjs').Options} Options */
/** @typedef {import('./settings.mjs').GifSettings} GifSettings */
/** @typedef {import('./timeline.mjs').Clip} Clip */
/** @typedef {import('playwright').Page} Page */
/** @typedef {import('playwright').Browser} Browser */
/** @typedef {'before' | 'after'} Side */

/**
 * @typedef {object} Helpers What a scenario's functions get as `gif`.
 * @property {typeof glide} glide
 * @property {typeof click} click
 * @property {typeof drag} drag
 * @property {typeof scroll} scroll
 * @property {typeof swipe} swipe
 * @property {Side} side
 * @property {string} origin
 */

/**
 * @typedef {object} Scenario A scenario module's default export (scenario.mjs).
 * @property {string} [name]
 * @property {string} [path]
 * @property {{ width: number; height: number }} [viewport]
 * @property {'light' | 'dark'} [colorScheme]
 * @property {Clip | ((page: Page) => Promise<Clip>)} [clip]
 * @property {number} [width]
 * @property {(page: Page, gif: Helpers) => Promise<void>} [setup]
 * @property {(page: Page, gif: Helpers) => Promise<void>} [ready]
 * @property {(page: Page, gif: Helpers) => Promise<void>} play
 */

/**
 * @typedef {object} SetupContext What a setup module's functions get.
 * @property {Side} side
 * @property {string} origin
 * @property {Record<string, string | boolean | undefined>} options
 * @property {string} root
 */

/**
 * @typedef {object} Setup A setup module's default export (scenario.mjs).
 * @property {import('./options.mjs').OptionSpecs} [options]
 * @property {(page: Page, ctx: SetupContext) => Promise<void>} [beforeSetup]
 * @property {(page: Page, ctx: SetupContext) => Promise<void>} [afterSetup]
 * @property {(page: Page, ctx: SetupContext) => Promise<void>} [check]
 */

/**
 * Loads the module `file` and checks its default export, saying what's
 * wrong with it.
 *
 * @param {string} file
 * @param {string} root
 * @param {(value: unknown) => string[]} problemsOf
 * @returns {Promise<unknown>}
 */
async function loadChecked(file, root, problemsOf) {
  const module = await loadModule(file, root);
  const problems = problemsOf(module.default);
  if (problems.length > 0) throw new Error(`pr-gif: ${file}: ${problems.join('; ')}`);
  return module.default;
}

/**
 * The app's Playwright: `@playwright/test`, or else `playwright`.
 *
 * @param {string} root
 * @returns {Promise<typeof import('playwright')>}
 */
export async function appPlaywright(root) {
  /** @type {unknown} */
  let module;
  try {
    module = await importFromApp('@playwright/test', root);
  } catch {
    module = await importFromApp('playwright', root);
  }
  // Resolved as CommonJS, its exports come as the default export (Playwright
  // Test's is a function, `test`, carrying the rest).
  const { default: cjs } = /** @type {{ default?: unknown }} */ (module);
  return /** @type {typeof import('playwright')} */ (
    (typeof cjs === 'object' || typeof cjs === 'function') && cjs !== null && 'chromium' in cjs
      ? cjs
      : module
  );
}

/**
 * Plays the scenario against the build at `origin`, leaving its frames in
 * `frames`.
 *
 * @param {{ browser: Browser; scenario: Scenario; setup: Setup; side: Side; origin: string; frames: string; options: Options; settings: GifSettings; root: string }} run
 */
export async function recordSide({
  browser,
  scenario,
  setup,
  side,
  origin,
  frames,
  options,
  settings,
  root,
}) {
  const context = await browser.newContext({
    viewport: scenario.viewport ?? settings.viewport,
    deviceScaleFactor: options.scale,
    colorScheme: scenario.colorScheme ?? 'light',
    reducedMotion: 'no-preference',
    serviceWorkers: 'block',
  });
  try {
    await showPointer(context);
    const page = await context.newPage();
    /** @type {SetupContext} */
    const ctx = { side, origin, options: options.app, root };
    /** @type {Helpers} */
    const gif = { glide, click, drag, scroll, swipe, side, origin };
    await setup.beforeSetup?.(page, ctx);
    await scenario.setup?.(page, gif);
    await setup.afterSetup?.(page, ctx);
    await page.goto(origin + (scenario.path ?? '/'));
    await scenario.ready?.(page, gif);
    await waitForPictures(page);
    await setup.check?.(page, ctx);
    const viewport = scenario.viewport ?? settings.viewport;
    const clip =
      typeof scenario.clip === 'function'
        ? await scenario.clip(page)
        : (scenario.clip ?? { x: 0, y: 0, ...viewport });
    const stop = await recordFrames(page, clip, frames, { fps: options.fps });
    try {
      await scenario.play(page, gif);
    } finally {
      const { sent, stills, seconds } = await stop();
      console.log(
        `pr-gif: ${side}: ${sent} frames painted over ${seconds.toFixed(1)} s, ${stills} kept`,
      );
    }
    await setup.check?.(page, ctx);
  } finally {
    await context.close();
  }
}

/**
 * @param {readonly string[]} argv
 * @param {Record<string, string | undefined>} [env]
 */
export async function main(argv, env = process.env) {
  const root = appRoot();
  const settings = loadSettings(root);
  if (settings.source === 'ci-videos') return videosMain(argv, { root, settings });
  const setup = /** @type {Setup} */ (
    settings.setup ? await loadChecked(settings.setup, root, setupProblems) : {}
  );
  const options = parseOptions(argv, { settings, env, appOptions: setup.options });
  checkFfmpeg(options.sideBySide);
  const scenario = /** @type {Scenario} */ (
    await loadChecked(options.scenario, root, scenarioProblems)
  );
  const name = scenarioName(options.scenario, scenario.name);
  const files = gifNames(name);
  // Before anything is built, so a remote it can't read stops the run first.
  const repo = options.dir
    ? (options.repo ?? repoFromRemote(git(root, 'remote', 'get-url', 'origin')))
    : '';
  const out = path.join(root, 'pr-gif', name);
  mkdirSync(out, { recursive: true });

  const work = mkdtempSync(path.join(tmpdir(), 'pr-gif-'));
  /** @type {import('node:child_process').ChildProcess[]} */
  const servers = [];
  /** @type {string[]} */
  const trees = [];
  /** @type {Browser | undefined} */
  let browser;
  let stopping = false;
  // Each step on its own, so one that fails can't keep the rest from running
  // or hide the error that stopped the run. Started once: a second call (the
  // finally below, after an interruption) waits for the first to finish.
  /** @type {Promise<void> | undefined} */
  let cleaning;
  const cleanUp = () =>
    (cleaning ??= (async () => {
      await stopServers(servers);
      await browser?.close().catch(() => {});
      for (const tree of trees) {
        try {
          git(root, 'worktree', 'remove', '--force', tree);
        } catch {
          // Gone already.
        }
      }
      if (options.keep) console.log(`pr-gif: kept ${work}`);
      else rmSync(work, { recursive: true, force: true });
    })());
  /** @param {string} signal */
  const interrupted = (signal) => {
    stopping = true;
    void cleanUp().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    /** @type {{ side: Side; dist: string; tree: string }[]} */
    const sides = [];
    if (!options.afterOnly) {
      const tree = path.join(work, 'base');
      addBaseTree(root, options.base, tree);
      trees.push(tree);
      sides.push({ side: 'before', dist: path.join(work, 'dist-before'), tree });
    }
    sides.push({ side: 'after', dist: path.join(work, 'dist-after'), tree: root });
    for (const { dist, tree } of sides) {
      build({ root, cwd: tree, outDir: dist, mode: options.mode, settings: settings.build });
    }

    const { chromium } = await appPlaywright(root);
    // Ctrl-C is this script's to handle: Playwright's own would close the
    // browser under the cleanup above.
    browser = await chromium.launch({
      executablePath: options.chromium,
      handleSIGINT: false,
      handleSIGTERM: false,
    });
    for (const { side, dist } of sides) {
      const origin = await serve({ root, outDir: dist, host: settings.host, servers });
      console.log(`pr-gif: recording ${side} at ${origin}`);
      const frames = path.join(work, `frames-${side}`);
      await recordSide({ browser, scenario, setup, side, origin, frames, options, settings, root });
      await stopServers(servers);
    }

    const viewportWidth = (scenario.viewport ?? settings.viewport).width;
    /** @type {string[]} */
    const made = [];
    if (options.sideBySide) {
      const width = options.width ?? defaultWidth(viewportWidth, true);
      sideBySide(
        path.join(work, 'frames-before'),
        path.join(work, 'frames-after'),
        path.join(out, files.side),
        {
          width,
        },
      );
      made.push(files.side);
    } else {
      const width = options.width ?? scenario.width ?? defaultWidth(viewportWidth, false);
      for (const { side } of sides) {
        framesToGif(path.join(work, `frames-${side}`), path.join(out, files[side]), { width });
        made.push(files[side]);
      }
    }
    for (const file of made) {
      const note = sizeNote(path.join(out, file), statSync(path.join(out, file)).size);
      if (note.includes('over 5 MB')) console.warn(note);
      else console.log(note);
    }
    console.log('pr-gif: look through them before publishing.');

    if (options.dir) {
      const dir = options.dir;
      const head = git(root, 'rev-parse', '--short', 'HEAD');
      const from = options.afterOnly ? head : `${options.base} and ${head}`;
      const sha = publishFiles(
        gitIn(root),
        made.map((file) => /** @type {const} */ ([`${dir}/${file}`, path.join(out, file)])),
        {
          message: `Add the ${name} GIFs for ${dir}\n\nRecorded from local builds of ${from} (with any uncommitted changes) by jbhirsh/ci's gif/cli.mjs.`,
          branch: options.branch,
          push: options.push,
        },
      );
      const at = (/** @type {string} */ file) => (made.includes(file) ? `${dir}/${file}` : null);
      const table = markdownTable(
        repo,
        sha,
        [{ name, before: at(files.before), after: at(files.after), sideBySide: at(files.side) }],
        { width: settings.cellWidth, base: options.base.replace(/^(origin|upstream)\//, '') },
      );
      console.log(`\nFor the PR description:\n\n${table}\n`);
    }
  } catch (error) {
    // What an interruption breaks on its way out (a page closed under a
    // step) is no news.
    if (!stopping) throw error;
  } finally {
    await cleanUp();
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.cause instanceof Error) console.error(error.cause.message);
    process.exitCode = 1;
  });
}
