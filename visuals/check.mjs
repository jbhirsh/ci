// The "PR visuals" check: fails a PR that changes how the app looks but
// shows none of it. Reviewers can't judge a UI change from its diff. Reads
// the PR's changed files (one path per line on stdin) and its description
// (PR_BODY). A change to a UI file needs a picture in the description (an
// image, a GIF or a GitHub-uploaded video), or the template's ticked "No
// visible UI change" box for a change nobody can see (a refactor, a type, a
// test helper). Whether a change to motion also needs a GIF is a judgment
// call, so Claude Review makes it, not this script. Where the pictures are
// hosted is up to the app: any image counts.
//
// Dependabot's PRs pass (PR_AUTHOR): its bumps show nothing on screen, and
// when autofix has to touch a component to keep one building, no one is
// there to add pictures, so the required check would hold it forever.
//
// Settings, `visuals` in the app's .github/ci.json:
//   ui      globs of the files that change how the app looks (lib/match.mjs
//           says how they match); default DEFAULT_UI
//   notUi   globs among those that draw nothing (tests, providers, entry
//           points); default DEFAULT_NOT_UI
//   advice  what to tell the author when it fails, after the list of files:
//           how this app's pictures are taken; default DEFAULT_ADVICE
//   sharedTemplate  true: the app uses the shared PR template (ci#79), which has
//           no "No visible UI change" box, and visual review decides whether a
//           screen changed. This check then passes every PR on the rules
//           above; set it only once the app has visual review and `Visual
//           changes` is required. The action's next step holds the PR's
//           description to the shared shape (pr-template/check-body.mjs), and
//           pr-template/selftest.mjs holds the app's template to the master's
//           shape. Default false: the rules above, as before.
//   (`fromBaselines`, which made a PR's changed visual baselines its
//   pictures, is gone with the baselines; a leftover one in ci.json is
//   ignored.)
// UI that changes through a file the globs don't name isn't caught, nor is a
// reference-style markdown image (![alt][ref]). Reviewers cover those.

import { pathToFileURL } from 'node:url';
import { readAll } from '../lib/actions.mjs';
import { appConfig, appRoot } from '../lib/app.mjs';
import { globList, pick } from '../lib/match.mjs';
import { visibleText } from '../pr-template/structure.mjs';

export const DEFAULT_UI = ['src/**/*.{tsx,css}'];
export const DEFAULT_NOT_UI = ['**/*.test.*', '**/__tests__/**', 'src/test/**'];
export const DEFAULT_ADVICE =
  'Add before/after screenshots to the description (a GIF when the change affects motion or ' +
  'interaction), or tick "No visible UI change" in the template. Editing the description ' +
  're-runs this check.';

/**
 * @typedef {object} Settings
 * @property {string[]} ui
 * @property {string[]} notUi
 * @property {string} advice
 * @property {true} [sharedTemplate] set only when on, so the settings without it are
 *   what they were before it came in
 */

/**
 * The app's `visuals` settings, checked, with the defaults filled in.
 *
 * @param {Record<string, unknown>} config
 * @returns {Settings}
 */
export function settings(config) {
  const { advice = DEFAULT_ADVICE, sharedTemplate = false } = config;
  if (typeof advice !== 'string' || advice.trim() === '') {
    throw new Error('.github/ci.json: visuals.advice must be text');
  }
  if (typeof sharedTemplate !== 'boolean') {
    throw new Error('.github/ci.json: visuals.sharedTemplate must be true or false');
  }
  return {
    ui: globList(config.ui, 'visuals.ui', DEFAULT_UI),
    notUi: globList(config.notUi, 'visuals.notUi', DEFAULT_NOT_UI),
    advice,
    ...(sharedTemplate ? { sharedTemplate } : {}),
  };
}

// Markdown or HTML images (GIFs included), HTML video, and the bare
// user-attachments URL GitHub inserts for a video dropped into the editor.
const VISUAL = [
  /!\[[^\]]*\]\(\s*[^)\s][^)]*\)/,
  /<img\s[^>]*src=/i,
  /<video[\s>]/i,
  /https:\/\/github\.com\/user-attachments\/assets\//,
];
// A ticked box in any list or quote: "- [x] No visible UI change (refactor)".
const OPT_OUT = /^[\s>]*(?:[-*+]|\d+[.)])\s*\[x\]\s*No visible UI change\b/im;

/**
 * @typedef {{ ok: true, reason: string } | { ok: false, ui: string[] }} Verdict
 */

/**
 * @param {{ files: string[], body: string | undefined, author?: string, settings: Settings }} pr
 * @returns {Verdict}
 */
export function checkPrVisuals({ files, body, author, settings: s }) {
  if (author === 'dependabot[bot]') return { ok: true, reason: "Dependabot's PR" };
  if (s.sharedTemplate) return { ok: true, reason: 'visual review decides' };
  const ui = pick(files, { include: s.ui, exclude: s.notUi });
  if (ui.length === 0) return { ok: true, reason: 'no UI files changed' };
  const text = visibleText(body);
  if (OPT_OUT.test(text)) return { ok: true, reason: 'marked "No visible UI change"' };
  if (VISUAL.some((re) => re.test(text))) {
    return { ok: true, reason: 'description shows the change' };
  }
  return { ok: false, ui };
}

/**
 * The check's verdict for the changed files (one per line), as an exit code
 * and what to print.
 *
 * @param {string} fileList
 * @param {{ body: string | undefined, author?: string, settings: Settings }} pr
 */
export function report(fileList, pr) {
  const files = fileList
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const result = checkPrVisuals({ files, ...pr });
  if (result.ok) return { code: 0, message: `PR visuals: ok (${result.reason}).` };
  return {
    code: 1,
    message: [
      '::error::This PR changes the UI but its description shows none of it.',
      'Changed UI files:',
      ...result.ui.map((f) => `  ${f}`),
      pr.settings.advice,
    ].join('\n'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = settings(appConfig('visuals', appRoot()));
  const { code, message } = report(await readAll(), {
    body: process.env.PR_BODY,
    author: process.env.PR_AUTHOR,
    settings: s,
  });
  console.log(message);
  process.exitCode = code;
}
