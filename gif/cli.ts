// A PR's before/after GIFs in one command, run from an app's checkout (or
// with APP_ROOT set) by the app's `npm run gif` (scripts/gif.mjs in
// BoardGames and fog-and-frontier, scripts/pr-gifs.ts in sift), which clones
// this repo beside the app as ../ci and runs
//
//   node ../ci/gif/cli.ts <scenario> [options]      (options.ts lists them)
//
// The apps name this path, so moving it breaks their command until each
// changes. Until ci#180 they ran gif/cli.mjs, so each app's bootstrap runs
// cli.mjs when its ../ci clone still has it, else this file (sift#255,
// BoardGames#365, fog-and-frontier#381); that fallback can be dropped from
// the apps once no clone they use predates cli.ts.
//
// Run as a script, it calls main and turns a failure into its message (and
// its cause's) and exit code 1 (runEntry); imported, it only exports main.
// Node strips its types as it loads it, so a Node below 22.18 fails here.
//
// For a web app (the `gif.source` setting, settings.ts), it builds the app
// twice, from --base (origin/main, in a temporary worktree sharing the
// checkout's node_modules) and from the working tree, uncommitted changes
// included (build.ts). Each build is served with `vite preview`, and the
// scenario (scenario.ts) is played against it in WebKit, Safari's engine,
// from the app's own Playwright (installed with `npx playwright install
// --with-deps webkit`, which on Linux adds the system libraries it needs,
// in a Claude cloud session too, where only Chromium comes installed),
// with the pointer and key presses drawn in (overlay.ts),
// each frame shown for as long as it was on screen (record.ts, ffmpeg.ts).
// A repo that builds its page itself (the `gif.page` setting, as jbhirsh/ci
// does its job-summary report) has that module build each side in place of
// Vite, into this run's own work folder, and the recording's context routes
// http://gif.test to the folder (route.ts) in place of `vite preview`: no
// server, so nothing listens and nothing waits for one. The rest is the
// same.
// The GIFs land in pr-gif/<name>/ in the checkout: <name>-before.gif and
// <name>-after.gif, or <name>-side-by-side.gif. With --dir <PR>, they're
// committed to the pictures branch under <PR>/ and pushed (publish.ts), and
// the Before/After table for the PR description is printed, linked by that
// commit's SHA.
//
// What every recording of the app needs around its scenario (stubbing its
// API, reading production's data, refusing a recording with photos missing)
// is the app's setup module (the `gif.setup` setting; scenario.ts says what
// it exports): pictures show the app as production shows it, and how that's
// done is each app's. The order, for each side:
//   a context with the window, scale and colour scheme, service workers
//   blocked (one answers requests before page.route sees them), and the
//   overlay; setup.beforeSetup; scenario.setup; setup.afterSetup; the page
//   opens; scenario.ready; the pictures in view load; setup.check; recording
//   starts; scenario.play; recording stops; setup.check again.
//
// With --before-may-fail, a "before" that can't be built or played (a new
// scenario for a screen main doesn't have) leaves "after" alone rather than
// failing the run: the automatic recording's way (pr-gif.yml), which can't
// tell such a scenario beforehand.
//
// Look through the GIFs before publishing: a few frames, the start,
// mid-action and the end. Ctrl-C stops the servers, removes the worktrees and
// the work directory before exiting.
//
// For an app whose CI records its scenarios as videos (source "ci-videos"),
// it hands over to videos.ts, which reads its own command line.

import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appPlaywright, appRoot } from '../lib/app.ts';
import { addBaseTree, build, git, serve, stopServers } from './build.ts';
import { checkFfmpeg, framesToGif, sideBySide } from './ffmpeg.ts';
import { click, drag, glide, scroll, swipe } from './moves.ts';
import { defaultWidth, parseOptions, scenarioName } from './options.ts';
import {
  gitIn,
  gifNames,
  markdownTable,
  publishFiles,
  repoFromRemote,
  sizeNote,
} from './publish.ts';
import { recordFrames, showPointer, waitForPictures } from './record.ts';
import { PAGE_ORIGIN, routePage } from './route.ts';
import { loadModule, scenarioProblems, setupProblems } from './scenario.ts';
import { loadSettings } from './settings.ts';
import { main as videosMain } from './videos.ts';
import type { ChildProcess } from 'node:child_process';
import type { OptionSpecs, Options } from './options.ts';
import type { GifSettings } from './settings.ts';
import type { Clip } from './timeline.ts';
import type { Browser, Page } from 'playwright';

export type Side = 'before' | 'after';

/** What a scenario's functions get as `gif`. */
export type Helpers = {
  glide: typeof glide;
  click: typeof click;
  drag: typeof drag;
  scroll: typeof scroll;
  swipe: typeof swipe;
  side: Side;
  origin: string;
};

/** A scenario module's default export (scenario.ts). */
export type Scenario = {
  name?: string;
  path?: string;
  viewport?: { width: number; height: number };
  colorScheme?: 'light' | 'dark';
  clip?: Clip | ((page: Page) => Promise<Clip>);
  width?: number;
  setup?: (page: Page, gif: Helpers) => Promise<void>;
  ready?: (page: Page, gif: Helpers) => Promise<void>;
  play: (page: Page, gif: Helpers) => Promise<void>;
};

/** What a setup module's functions get. */
export type SetupContext = {
  side: Side;
  origin: string;
  options: Record<string, string | boolean | undefined>;
  root: string;
};

/** A setup module's default export (scenario.ts). */
export type Setup = {
  options?: OptionSpecs;
  beforeSetup?: (page: Page, ctx: SetupContext) => Promise<void>;
  afterSetup?: (page: Page, ctx: SetupContext) => Promise<void>;
  check?: (page: Page, ctx: SetupContext) => Promise<void>;
};

/**
 * Loads the module `file` and checks its default export, saying what's
 * wrong with it.
 */
async function loadChecked(
  file: string,
  root: string,
  problemsOf: (value: unknown) => string[],
): Promise<unknown> {
  const module = await loadModule(file, root);
  const problems = problemsOf(module.default);
  if (problems.length > 0) throw new Error(`pr-gif: ${file}: ${problems.join('; ')}`);
  return module.default;
}

/**
 * Plays the scenario against the build at `origin`, leaving its frames in
 * `frames`. Given `dir` (a page the repo built itself), the context serves
 * it at `origin` (PAGE_ORIGIN) by routing.
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
  dir,
}: {
  browser: Browser;
  scenario: Scenario;
  setup: Setup;
  side: Side;
  origin: string;
  frames: string;
  options: Options;
  settings: GifSettings;
  root: string;
  dir?: string;
}) {
  const context = await browser.newContext({
    viewport: scenario.viewport ?? settings.viewport,
    deviceScaleFactor: options.scale,
    colorScheme: scenario.colorScheme ?? 'light',
    reducedMotion: 'no-preference',
    serviceWorkers: 'block',
  });
  try {
    if (dir) await routePage(context, dir);
    await showPointer(context);
    const page = await context.newPage();
    const ctx: SetupContext = { side, origin, options: options.app, root };
    const gif: Helpers = { glide, click, drag, scroll, swipe, side, origin };
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

export async function main(argv: readonly string[]) {
  const root = appRoot();
  const settings = loadSettings(root);
  if (settings.source === 'ci-videos') return videosMain(argv, { root, settings });
  const setup = (
    settings.setup ? await loadChecked(settings.setup, root, setupProblems) : {}
  ) as Setup;
  const options = parseOptions(argv, { settings, appOptions: setup.options });
  checkFfmpeg(options.sideBySide);
  const scenario = (await loadChecked(options.scenario, root, scenarioProblems)) as Scenario;
  const name = scenarioName(options.scenario, scenario.name);
  const files = gifNames(name);
  // Before anything is built, so a remote it can't read stops the run first.
  const repo = options.dir
    ? (options.repo ?? repoFromRemote(git(root, 'remote', 'get-url', 'origin')))
    : '';
  const out = path.join(root, 'pr-gif', name);
  mkdirSync(out, { recursive: true });

  const work = mkdtempSync(path.join(tmpdir(), 'pr-gif-'));
  const servers: ChildProcess[] = [];
  const trees: string[] = [];
  let browser: Browser | undefined;
  let stopping = false;
  // Each step on its own, so one that fails can't keep the rest from running
  // or hide the error that stopped the run. Started once: a second call (the
  // finally below, after an interruption) waits for the first to finish.
  let cleaning: Promise<void> | undefined;
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
  const interrupted = (signal: string) => {
    stopping = true;
    void cleanUp().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    const sides: { side: Side; dist: string; tree: string }[] = [];
    if (!options.afterOnly) {
      const tree = path.join(work, 'base');
      addBaseTree(root, options.base, tree);
      trees.push(tree);
      sides.push({ side: 'before', dist: path.join(work, 'dist-before'), tree });
    }
    sides.push({ side: 'after', dist: path.join(work, 'dist-after'), tree: root });
    /**
     * Passes on a side's failure, unless it's "before" and --before-may-fail
     * says to go on with "after" alone.
     */
    const failed = (side: Side, error: unknown) => {
      if (stopping || side !== 'before' || !options.beforeMayFail) throw error;
      console.warn(
        `pr-gif: "before" failed (${error instanceof Error ? error.message : error}); "after" alone, as for a screen main doesn't have`,
      );
      sides.splice(
        sides.findIndex((s) => s.side === 'before'),
        1,
      );
    };
    for (const { side, dist, tree } of [...sides]) {
      try {
        build({
          root,
          cwd: tree,
          outDir: dist,
          mode: options.mode,
          settings: settings.build,
          page: settings.page,
        });
      } catch (error) {
        failed(side, error);
      }
    }

    const { webkit } = await appPlaywright(root);
    // Ctrl-C is this script's to handle: Playwright's own would close the
    // browser under the cleanup above. Playwright's own WebKit, always: a
    // machine's PLAYWRIGHT_CHROMIUM_EXECUTABLE is no use to it.
    browser = await webkit
      .launch({ handleSIGINT: false, handleSIGTERM: false })
      .catch((error: unknown) => {
        throw new Error(
          "pr-gif: WebKit didn't start. Install it with: npx playwright install --with-deps webkit",
          { cause: error },
        );
      });
    for (const { side, dist } of [...sides]) {
      try {
        const origin = settings.page
          ? PAGE_ORIGIN
          : await serve({ root, outDir: dist, host: settings.host, servers });
        console.log(`pr-gif: recording ${side} at ${origin}`);
        const frames = path.join(work, `frames-${side}`);
        await recordSide({
          browser,
          scenario,
          setup,
          side,
          origin,
          frames,
          options,
          settings,
          root,
          dir: settings.page ? dist : undefined,
        });
      } catch (error) {
        failed(side, error);
      } finally {
        await stopServers(servers);
      }
    }

    const viewportWidth = (scenario.viewport ?? settings.viewport).width;
    const made: string[] = [];
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
      const from = sides.some((s) => s.side === 'before') ? `${options.base} and ${head}` : head;
      const sha = publishFiles(
        gitIn(root),
        made.map((file) => [`${dir}/${file}`, path.join(out, file)] as const),
        {
          message: `Add the ${name} GIFs for ${dir}\n\nRecorded from local builds of ${from} (with any uncommitted changes) by jbhirsh/ci's gif/cli.ts.`,
          branch: options.branch,
          push: options.push,
        },
      );
      const at = (file: string) => (made.includes(file) ? `${dir}/${file}` : null);
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

/**
 * The command line's own part: runs `run` (main) on the arguments and turns
 * a failure into its message, its cause's, and exit code 1.
 */
export async function runEntry(
  argv: readonly string[],
  run: (argv: readonly string[]) => Promise<unknown> = main,
) {
  try {
    await run(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if (error instanceof Error && error.cause instanceof Error) console.error(error.cause.message);
    process.exitCode = 1;
  }
}

// Run as a script: import.meta.main, or on a Node that strips types but has
// no import.meta.main yet (23.6 to 24.1), the path Node was given.
if (
  import.meta.main ??
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
) {
  await runEntry(process.argv.slice(2));
}
