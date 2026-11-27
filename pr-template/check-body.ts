// The description check, as the PR description action runs it (ci#79, ci#112):
// `node pr-template/check-body.ts`, with the PR in the environment (PR_BODY,
// PR_AUTHOR, PR_STATE, PR_HEAD_REF, PR_HEAD_SHA, PR_ACTION). It holds a PR's description to
// the shared shape (body.ts says what that is), in every app: there is no
// setting to turn it off, and a draft is checked like any other PR (PRs are
// opened as drafts, and a red draft blocks nothing, so the author hears at
// once). It passes, saying why:
//   - a closed PR, since rewriting old descriptions edits closed PRs;
//   - Dependabot's PRs, and a PR from a `bot/` branch (the README screenshots
//     and baseline refreshes): their text is a tool's, not an author's.

import { pathToFileURL } from 'node:url';
import { bodyProblems } from './body.ts';

/**
 * @typedef {object} Pr
 * @property {string | undefined} body
 * @property {string} [author]
 * @property {string} [state] open or closed
 * @property {string} [headRef]
 * @property {string} [headSha] Revisions' current row must name it
 * @property {string} [action] the event's action: `synchronize` is a push
 */

/**
 * The check's exit code and what to print.
 *
 * @param {Pr} pr
 * @returns {{ code: number, message: string }}
 */
export function report(pr) {
  const pass = (/** @type {string} */ why) => ({
    code: 0,
    message: `PR description: ok (${why}).`,
  });
  if (pr.author === 'dependabot[bot]') return pass("Dependabot's PR");
  if (pr.headRef?.startsWith('bot/')) return pass("a bot's PR");
  if (pr.state === 'closed') return pass('closed PR');
  const problems = bodyProblems(pr.body, pr.headSha, {
    pushed: pr.action === 'synchronize',
  });
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
 * The check for the PR in `env`.
 *
 * @param {Record<string, string | undefined>} env
 */
export function run(env) {
  return report({
    body: env.PR_BODY,
    author: env.PR_AUTHOR,
    state: env.PR_STATE,
    headRef: env.PR_HEAD_REF,
    headSha: env.PR_HEAD_SHA,
    action: env.PR_ACTION,
  });
}

/**
 * Runs the check for the PR in `env` and returns the exit code.
 *
 * @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} [log]
 * @returns {number}
 */
export function main(env, log = console.log) {
  const { code, message } = run(env);
  log(message);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.env);
}
