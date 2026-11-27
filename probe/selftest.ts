// Checks, without probing anything, that the probe can run for an app:
//
//   node probe/selftest.ts <app checkout>
//
// With no `probe` key in the app's `.github/ci.json`, the app doesn't use
// the probe yet, and that's said, not failed. With one, it checks that
//   - the settings parse (settings.ts);
//   - the app's lockfile pins Playwright, the release web/action.yml
//     installs alone (lib/app.ts's appPackageVersion);
//   - a workflow calls jbhirsh/ci/probe/web@.
// The workflows are read as text: the self-test runs with this repo's
// runtime packages only, which hold no YAML parser, and launches no
// browser. Prints what it checked; exits non-zero, naming each problem.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appPackageVersion } from '../lib/app.ts';
import { loadSettings } from './settings.ts';
import type { ProbeSettings } from './settings.ts';

const CALL = 'jbhirsh/ci/probe/web@';

/**
 * The problems found in the app at `root`, saying what it checked to `log`.
 */
export function selftest(root: string, log: (line: string) => void = console.log): string[] {
  let settings: ProbeSettings | null;
  try {
    settings = loadSettings(root);
  } catch (error) {
    return [`settings: ${error instanceof Error ? error.message : error}`];
  }
  if (!settings) {
    log("probe: no probe settings; the app doesn't use the probe yet");
    return [];
  }
  log(
    `probe: settings parse (${settings.pages.length} page(s), ${settings.requests.length} request(s) to time)`,
  );
  const problems: string[] = [];
  try {
    log(`probe: the app's lockfile pins Playwright ${appPackageVersion(root, 'playwright')}`);
  } catch (error) {
    problems.push(`Playwright: ${error instanceof Error ? error.message : error}`);
  }
  const dir = path.join(root, '.github', 'workflows');
  const callers = existsSync(dir)
    ? readdirSync(dir).filter(
        (file) =>
          /\.ya?ml$/.test(file) && readFileSync(path.join(dir, file), 'utf8').includes(CALL),
      )
    : [];
  if (callers.length === 0) problems.push(`no workflow in .github/workflows calls ${CALL}main`);
  else log(`probe: ${callers.join(', ')} call${callers.length === 1 ? 's' : ''} it`);
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const problems = selftest(path.resolve(process.argv[2] ?? '.'));
  for (const problem of problems) console.error(`probe selftest: ${problem}`);
  process.exitCode = problems.length > 0 ? 1 : 0;
}
