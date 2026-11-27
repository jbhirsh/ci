// Claude Review's self-test against an app checkout, run by this repo's CI
// for each app (`node review/selftest.ts <app checkout>`). It checks what
// can be checked without GitHub or Claude:
//   - the app's `review` settings parse (settings.ts), from its working
//     tree; an app with no `review` key is checked against the defaults;
//   - each `review.skip` glob still matches a tracked file (a stale glob
//     would let the review skip a file it should read);
//   - both prompts render with nothing left unfilled, the app's guide in
//     them;
//   - the coverage rules (coverage.ts) judge the fixture transcripts in
//     fixtures/ as they should, the app's skip globs applied, the SDK's
//     (sdk-read-all.json) among them;
//   - the carry-over's context (carry.ts) reads the app's settings and
//     CLAUDE.md, and the fixture passes' result (result.ts) is a finished
//     review;
//   - BoardGames #320's usage-limit stop (usage-limit.json) reads as a
//     limit (sdk.ts), with its name and reset for the comment (stopped.ts).
// Prints what it checked; exits 1 on the first problem.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { currentContext } from './carry.ts';
import { globToRegExp, toolCalls, unreadFiles } from './coverage.ts';
import { renderPrompt } from './render.ts';
import { judge } from './result.ts';
import { stoppedBy } from './sdk.ts';
import { reviewSettings } from './settings.ts';
import { limitOf } from './stopped.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} name
 * @returns {unknown}
 */
function execution(name) {
  return JSON.parse(readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));
}

/**
 * @param {string} name
 * @returns {import('./coverage.ts').ToolCall[]}
 */
function fixture(name) {
  return toolCalls(execution(name));
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
      : 'settings: no guide, checked against the defaults',
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
  for (const name of ['read-all.json', 'sdk-read-all.json']) {
    const all = unreadFiles(changed.slice(0, 2), fixture(name), options);
    if (all.length > 0) throw new Error(`coverage: ${name} left ${all.join(', ')} unread`);
  }
  const missed = unreadFiles(changed, fixture('stat-only.json'), options).join(', ');
  const expected = '__tests__/unit/sorting.test.ts, __tests__/fixtures/sessions/v8.json';
  if (missed !== expected) {
    throw new Error(`coverage: stat-only.json left "${missed}" unread, not "${expected}"`);
  }
  log.push('coverage: the fixture transcripts are judged as expected');

  if (!/^[0-9a-f]{64}$/.test(currentContext({ root, base: 'main' }))) {
    throw new Error('carry-over: no context hash');
  }
  if (!judge(execution('read-all.json')).finished) {
    throw new Error('result: read-all.json is not a finished review');
  }
  log.push("carry-over: the app's context hashes; the fixture review finished");

  const limited = /** @type {unknown[]} */ (execution('usage-limit.json'));
  const limit = limitOf(limited, Date.UTC(2026, 10, 13, 22));
  if (stoppedBy(limited, '') !== 'limit' || limit.name !== '5-hour limit' || !limit.resets) {
    throw new Error("stopped: usage-limit.json isn't read as a 5-hour limit with a reset");
  }
  log.push('stopped: the usage-limit fixture reads as a 5-hour limit, with its reset');
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
