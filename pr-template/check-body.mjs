// The description check, as the PR visuals action runs it (ci#79):
// `node pr-template/check-body.mjs`, with the PR in the environment (PR_BODY,
// PR_AUTHOR, PR_STATE, PR_DRAFT, PR_HEAD_REF, PR_HEAD_SHA). It holds a PR's description to
// the shared shape (body.mjs says what that is) when the app sets
// `visuals.sharedTemplate`, and passes without looking otherwise, so an app
// that hasn't adopted the template is unchanged. It passes, saying why:
//   - a draft, which is still being written (`ready_for_review` re-runs it);
//   - a closed PR, since rewriting old descriptions edits closed PRs;
//   - Dependabot's PRs, and a PR from a `bot/` branch (the README screenshots
//     and baseline refreshes): their text is a tool's, not an author's.
// It is not part of checkPrVisuals: visual review reads that verdict, and a
// description's shape isn't a UI picture.

import { pathToFileURL } from 'node:url';
import { appConfig, appRoot } from '../lib/app.mjs';
import { settings } from '../visuals/check.mjs';
import { bodyProblems } from './body.mjs';

/**
 * @typedef {object} Pr
 * @property {string | undefined} body
 * @property {string} [author]
 * @property {string} [state] open or closed
 * @property {boolean} [draft]
 * @property {string} [headRef]
 * @property {string} [headSha] Revisions' current row must name it
 */

/**
 * The check's exit code and what to print.
 *
 * @param {Pr} pr
 * @param {boolean} enabled the app's `visuals.sharedTemplate`
 * @returns {{ code: number, message: string }}
 */
export function report(pr, enabled) {
  const pass = (/** @type {string} */ why) => ({
    code: 0,
    message: `PR description: ok (${why}).`,
  });
  if (!enabled) return pass('the app has not set visuals.sharedTemplate');
  if (pr.author === 'dependabot[bot]') return pass("Dependabot's PR");
  if (pr.headRef?.startsWith('bot/')) return pass("a bot's PR");
  if (pr.state === 'closed') return pass('closed PR');
  if (pr.draft) return pass('a draft, checked when it is ready for review');
  const problems = bodyProblems(pr.body, pr.headSha);
  if (problems.length === 0) return pass('in the shared shape');
  return {
    code: 1,
    message: [
      "::error::This PR's description isn't in the shared shape.",
      ...problems.map((p) => `  - ${p}`),
      "The template is the app's `.github/pull_request_template.md` (jbhirsh/ci's `.github/pull_request_template.md` is the master). Editing the description re-runs this check.",
    ].join('\n'),
  };
}

/**
 * The check for the PR in `env`, with the app at `root`.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} root
 */
export function run(env, root) {
  return report(
    {
      body: env.PR_BODY,
      author: env.PR_AUTHOR,
      state: env.PR_STATE,
      draft: env.PR_DRAFT === 'true',
      headRef: env.PR_HEAD_REF,
      headSha: env.PR_HEAD_SHA,
    },
    Boolean(settings(appConfig('visuals', root)).sharedTemplate),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, message } = run(process.env, appRoot());
  console.log(message);
  process.exitCode = code;
}
