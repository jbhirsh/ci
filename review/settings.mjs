// Claude Review's settings: the `review` key of the app's `.github/ci.json`,
// read from the PR's base branch (config.mjs says why).
//
//   "review": {
//     "instructions": ".github/claude-review.md",
//     "skip": ["src/gql/**"],
//     "engine": "sdk",
//     "advisor": "opus",
//     "skipBots": ["dependabot[bot]"]
//   }
//
// - instructions: a Markdown file in the app holding what only that app's
//   review needs: what the app is, its focus areas, its server-side gates,
//   where its data lives, its architecture rules. It goes into the prompt
//   as-is (prompt.md, `{{appGuide}}`), so write it as Markdown sections
//   (`## ...`) addressed to the reviewer. Like the shared prompt, it must
//   not ask for anything an automated check of the app already decides.
//   Default: none; the shared prompt and the app's CLAUDE.md stand alone.
// - skip: globs (repo-relative; `*` within a folder, `**` across folders)
//   of generated files the review may skim rather than read whole, as it
//   may lockfiles, images and fonts; the coverage check (coverage.mjs)
//   doesn't count them. Default: none.
// - engine: ignored. The review runs on the Claude Agent SDK (sdk.mjs), the
//   only engine since claude-code-action went (jbhirsh/ci#68). The apps
//   still set "sdk", so "sdk" is accepted and anything else fails; a later
//   change drops the key once no repo sets it.
// - advisor: the model Sonnet may consult on a hard call (the
//   advisor tool), e.g. "opus". Default: none. Each review's step summary
//   shows whether it ran and what it cost.
// - skipBots: bots whose PRs aren't reviewed while every commit on them is
//   theirs (skip.mjs): a Dependabot bump that passes CI needs no review,
//   but once autofix pushes a fix (a github-actions[bot] commit, pushed
//   with the app's BOT_PR_TOKEN) the PR is reviewed. Such a PR auto-merges
//   on CI alone. Default: none.
//
// CLI: `node settings.mjs`, run from the app's checkout, with CONFIG_REF
// (where to read them, `origin/<base>`). Step outputs `advisor` and
// `skip_bots` (one per line), for action.yml's steps.

import { pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { appRoot } from '../lib/app.mjs';
import {
  advisorSetting,
  checkEngine,
  loadConfig,
  onlyKnownKeys,
  readAppFile,
  stringList,
} from './config.mjs';

/**
 * @typedef {object} ReviewSettings
 * @property {string | null} instructions the guide's path, if the app names one
 * @property {string} guide the guide's text ('' without one)
 * @property {string[]} skip
 * @property {string | null} advisor the advisor model, if any
 * @property {string[]} skipBots
 */

/**
 * @param {{ root: string, ref?: string }} where
 * @returns {ReviewSettings}
 */
export function reviewSettings(where) {
  const section = loadConfig('review', where);
  onlyKnownKeys('review', section, ['instructions', 'skip', 'engine', 'advisor', 'skipBots']);
  const skip = stringList('review.skip', section.skip, []);
  checkEngine('review.engine', section.engine);
  const advisor = advisorSetting('review.advisor', section.advisor);
  const skipBots = stringList('review.skipBots', section.skipBots, []);
  const rest = { skip, advisor, skipBots };
  const { instructions } = section;
  if (instructions === undefined) return { instructions: null, guide: '', ...rest };
  if (typeof instructions !== 'string' || instructions.trim() === '') {
    throw new Error('.github/ci.json: "review.instructions" must be a file path');
  }
  const guide = readAppFile(instructions, where);
  if (guide === null) {
    throw new Error(
      `.github/ci.json: "review.instructions" names ${instructions}, which ${where.ref ?? 'the checkout'} doesn't hold`,
    );
  }
  return { instructions, guide: guide.trim(), ...rest };
}

/* c8 ignore start: the CLI's lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const settings = reviewSettings({ root: appRoot(), ref: process.env.CONFIG_REF || undefined });
  setOutput('advisor', settings.advisor ?? '');
  setOutput('skip_bots', settings.skipBots.join('\n'));
}
/* c8 ignore stop */
