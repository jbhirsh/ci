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
//   ui      globs of the files that change how the app looks (visuals/match.mjs
//           says how they match); default DEFAULT_UI
//   notUi   globs among those that draw nothing (tests, providers, entry
//           points); default DEFAULT_NOT_UI
//   advice  what to tell the author when it fails, after the list of files:
//           how this app's pictures are taken; default DEFAULT_ADVICE
// UI that changes through a file the globs don't name isn't caught, nor is a
// reference-style markdown image (![alt][ref]). Reviewers cover those.

import { pathToFileURL } from 'node:url';
import { readAll } from '../lib/actions.mjs';
import { appConfig, appRoot } from '../lib/app.mjs';
import { globList, pick } from './match.mjs';

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
 */

/**
 * The app's `visuals` settings, checked, with the defaults filled in.
 *
 * @param {Record<string, unknown>} config
 * @returns {Settings}
 */
export function settings(config) {
  const { advice = DEFAULT_ADVICE } = config;
  if (typeof advice !== 'string' || advice.trim() === '') {
    throw new Error('.github/ci.json: visuals.advice must be text');
  }
  return {
    ui: globList(config.ui, 'visuals.ui', DEFAULT_UI),
    notUi: globList(config.notUi, 'visuals.notUi', DEFAULT_NOT_UI),
    advice,
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
 * Drops HTML comments the way GitHub's renderer hides them: from each `<!--`
 * to the next `-->`, and an unclosed one hides the rest. A scan, not a regex
 * replace, so no `<!--` can survive the removal.
 *
 * @param {string} text
 */
function withoutComments(text) {
  let out = '';
  let from = 0;
  for (;;) {
    const start = text.indexOf('<!--', from);
    if (start === -1) return out + text.slice(from);
    out += text.slice(from, start);
    const end = text.indexOf('-->', start + 4);
    if (end === -1) return out;
    from = end + 3;
  }
}

/**
 * What renders: the template's example table sits in an HTML comment, and a
 * tag quoted in code isn't a picture, so neither may count. Code goes first,
 * as in GitHub's renderer, so a `<!--` quoted in it can't hide the rest of
 * the description; an unclosed fence runs to the end.
 *
 * @param {string | undefined} body
 */
export function visibleText(body) {
  return withoutComments(
    (body ?? '')
      .replace(/```[\s\S]*?(```|$)/g, '')
      .replace(/~~~[\s\S]*?(~~~|$)/g, '')
      .replace(/`[^`]*`/g, ''),
  );
}

/**
 * @typedef {{ ok: true, reason: string } | { ok: false, ui: string[] }} Verdict
 */

/**
 * @param {{ files: string[], body: string | undefined, author?: string, settings: Settings }} pr
 * @returns {Verdict}
 */
export function checkPrVisuals({ files, body, author, settings: s }) {
  if (author === 'dependabot[bot]') return { ok: true, reason: "Dependabot's PR" };
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
  const { code, message } = report(await readAll(), {
    body: process.env.PR_BODY,
    author: process.env.PR_AUTHOR,
    settings: settings(appConfig('visuals', appRoot())),
  });
  console.log(message);
  process.exitCode = code;
}
