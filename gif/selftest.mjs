// Checks, without recording anything, that the GIF tool can run for an app:
//
//   node gif/selftest.mjs <app checkout>
//
// Read-only, and with no browser or ffmpeg (this repo's CI runs it against
// each app's main with only `npm ci --ignore-scripts` done there):
//   - its `gif` settings parse (an app without the key is checked against
//     the defaults, and nothing more is asked of it);
//   - a web app's setup module, if it names one, loads through the app's
//     own Vite and exports the shape cli.mjs calls (scenario.mjs);
//   - each module in its scenarios folder, if it names one, loads and
//     exports a scenario of the shape cli.mjs plays (a module there with no
//     default export is a helper the scenarios share, and is passed over);
//   - and the app's Playwright, which cli.mjs records with, resolves.
// Prints what it checked; exits non-zero, naming each problem, on any.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig } from '../lib/app.mjs';
import { appPlaywright } from './cli.mjs';
import { loadModule, scenarioFiles, scenarioProblems, setupProblems } from './scenario.mjs';
import { parseSettings } from './settings.mjs';

/**
 * The problems found in the app at `root`, saying what it checked to `log`.
 *
 * @param {string} root
 * @param {(line: string) => void} [log]
 * @returns {Promise<string[]>}
 */
export async function selftest(root, log = console.log) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Record<string, unknown>} */
  let raw;
  /** @type {import('./settings.mjs').GifSettings} */
  let settings;
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
  if (settings.source === 'ci-videos') return problems;

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
    const { chromium } = await appPlaywright(root);
    if (typeof chromium?.launch !== 'function')
      problems.push("the app's Playwright has no chromium.launch");
    else log("gif: the app's Playwright resolves");
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
