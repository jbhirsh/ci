// Claude Review's self-test against an app checkout, run by this repo's CI
// for each app (`node review/selftest.mjs <app checkout>`). It checks what
// can be checked without GitHub or Claude:
//   - the app's `review` settings parse (settings.mjs), from its working
//     tree; an app with no `review` key is checked against the defaults;
//   - each `review.skip` glob still matches a tracked file (a stale glob
//     would let the review skip a file it should read);
//   - both prompts render with nothing left unfilled, the app's guide in
//     them;
//   - the coverage rules (coverage.mjs) judge the fixture transcripts in
//     fixtures/ as they should, the app's skip globs applied.
// Prints what it checked; exits 1 on the first problem.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { globToRegExp, toolCalls, unreadFiles } from './coverage.mjs';
import { renderPrompt } from './render.mjs';
import { reviewSettings } from './settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} name
 * @returns {import('./coverage.mjs').ToolCall[]}
 */
function fixture(name) {
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));
  return toolCalls(parsed);
}

/**
 * The app's tracked files, or null when it isn't a git checkout.
 *
 * @param {string} root
 * @returns {string[] | null}
 */
function trackedFiles(root) {
  try {
    return execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Runs every check; returns the lines to print, throwing on a failure.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function selftest(root) {
  const log = [];
  const settings = reviewSettings({ root });
  log.push(
    settings.instructions
      ? `settings: guide ${settings.instructions} (${settings.guide.length} characters), ${settings.skip.length} skip glob(s)`
      : 'settings: none in .github/ci.json, checked against the defaults',
  );

  const tracked = trackedFiles(root);
  if (tracked) {
    for (const glob of settings.skip) {
      const re = globToRegExp(glob);
      if (!tracked.some((f) => re.test(f))) {
        throw new Error(`review.skip: "${glob}" matches no tracked file`);
      }
    }
    log.push(`skip globs: each matches a tracked file`);
  }

  const run = { repo: 'jbhirsh/app', pr: '1', base: 'main', repoDir: root };
  for (const pass of /** @type {const} */ (['review', 'followup'])) {
    const prompt = renderPrompt(pass, settings, { ...run, unread: ['src/a.ts'] });
    if (settings.guide && !prompt.includes(settings.guide)) {
      throw new Error(`the ${pass} prompt is missing the app's guide`);
    }
    log.push(`${pass} prompt: renders, ${prompt.length} characters`);
  }

  const changed = [
    'src/utils/sorting.ts',
    '__tests__/unit/sorting.test.ts',
    '__tests__/fixtures/sessions/v8.json',
    'package-lock.json',
  ];
  const options = { repoDir: root, skip: settings.skip };
  const all = unreadFiles(changed.slice(0, 2), fixture('read-all.json'), options);
  if (all.length > 0) throw new Error(`coverage: read-all.json left ${all.join(', ')} unread`);
  const missed = unreadFiles(changed, fixture('stat-only.json'), options).join(', ');
  const expected = '__tests__/unit/sorting.test.ts, __tests__/fixtures/sessions/v8.json';
  if (missed !== expected) {
    throw new Error(`coverage: stat-only.json left "${missed}" unread, not "${expected}"`);
  }
  log.push('coverage: the fixture transcripts are judged as expected');
  return log;
}

/* c8 ignore start: the CLI's lines, run by CI */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2] ?? '.');
  try {
    for (const line of selftest(root)) console.log(`review: ${line}`);
  } catch (error) {
    console.error(`review: FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
/* c8 ignore stop */
