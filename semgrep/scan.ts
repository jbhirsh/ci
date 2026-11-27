// Static analysis (Semgrep SAST) as a blocking PR gate and a weekly drift
// sensor: semgrep/action.yml installs the free CLI and runs this from the
// app's checkout. `--config auto` pulls the public registry's rulesets
// anonymously (no SEMGREP_APP_TOKEN, no platform account), and `--error`
// exits non-zero on any finding, so a new SAST issue can't merge without
// being fixed or precisely allowlisted. The registry's rules evolve, so the
// weekly run surfaces new rules matching merged code.
//
// Settings, `semgrep` in the app's .github/ci.json:
//   paths  what to scan, relative to the checkout (default: the whole
//          tree). An app scanning only its own source lists it here, e.g.
//          ["src", "__tests__", "modules", "index.ts"].
//
// EXCLUDED_RULES below are the apps' shared allowlist: each is a finding
// that conflicts with a convention all three apps chose, never a code
// vulnerability. Removing one is how to re-enable it; there is no inline
// `// nosemgrep` and no `.semgrepignore`.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig, appRoot } from '../lib/app.mjs';

export const EXCLUDED_RULES = [
  // The apps track floating major action tags (@v7) for patch and minor
  // updates, a trade-off they accepted over SHA pinning.
  'yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag',
  // Supply-chain policy suggestions (delay newly published versions), not
  // defects: adopting them changes how dependencies update, a deliberate
  // dependency-policy decision rather than this gate's.
  'package_managers.dependabot.dependabot-missing-cooldown.dependabot-missing-cooldown',
  'package_managers.npm.npm-missing-minimum-release-age.npm-missing-minimum-release-age',
];

/**
 * The app's `semgrep` settings, checked.
 *
 * @param {Record<string, unknown>} config
 * @returns {{ paths: string[] }}
 */
export function settings(config) {
  const { paths = [] } = config;
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && p !== '')) {
    throw new Error('.github/ci.json: semgrep.paths must be a list of paths');
  }
  for (const p of paths) {
    if (path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) {
      throw new Error(`.github/ci.json: semgrep.paths must stay in the checkout: ${p}`);
    }
  }
  return { paths };
}

/**
 * Semgrep's command line for these settings.
 *
 * @param {{ paths: string[] }} options
 * @returns {string[]}
 */
export function semgrepArgs({ paths }) {
  return [
    'scan',
    '--config',
    'auto',
    '--error',
    ...EXCLUDED_RULES.flatMap((rule) => ['--exclude-rule', rule]),
    ...(paths.length > 0 ? paths : ['.']),
  ];
}

/**
 * The settings' paths that aren't in the checkout.
 *
 * @param {{ paths: string[] }} options
 * @param {string} root
 * @returns {string[]}
 */
export function missingPaths({ paths }, root) {
  return paths.filter((p) => !existsSync(path.join(root, p)));
}

/**
 * Runs Semgrep over the app's checkout and returns its exit code.
 *
 * @param {string} root
 * @param {(command: string, args: string[], cwd: string) => number | null} run runs a command
 *   with its output shown, returning its exit code
 * @param {(line: string) => void} [log]
 */
export function main(root, run, log = console.error) {
  const options = settings(appConfig('semgrep', root));
  const missing = missingPaths(options, root);
  if (missing.length > 0) {
    log(`::error::semgrep.paths names what isn't there: ${missing.join(', ')}`);
    return 1;
  }
  return run('semgrep', semgrepArgs(options), root) ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(appRoot(), (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status;
  });
}
