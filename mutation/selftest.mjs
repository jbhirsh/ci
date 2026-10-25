// Checks the mutation tooling against an app's checkout, read-only, as this
// repo's CI does for each app's main before a change here can merge:
//   - its `mutation` settings parse (the defaults when it has none), and its
//     Stryker config has a `mutate` list;
//   - the smoke scope's files exist and the `mutate` globs take them, and a
//     per-file threshold comes with the `json` reporter it reads;
//   - the PR scope runs on the app's last commit (HEAD against its parent),
//     with the app's Prettier when it's installed;
//   - the sweep plans: every in-scope tracked file in exactly one shard, and
//     the shard config written without a break threshold.
// A wiring glob that matches no tracked file is only a warning: the defaults
// name files not every app has.
//
// Usage: node selftest.mjs <app checkout>   Exits 1 on any failure.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readText } from './report.mjs';
import { gitIn, inMutateScope, scopeFor } from './scope.mjs';
import { readSettings, readStrykerConfig, wiringGlobs } from './settings.mjs';
import { plan, shardConfig } from './sweep.mjs';

/**
 * Runs the checks against the app at `root`, reporting through `log`.
 * Returns the number of failures.
 *
 * @param {string} root
 * @param {(line: string) => void} [log]
 */
export async function selftest(root, log = console.log) {
  let failed = 0;
  /**
   * @param {string} name
   * @param {() => unknown} check
   */
  const step = async (name, check) => {
    try {
      const note = await check();
      log(`ok    ${name}${note ? `: ${String(note)}` : ''}`);
    } catch (error) {
      failed++;
      log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  /** @type {import('./settings.mjs').Settings | undefined} */
  let settings;
  /** @type {import('./settings.mjs').StrykerConfig | undefined} */
  let config;
  await step('settings parse', () => {
    settings = readSettings(root);
    config = readStrykerConfig(settings, root);
    return `${config.mutate.length} mutate glob(s), ${settings.sweep.shards} shard(s)`;
  });
  if (!settings || !config) return failed;
  const s = settings;
  const c = config;
  const tracked = gitIn(root)('ls-files', '-z').split('\0').filter(Boolean);

  await step('smoke scope', () => {
    for (const file of s.smoke) {
      if (!tracked.includes(file)) throw new Error(`${file} isn't a tracked file`);
      if (!inMutateScope(file, c.mutate)) throw new Error(`the mutate globs don't take ${file}`);
    }
    return s.smoke.length > 0 ? s.smoke.join(', ') : 'none (a setup-only PR skips Stryker)';
  });
  await step('per-file gate', () => {
    if (s.perFileThreshold !== null && !c.reporters.includes('json')) {
      throw new Error('perFileThreshold needs the json reporter in the Stryker config');
    }
    return s.perFileThreshold === null ? 'off' : `${s.perFileThreshold}%`;
  });
  for (const glob of wiringGlobs(s)) {
    if (!tracked.some((file) => path.matchesGlob(file, glob))) {
      log(`warn  wiring glob ${glob} matches no tracked file`);
    }
  }
  await step('scope on the last commit', async () => {
    let parent;
    try {
      parent = gitIn(root)('rev-parse', '--verify', '-q', 'HEAD^').trim();
    } catch {
      return 'skipped: HEAD has no parent';
    }
    const { entries, reason } = await scopeFor(root, parent);
    return `${reason}${entries.length > 0 ? ` (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})` : ''}`;
  });
  await step('sweep plan', () => {
    const { shards } = plan({
      tracked,
      mutate: c.mutate,
      results: null,
      lines: (file) => (readText(path.join(root, file)) ?? '').split('\n').length,
      count: s.sweep.shards,
      cwd: root,
    });
    const inScope = tracked.filter((file) => inMutateScope(file, c.mutate)).sort();
    const planned = shards.flatMap((shard) => shard.files).sort();
    if (inScope.length === 0) throw new Error('the mutate globs take no tracked file');
    if (JSON.stringify(planned) !== JSON.stringify(inScope)) {
      throw new Error('the shards do not hold every in-scope file exactly once');
    }
    const shard = shardConfig(c.raw);
    if (/** @type {{ break?: unknown }} */ (shard.thresholds).break !== null) {
      throw new Error('the shard config keeps a break threshold');
    }
    return `${inScope.length} file(s) in ${shards.length} shard(s)`;
  });
  return failed;
}

/**
 * The command line: `<app checkout>`. Returns the exit code.
 *
 * @param {string[]} args
 */
export async function main(args) {
  const [dir] = args;
  if (!dir) {
    console.error('Usage: selftest.mjs <app checkout>');
    return 2;
  }
  const failed = await selftest(path.resolve(dir));
  return failed > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
