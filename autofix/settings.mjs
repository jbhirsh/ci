// Claude autofix's settings: the `autofix` key of the app's
// `.github/ci.json`, read from the default branch (../review/config.mjs says
// why). Each is the app's own; nothing here adds a check to an app.
//
//   "autofix": {
//     "ciFixChecks": ["`npm run lint`", "`npm run typecheck`", ...],
//     "reviewFixChecks": ["`npm run lint`", ...],
//     "cannotRun": ["visual regression", "deployment smoke tests"],
//     "exempt": { "PR visuals": "wants pictures in the description" }
//   }
//
// - ciFixChecks: what the CI fixer (ci-fix.md) must get green before it
//   pushes a fix for a red Dependabot bump, one Markdown list item each
//   (a command in backticks, with a note if it needs one; commands.mjs says
//   which forms, and the self-test fails one the app can't run). Not a
//   second CI: autofix proving its own fix, so it never pushes what CI will
//   reject. So the list mirrors the steps of the app's CI that can run in
//   the autofix job. Default: the `run:` steps of the app's
//   `.github/workflows/ci.yml`.
// - reviewFixChecks: what the review fixer (review-fix.md) runs after
//   folding its fixes in, before it force-pushes. Default: the same as
//   ciFixChecks.
// - cannotRun: the kinds of failing check the fixer can't reproduce in its
//   job (it fixes only what their logs make certain). Default: E2E, visual
//   regression, deployment smoke tests, mutation testing.
// - exempt: pull-request workflows that must not wake autofix, by `name:`,
//   each with the reason (a comment JSON can't hold otherwise). Every other
//   one must be in the stub's `on.workflow_run.workflows`
//   (check-triggers.mjs), and the CI fixer doesn't wait for an exempt one's
//   runs (gate.mjs), since its completion wakes nothing. Default: none.

import { loadConfig, onlyKnownKeys, stringList } from '../review/config.mjs';

export const DEFAULT_CHECKS = [
  'the `run:` steps of `.github/workflows/ci.yml` that can run here (copy their commands)',
];
export const DEFAULT_CANNOT_RUN = [
  'E2E',
  'visual regression',
  'deployment smoke tests',
  'mutation testing',
];

/**
 * @typedef {object} AutofixSettings
 * @property {string[]} ciFixChecks
 * @property {string[]} reviewFixChecks
 * @property {string[]} cannotRun
 * @property {Record<string, string>} exempt workflow name → why
 */

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function reasons(value) {
  if (value === undefined) return {};
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !Object.values(value).every((v) => typeof v === 'string' && v.trim() !== '')
  ) {
    throw new Error(
      '.github/ci.json: "autofix.exempt" must map each workflow name to the reason it is exempt',
    );
  }
  return /** @type {Record<string, string>} */ (value);
}

/**
 * @param {{ root: string, ref?: string }} where
 * @returns {AutofixSettings}
 */
export function autofixSettings(where) {
  const section = loadConfig('autofix', where);
  onlyKnownKeys('autofix', section, ['ciFixChecks', 'reviewFixChecks', 'cannotRun', 'exempt']);
  const ciFixChecks = stringList('autofix.ciFixChecks', section.ciFixChecks, DEFAULT_CHECKS);
  return {
    ciFixChecks,
    reviewFixChecks: stringList('autofix.reviewFixChecks', section.reviewFixChecks, ciFixChecks),
    cannotRun: stringList('autofix.cannotRun', section.cannotRun, DEFAULT_CANNOT_RUN),
    exempt: reasons(section.exempt),
  };
}
