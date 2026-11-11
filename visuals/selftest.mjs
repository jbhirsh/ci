// Self-test of the PR visuals check against an app's checkout:
// `node visuals/selftest.mjs <app dir>`. Checks that
//   - the app's `visuals` settings parse (or the defaults, without them);
//   - every `ui` glob the app sets still names a file git tracks, so a renamed folder
//     can't quietly switch the check off;
//   - the app's PR template (.github/pull_request_template.md), untouched,
//     fails a UI change, since its example pictures sit in a comment, and
//     passes it once "No visible UI change" is ticked;
//   - with `visuals.fromBaselines` on: the app's `visual-baselines.columns`
//     pair its baselines, and the untouched template still fails a UI
//     change, which then passes with a changed baseline in a column, a
//     `GIF:` image or a bare video link, and still fails with an unlabelled
//     still or a changed baseline no column takes.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig } from '../lib/app.mjs';
import { changedBaselines, columnOf, pairBaselines } from '../lib/baselines.mjs';
import { matchesAny, pick } from '../lib/match.mjs';
import { baselinesShown, checkPrVisuals, loadBaselineSettings, settings } from './check.mjs';

export const TEMPLATE = '.github/pull_request_template.md';

/**
 * @param {string} root
 * @returns {string[]} what to print; throws on the first problem
 */
export function selftest(root) {
  const config = appConfig('visuals', root);
  const s = settings(config);
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  // Only globs the app chose: the defaults are a guess at a web app's layout.
  const chosen = config.ui === undefined ? [] : s.ui;
  const stale = chosen.filter((glob) => !tracked.some((file) => matchesAny(file, [glob])));
  if (stale.length > 0) throw new Error(`visuals.ui names no tracked file: ${stale.join(', ')}`);
  const ui = pick(tracked, { include: s.ui, exclude: s.notUi });
  if (ui.length === 0) throw new Error('visuals.notUi leaves no UI file');
  const lines = [`visuals: ${ui.length} of ${tracked.length} tracked files count as UI.`];

  const templatePath = path.join(root, TEMPLATE);
  if (!existsSync(templatePath)) return [...lines, `visuals: no ${TEMPLATE}; skipped.`];
  const template = readFileSync(templatePath, 'utf8');
  const files = [ui[0]];
  if (checkPrVisuals({ files, body: template, settings: s }).ok) {
    throw new Error(`the untouched ${TEMPLATE} passes a UI change`);
  }
  const ticked = template.replace(/\[ \](\s*No visible UI change)/, '[x]$1');
  if (ticked === template) throw new Error(`${TEMPLATE} has no "No visible UI change" box`);
  if (!checkPrVisuals({ files, body: ticked, settings: s }).ok) {
    throw new Error(`${TEMPLATE} still fails once "No visible UI change" is ticked`);
  }
  lines.push(`visuals: ${TEMPLATE} fails untouched and passes ticked.`);
  if (s.fromBaselines) lines.push(fromBaselines(root, tracked, template, files, s));
  return lines;
}

/**
 * The fromBaselines cases, against the app's own baselines and template.
 *
 * @param {string} root
 * @param {string[]} tracked
 * @param {string} template
 * @param {string[]} files a UI file
 * @param {import('./check.mjs').Settings} s
 */
function fromBaselines(root, tracked, template, files, s) {
  const baselines = loadBaselineSettings(root);
  const { columns } = baselines;
  const all = changedBaselines(
    tracked.map((filename) => ({ filename, status: 'modified' })),
    baselines,
  );
  const inColumn = pairBaselines(all, columns).rows[0];
  if (!inColumn) throw new Error('visual-baselines.columns pairs no tracked baseline');
  const shot = /** @type {string} */ (Object.values(inColumn.cells)[0].after);
  /**
   * @param {string} body
   * @param {import('../lib/baselines.mjs').FileEntry[]} changed
   */
  const ok = (body, changed = []) =>
    checkPrVisuals({ files, body, baselines: baselinesShown(changed, baselines), settings: s }).ok;
  /** @type {[string, boolean, string, import('../lib/baselines.mjs').FileEntry[]?][]} */
  const cases = [
    ['the untouched template', false, template],
    [`a change to ${shot}`, true, template, [{ filename: shot, status: 'modified' }]],
    ['a GIF: image', true, `${template}\n![GIF: the flow](https://example.com/a.gif)\n`],
    ['a bare video link', true, `${template}\nhttps://github.com/user-attachments/assets/1\n`],
    ['an unlabelled still', false, `${template}\n![after](https://example.com/a.png)\n`],
  ];
  const stray = `${all[0].folder}/pr-visuals-selftest-no-column.png`;
  if (!columnOf(path.posix.basename(stray), columns)) {
    cases.push([
      'a baseline in no column',
      false,
      template,
      [{ filename: stray, status: 'modified' }],
    ]);
  }
  for (const [what, want, body, changed] of cases) {
    if (ok(body, changed) !== want) {
      throw new Error(`with fromBaselines, ${what} ${want ? 'fails' : 'passes'} a UI change`);
    }
  }
  return `visuals: with fromBaselines, ${cases.length} cases hold (${shot} in a column passes).`;
}

/**
 * Runs the self-test on the app at `argv[0]` and returns the exit code.
 *
 * @param {string[]} argv
 * @param {(line: string) => void} [log]
 * @returns {number}
 */
export function cli(argv, log = console.log) {
  try {
    for (const line of selftest(path.resolve(argv[0] ?? '.'))) log(line);
    return 0;
  } catch (error) {
    log(`visuals self-test failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cli(process.argv.slice(2));
}
