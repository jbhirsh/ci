// The web probe's entry point, run by probe/web/action.yml from the app's
// checkout of the deployment's commit:
//
//   node probe/web/run.ts version   sets the step output `version`: the
//                                    Playwright release the app's lockfile
//                                    pins, which the action installs alone
//   node probe/web/run.ts           probes the deployment
//
// The probe reads its inputs from the environment, as the action passes
// them:
//   PROBE_URL          the deployment's URL (required)
//   PROBE_ENVIRONMENT  "production" (the default: reads only) or "preview"
//   PROBE_SECRET       Vercel's Protection Bypass for Automation secret, or
//                      empty; only over https, only when the deployment's
//                      host matches `probe.hosts`, and only in the one
//                      request a load makes for Vercel's bypass cookie
//                      (drive.ts)
//   PROBE_RESULTS      where to write the results file (../results.ts)
//   PROBE_PLAYWRIGHT   the folder Playwright is installed in (the app's
//                      checkout when empty)
// It reads the app's `probe` settings (../settings.ts), launches WebKit
// from that Playwright, drives the pages (drive.ts), then always writes
// the results file and the cold/warm table (../table.ts) to the job
// summary, with whatever it has. It exits 1 only when measuring broke
// (drive.ts says when), naming each problem as an error annotation; a slow
// number never fails it.

import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput, summary } from '../../lib/actions.mjs';
import { appPackageVersion, appPlaywright, appRoot, SETTINGS_FILE } from '../../lib/app.mjs';
import { hostMatches } from '../match.ts';
import { writeResults } from '../results.ts';
import { loadSettings } from '../settings.ts';
import { table } from '../table.ts';
import { drive } from './drive.ts';

import type { Results } from '../results.ts';
import type { ProbeSettings } from '../settings.ts';
import type { Browser as FullBrowser } from 'playwright';

type Browser = Pick<FullBrowser, 'newContext' | 'close'>;
type Env = Record<string, string | undefined>;

/** The action's inputs, checked. */
export function readInputs(env: Env): {
  url: string;
  environment: 'production' | 'preview';
  secret: string;
} {
  let url: URL;
  try {
    url = new URL(env.PROBE_URL ?? '');
  } catch {
    throw new Error(`url: "${env.PROBE_URL ?? ''}" isn't a URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('url: must be an http(s) URL with no user or password');
  }
  const environment = env.PROBE_ENVIRONMENT || 'production';
  if (environment !== 'production' && environment !== 'preview') {
    throw new Error(`environment: "${environment}" must be production or preview`);
  }
  return { url: url.href, environment, secret: env.PROBE_SECRET ?? '' };
}

/**
 * Text as a workflow command's data, escaped as `@actions/core` escapes it, so
 * a `%` or a line break can't end the command or start another.
 */
export const commandData = (text: string): string =>
  text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** Launches WebKit from the Playwright installed in `dir`. */
async function launchWebkit(dir: string): Promise<Browser> {
  return (await appPlaywright(dir)).webkit.launch();
}

/**
 * Probes the deployment, writes the results file and the summary's table,
 * and returns the exit code.
 */
export async function run({
  env = process.env,
  root = appRoot(),
  launch = launchWebkit,
}: { env?: Env; root?: string; launch?: (dir: string) => Promise<Browser> } = {}): Promise<number> {
  const file = env.PROBE_RESULTS || path.join(tmpdir(), 'probe', 'results.json');
  const results: Results = {
    version: 1,
    driver: 'web',
    target: '',
    environment: '',
    measurements: [],
    notes: [],
  };
  let problems: string[] = [];
  let settings: ProbeSettings | null = null;
  try {
    const { url, environment, secret } = readInputs(env);
    results.target = url;
    results.environment = environment;
    settings = loadSettings(root);
    if (!settings) throw new Error(`${SETTINGS_FILE} has no probe key: nothing to probe`);
    if (secret) {
      if (new URL(url).protocol !== 'https:') {
        throw new Error(
          "bypass-secret: the url must be https, or the secret would cross the network in the clear, so it isn't sent",
        );
      }
      const host = new URL(url).hostname;
      if (!settings.hosts.some((glob) => hostMatches(host, glob))) {
        throw new Error(
          `bypass-secret: ${host} matches none of probe.hosts (${settings.hosts.join(', ') || 'none'}), so the secret isn't sent`,
        );
      }
    }
    const browser = await launch(env.PROBE_PLAYWRIGHT || root);
    try {
      const outcome = await drive({ browser, settings, target: url, environment, secret });
      results.measurements = outcome.measurements;
      results.notes = outcome.notes;
      problems = outcome.problems;
    } finally {
      await browser.close();
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  results.notes.push(...problems.map((problem) => `measuring broke: ${problem}`));
  writeResults(file, results);
  summary(table(results, { repeats: settings?.repeats }));
  for (const problem of problems) {
    console.error(`::error title=Performance probe::${commandData(problem)}`);
  }
  return problems.length > 0 ? 1 : 0;
}

/** Sets the `version` output: the Playwright release the app pins. */
export function version(root: string = appRoot()): void {
  setOutput('version', appPackageVersion(root, 'playwright'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === 'version') {
    try {
      version();
    } catch (error) {
      console.error(
        `::error title=Performance probe::${commandData(error instanceof Error ? error.message : String(error))}`,
      );
      process.exitCode = 1;
    }
  } else {
    process.exitCode = await run();
  }
}
