// Loading an app's scenarios and setup module, and checking their shape,
// for cli.ts and selftest.ts. Both are the app's own TypeScript (or
// JavaScript), importing the app's own helpers by the app's rules (paths
// without extensions, say), so they're loaded through the app's own Vite
// (runnerImport), as its config and tests are; an app without Vite loads
// them with Node's import.
//
// A scenario's default export (its type is the app's, written there: see
// the bootstrap's header in each app) is:
//   name?        names the GIFs, <name>-before.gif and so on: the file's
//                name by default
//   path?        where the page opens, from the site's root ('/')
//   viewport?    the browser window ({ width, height }; the `gif.viewport`
//                setting by default)
//   colorScheme? 'light' (default) or 'dark'
//   clip?        what's recorded, in CSS pixels ({ x, y, width, height }),
//                or a function of the loaded page that works it out (from an
//                element's box, say): the whole window by default
//   width?       each GIF's width in pixels (the window's, up to 700)
//   setup?(page, gif)  before the page opens: stubs, sign-in flags
//   ready?(page, gif)  once it's open, before recording: wait for it to
//                settle, put the pointer where the first move starts
//   play(page, gif)    what's recorded: gif.glide / click / drag / scroll /
//                swipe (moves.ts) with pauses, and page.keyboard
// `gif` also says which build it is (gif.side, 'before' or 'after'), for a
// scenario that plays a little differently on main.
//
// A setup module's default export (all optional) is:
//   options      more command-line options, as node:util parseArgs takes
//                them ({ fixtures: { type: 'boolean' } }), handed back in
//                ctx.options
//   beforeSetup(page, ctx)  before the scenario's setup: routes the
//                scenario's own then win over (Playwright tries the newest
//                route first)
//   afterSetup(page, ctx)   after it: routes that win over the scenario's
//   check(page, ctx)        once the page is ready and the pictures in view
//                loaded, and again after recording: throw to refuse the
//                recording (a photo that didn't load, say), before
//                anything is published
// ctx is { side, origin, options, root }.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importFromApp } from '../lib/app.mjs';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Imports `file` (from the app's root, or absolute) through the app's Vite,
 * or Node's import when the app has none.
 */
export async function loadModule(file: string, root: string): Promise<Record<string, unknown>> {
  const absolute = path.resolve(root, file);
  if (!existsSync(absolute)) throw new Error(`pr-gif: no such file: ${file}`);
  let vite: unknown;
  try {
    vite = await importFromApp('vite', root);
  } catch {
    vite = null;
  }
  if (isObject(vite) && typeof vite.runnerImport === 'function') {
    const runnerImport = vite.runnerImport as (
      id: string,
      config: object,
    ) => Promise<{ module: unknown }>;
    const { module } = await runnerImport(absolute, { root, logLevel: 'error' });
    return isObject(module) ? module : {};
  }
  const module: unknown = await import(pathToFileURL(absolute).href);
  return isObject(module) ? module : {};
}

const SCENARIO_KEYS = [
  'name',
  'path',
  'viewport',
  'colorScheme',
  'clip',
  'width',
  'setup',
  'ready',
  'play',
];

const isSize = (value: unknown): value is { width: number; height: number } =>
  isObject(value) &&
  typeof value.width === 'number' &&
  value.width > 0 &&
  typeof value.height === 'number' &&
  value.height > 0;

const isPoint = (value: unknown): value is { x: number; y: number } =>
  isObject(value) && typeof value.x === 'number' && typeof value.y === 'number';

/**
 * What's wrong with a scenario module's default export, or nothing.
 */
export function scenarioProblems(scenario: unknown): string[] {
  if (!isObject(scenario)) return ['its default export is not a scenario object'];
  const problems = [];
  for (const key of Object.keys(scenario)) {
    if (!SCENARIO_KEYS.includes(key)) problems.push(`unknown key "${key}"`);
  }
  if (typeof scenario.play !== 'function') problems.push('play(page, gif) is missing');
  for (const hook of ['setup', 'ready']) {
    if (scenario[hook] !== undefined && typeof scenario[hook] !== 'function') {
      problems.push(`${hook} must be a function`);
    }
  }
  const { name, path: at, viewport, colorScheme, clip, width } = scenario;
  if (name !== undefined && (typeof name !== 'string' || !/^[\w.-]+$/.test(name))) {
    problems.push('name must be letters, digits, . _ -');
  }
  if (at !== undefined && (typeof at !== 'string' || !at.startsWith('/'))) {
    problems.push("path must start with '/'");
  }
  if (viewport !== undefined && !isSize(viewport))
    problems.push('viewport must be { width, height }');
  if (colorScheme !== undefined && colorScheme !== 'light' && colorScheme !== 'dark') {
    problems.push("colorScheme must be 'light' or 'dark'");
  }
  if (clip !== undefined && typeof clip !== 'function' && !(isSize(clip) && isPoint(clip))) {
    problems.push('clip must be { x, y, width, height } or a function of the page');
  }
  if (width !== undefined && !(typeof width === 'number' && width > 0)) {
    problems.push('width must be a number above 0');
  }
  return problems;
}

const SETUP_KEYS = ['options', 'beforeSetup', 'afterSetup', 'check'];

/**
 * What's wrong with a setup module's default export, or nothing.
 */
export function setupProblems(setup: unknown): string[] {
  if (!isObject(setup)) return ['its default export is not a setup object'];
  const problems = [];
  for (const key of Object.keys(setup)) {
    if (!SETUP_KEYS.includes(key)) problems.push(`unknown key "${key}"`);
  }
  for (const hook of ['beforeSetup', 'afterSetup', 'check']) {
    if (setup[hook] !== undefined && typeof setup[hook] !== 'function') {
      problems.push(`${hook} must be a function`);
    }
  }
  if (setup.options !== undefined) {
    if (!isObject(setup.options)) problems.push('options must map names to { type }');
    else {
      for (const [name, option] of Object.entries(setup.options)) {
        if (!isObject(option) || (option.type !== 'boolean' && option.type !== 'string')) {
          problems.push(`option --${name} needs a type, 'boolean' or 'string'`);
        }
      }
    }
  }
  return problems;
}

/**
 * Whether a file's name (no folder) is one of an app's scenarios: for a web
 * app, a .ts, .mjs or .js module that isn't a test or a type declaration;
 * for an app whose CI records videos (sift), a Maestro flow ending .yaml,
 * the only flows its recorder plays (sift's scripts/take-gifs.sh takes
 * e2e/gifs/*.yaml), so a .yml file there is never one.
 * scenarioFiles and workflow.ts's changedScenarios (which scenarios a PR
 * changes) both ask this, so the two never disagree.
 */
export function isScenarioFile(name: string, source: 'web' | 'ci-videos' = 'web') {
  if (source === 'ci-videos') return /^[^/]+\.yaml$/.test(name);
  return /^[^/]+\.(ts|mjs|js)$/.test(name) && !/\.(test|d)\.(ts|mjs|js)$/.test(name);
}

/**
 * The scenario files in `dir` (from the app's root): its .ts and .mjs files
 * whose default export is meant to be a scenario (isScenarioFile). A helper
 * module beside them (no default export) is left out by selftest.ts once
 * loaded.
 */
export function scenarioFiles(dir: string, root: string, source: 'web' | 'ci-videos' = 'web') {
  return readdirSync(path.join(root, dir))
    .filter((file) => isScenarioFile(file, source))
    .sort()
    .map((file) => path.join(dir, file));
}
