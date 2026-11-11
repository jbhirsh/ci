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
//   fromBaselines  true: the PR's changed visual baselines are its pictures
//           (default false, the rules above). comment.mjs then keeps a
//           before/after table of them on the PR, from the
//           `visual-baselines.columns` setting (lib/baselines.mjs pairs
//           them), and this check passes a UI change when a changed
//           baseline that isn't a deletion lands in a column; one in no
//           column (another engine, a rewrite of something else) doesn't
//           count. Otherwise a picture counts only when it says why no
//           baseline can show it: an image whose alt text starts `GIF:`
//           (motion) or `No test draws:` and the reason (Google's sign-in
//           page, live map tiles), an image whose URL ends in `.gif` (as the
//           gif tool's branch path links them), or a video (a bare
//           user-attachments link on a line of its own, as a dropped-in
//           video appears, or a <video> tag), which is motion. An attachment's URL can't say
//           whether it holds a GIF or a still, so the label does, and
//           whether the reason holds is Claude Review's call. A closed PR
//           passes, with no table: rewriting old descriptions (moving their
//           pictures off the screenshots branch) edits closed PRs, and each
//           edit runs this check.
// UI that changes through a file the globs don't name isn't caught, nor is a
// reference-style markdown image (![alt][ref]). Reviewers cover those.

import { pathToFileURL } from 'node:url';
import { readAll } from '../lib/actions.mjs';
import { readFileSync } from 'node:fs';
import { appConfig, appRoot } from '../lib/app.mjs';
import { changedBaselines, pairBaselines } from '../lib/baselines.mjs';
import { globList, pick } from '../lib/match.mjs';
import { settings as baselineSettings } from '../visual-baselines/settings.mjs';

export const DEFAULT_UI = ['src/**/*.{tsx,css}'];
export const DEFAULT_NOT_UI = ['**/*.test.*', '**/__tests__/**', 'src/test/**'];
/** What a failure adds when the baselines are the pictures. */
export const SCENARIO_ADVICE =
  'Add a visual scenario for the state; its baselines will be the pictures.';
export const DEFAULT_ADVICE =
  'Add before/after screenshots to the description (a GIF when the change affects motion or ' +
  'interaction), or tick "No visible UI change" in the template. Editing the description ' +
  're-runs this check.';

/**
 * @typedef {object} Settings
 * @property {string[]} ui
 * @property {string[]} notUi
 * @property {string} advice
 * @property {true} [fromBaselines] set only when on, so the settings without it are
 *   what they were before it came in
 */

/**
 * The app's `visuals` settings, checked, with the defaults filled in.
 *
 * @param {Record<string, unknown>} config
 * @returns {Settings}
 */
export function settings(config) {
  const { advice = DEFAULT_ADVICE, fromBaselines = false } = config;
  if (typeof advice !== 'string' || advice.trim() === '') {
    throw new Error('.github/ci.json: visuals.advice must be text');
  }
  if (typeof fromBaselines !== 'boolean') {
    throw new Error('.github/ci.json: visuals.fromBaselines must be true or false');
  }
  return {
    ui: globList(config.ui, 'visuals.ui', DEFAULT_UI),
    notUi: globList(config.notUi, 'visuals.notUi', DEFAULT_NOT_UI),
    advice,
    ...(fromBaselines ? { fromBaselines } : {}),
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
// With fromBaselines: what counts as a picture no baseline can show. An
// image labelled with its reason (Markdown's alt text, or an <img>'s alt),
// and a video, which is motion.
const REASON = /^\s*(?:GIF:|No test draws:\s*\S)/i;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*[^)\s][^)]*\)/g;
const HTML_IMAGE = /<img\s[^>]*>/gi;
const HTML_ALT = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
// An image whose URL names a GIF is motion whatever its alt text says.
const GIF_URL = [
  /!\[[^\]]*\]\(\s*[^)\s]+\.gif(?:[?#][^)\s]*)?\s*(?:\s"[^"]*")?\)/i,
  /<img\s[^>]*\bsrc\s*=\s*(?:"[^"]*\.gif(?:[?#][^"]*)?"|'[^']*\.gif(?:[?#][^']*)?')/i,
];
const VIDEO = [
  /<video[\s>]/i,
  /^[ \t]*https:\/\/github\.com\/user-attachments\/assets\/\S+[ \t]*$/m,
];

/**
 * Whether the text holds a picture that says why no baseline shows it.
 *
 * @param {string} text visibleText's
 */
function explainedPicture(text) {
  if (VIDEO.some((re) => re.test(text)) || GIF_URL.some((re) => re.test(text))) return true;
  for (const [, alt] of text.matchAll(MARKDOWN_IMAGE)) if (REASON.test(alt)) return true;
  for (const [tag] of text.matchAll(HTML_IMAGE)) {
    const alt = HTML_ALT.exec(tag);
    if (/\bsrc\s*=/i.test(tag) && alt && REASON.test(alt[1] ?? alt[2])) return true;
  }
  return false;
}

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
 * The PR's changed baselines, as far as the check reads them (with
 * fromBaselines): how many land in a column and aren't deletions.
 *
 * @typedef {{ shown: number }} Baselines
 */

/**
 * The baselines settings fromBaselines reads: with the columns that pair
 * them, which loadBaselineSettings has checked are there.
 *
 * @typedef {import('../visual-baselines/settings.mjs').Settings & { columns: import('../lib/baselines.mjs').Column[] }} PairedSettings
 */

/**
 * How many of a PR's changed baselines a column shows: deletions aside. A
 * rename counts: the files API gives every binary file `changes: 0`, so a
 * renamed picture that changed can't be told from one that didn't.
 *
 * @param {readonly import('../lib/baselines.mjs').FileEntry[]} files
 * @param {PairedSettings} s
 * @returns {Baselines}
 */
export function baselinesShown(files, s) {
  const { rows } = pairBaselines(changedBaselines(files, s), s.columns);
  const shown = rows.flatMap((r) => Object.values(r.cells)).filter((c) => c.after);
  return { shown: shown.length };
}

/**
 * @param {{ files: string[], body: string | undefined, author?: string, state?: string, baselines?: Baselines, settings: Settings }} pr
 *   state: the PR's (open or closed); baselines: with fromBaselines, its changed ones
 * @returns {Verdict}
 */
export function checkPrVisuals({ files, body, author, state, baselines, settings: s }) {
  if (author === 'dependabot[bot]') return { ok: true, reason: "Dependabot's PR" };
  if (s.fromBaselines && state === 'closed') return { ok: true, reason: 'closed PR' };
  const ui = pick(files, { include: s.ui, exclude: s.notUi });
  if (ui.length === 0) return { ok: true, reason: 'no UI files changed' };
  const text = visibleText(body);
  if (OPT_OUT.test(text)) return { ok: true, reason: 'marked "No visible UI change"' };
  if (s.fromBaselines) {
    if ((baselines?.shown ?? 0) > 0) return { ok: true, reason: 'changed baselines show it' };
    if (explainedPicture(text)) {
      return { ok: true, reason: 'description shows what no baseline can' };
    }
    return { ok: false, ui };
  }
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
 * @param {{ body: string | undefined, author?: string, state?: string, baselines?: Baselines, settings: Settings }} pr
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
      ...(pr.settings.fromBaselines ? [SCENARIO_ADVICE] : []),
    ].join('\n'),
  };
}

/**
 * The PR's files API entries, one JSON object a line, as action.yml writes
 * them to PR_FILES.
 *
 * @param {string} text
 * @returns {import('../lib/baselines.mjs').FileEntry[]}
 */
export function readEntries(text) {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * With fromBaselines, the app's baselines settings, which must pair them.
 *
 * @param {string} root
 * @returns {PairedSettings}
 */
export function loadBaselineSettings(root) {
  const s = baselineSettings(appConfig('visual-baselines', root));
  const { columns } = s;
  if (!columns) {
    throw new Error(
      '.github/ci.json: visuals.fromBaselines needs visual-baselines.columns, to pair the baselines',
    );
  }
  return { ...s, columns };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = appRoot();
  const s = settings(appConfig('visuals', root));
  const { code, message } = report(await readAll(), {
    body: process.env.PR_BODY,
    author: process.env.PR_AUTHOR,
    state: process.env.PR_STATE,
    baselines: s.fromBaselines
      ? baselinesShown(
          readEntries(readFileSync(process.env.PR_FILES ?? '', 'utf8')),
          loadBaselineSettings(root),
        )
      : undefined,
    settings: s,
  });
  console.log(message);
  process.exitCode = code;
}
