// Checks, without recording anything, that the GIF tool can run for an app:
//
//   node gif/selftest.ts <app checkout>
//
// Read-only, and with no browser or ffmpeg (this repo's CI runs it against
// each app's main with only `npm ci --ignore-scripts` done there):
//   - its `gif` settings parse (an app without the key is checked against
//     the defaults, and nothing more is asked of it);
//   - for an app whose CI records videos (sift), only that its scenarios
//     folder, if it names one, is there and holds a Maestro flow;
//   - a page builder (`gif.page`), if it names one, is there: not run, since
//     running it is a build;
//   - a web app's setup module, if it names one, loads through the app's
//     own Vite and exports the shape cli.ts calls (scenario.ts);
//   - each module in its scenarios folder, if it names one, loads and
//     exports a scenario of the shape cli.ts plays (a module there with no
//     default export is a helper the scenarios share, and is passed over);
//   - and the app's Playwright, which cli.ts records with, resolves, with
//     a WebKit to launch (not started: no browser is installed here), and
//     is a release with page.screencast, which record.ts takes frames from
//     (SCREENCAST_SINCE).
// A web app's recordings also need WebKit itself, which this can't check:
// `npx playwright install --with-deps webkit` installs it (in a Claude
// cloud session too, where only Chromium comes installed).
// Prints what it checked; exits non-zero, naming each problem, on any.

import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig, appPlaywright } from '../lib/app.ts';
import { loadModule, scenarioFiles, scenarioProblems, setupProblems } from './scenario.ts';
import { parseSettings } from './settings.ts';
import type { GifSettings } from './settings.ts';

/**
 * The first Playwright release recordFrames is known to work with: its
 * page.screencast sends frames (onFrame, size, quality).
 */
const SCREENCAST_SINCE = [1, 64];

/**
 * The app's Playwright release, from playwright-core's package.json (which
 * both `@playwright/test` and `playwright` install).
 */
function playwrightVersion(root: string): number[] {
  const require = createRequire(path.join(root, 'package.json'));
  const { version } = require('playwright-core/package.json') as { version: string };
  return version.split('.').map(Number);
}

/**
 * The problems found in the app at `root`, saying what it checked to `log`.
 */
export async function selftest(
  root: string,
  log: (line: string) => void = console.log,
): Promise<string[]> {
  const problems: string[] = [];
  let raw: Record<string, unknown>;
  let settings: GifSettings;
  try {
    raw = appConfig('gif', root);
    settings = parseSettings(raw);
  } catch (error) {
    return [`settings: ${error instanceof Error ? error.message : error}`];
  }
  if (Object.keys(raw).length === 0) {
    log('gif: no gif settings; the defaults parse, nothing more to check');
    return problems;
  }
  log(`gif: settings parse (source ${settings.source})`);
  if (settings.source === 'ci-videos') {
    // Its flows run on the app's CI, not here: only that the folder the
    // automatic GIFs watch (pr-gif-attach.yml) is there and holds one.
    if (settings.scenarios) {
      if (!existsSync(path.join(root, settings.scenarios))) {
        problems.push(`gif.scenarios: no folder ${settings.scenarios}`);
      } else {
        const flows = scenarioFiles(settings.scenarios, root, 'ci-videos');
        if (flows.length === 0) problems.push(`gif.scenarios: no flow in ${settings.scenarios}`);
        else log(`gif: ${flows.length} flow(s) in ${settings.scenarios}`);
      }
    }
    return problems;
  }

  if (settings.page) {
    if (statSync(path.join(root, settings.page), { throwIfNoEntry: false })?.isFile())
      log(`gif: page builder ${settings.page} is there`);
    else problems.push(`gif.page: no file ${settings.page}`);
  }
  if (settings.setup) {
    try {
      const module = await loadModule(settings.setup, root);
      const found = setupProblems(module.default);
      problems.push(...found.map((p) => `${settings.setup}: ${p}`));
      if (found.length === 0) log(`gif: setup module ${settings.setup} loads`);
    } catch (error) {
      problems.push(`${settings.setup}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (settings.scenarios) {
    if (!existsSync(path.join(root, settings.scenarios))) {
      problems.push(`gif.scenarios: no folder ${settings.scenarios}`);
    } else {
      let count = 0;
      for (const file of scenarioFiles(settings.scenarios, root)) {
        try {
          const module = await loadModule(file, root);
          if (!('default' in module)) {
            log(`gif: ${file} is a helper (no default export)`);
            continue;
          }
          const found = scenarioProblems(module.default);
          problems.push(...found.map((p) => `${file}: ${p}`));
          if (found.length === 0) count += 1;
        } catch (error) {
          problems.push(`${file}: ${error instanceof Error ? error.message : error}`);
        }
      }
      if (count === 0 && problems.length === 0)
        problems.push(`gif.scenarios: no scenario in ${settings.scenarios}`);
      else log(`gif: ${count} scenario(s) in ${settings.scenarios} load`);
    }
  }
  try {
    const { webkit } = await appPlaywright(root);
    const version = playwrightVersion(root);
    const [major, minor] = version;
    const [needMajor, needMinor] = SCREENCAST_SINCE;
    if (typeof webkit?.launch !== 'function') {
      problems.push("the app's Playwright has no webkit.launch");
    } else if (major < needMajor || (major === needMajor && minor < needMinor)) {
      problems.push(
        `the app's Playwright ${version.join('.')} predates page.screencast's frames: update it to ${SCREENCAST_SINCE.join('.')} or later`,
      );
    } else {
      log(
        `gif: the app's Playwright ${version.join('.')} resolves, with WebKit and page.screencast`,
      );
    }
  } catch (error) {
    problems.push(`Playwright: ${error instanceof Error ? error.message : error}`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(process.argv[2] ?? '.');
  const problems = await selftest(root);
  for (const problem of problems) console.error(`gif selftest: ${problem}`);
  process.exitCode = problems.length > 0 ? 1 : 0;
}
