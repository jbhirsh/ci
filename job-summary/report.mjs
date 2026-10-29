// The report page for one job's run: report.html with the run's model
// (model.mjs) written into its script as a value, so the page is one file
// that loads nothing else. job-reports.yml (publish.mjs) puts it on the
// repository's GitHub Pages, where the run's summary links to it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {import('./model.mjs').Model} Model */

/** How many days of reports the Pages site keeps (publish.mjs prunes older). */
export const KEEP_DAYS = 30;

// The marker in the page's script the model replaces: a value in the script
// itself, not a JSON element the page reads back from the DOM.
const SLOT = /\/\* __REPORT_DATA__ \*\/ null/;

/**
 * The page's template.
 *
 * @returns {string}
 */
export function template() {
  return readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'report.html'),
    'utf8',
  );
}

/**
 * JSON that can sit inside a script element: every "<" written as its
 * Unicode escape, so no test name or message holding "</script>" can end
 * it, and the two characters JavaScript reads as line ends escaped too.
 *
 * @param {unknown} value
 */
export function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The page, with the model in it.
 *
 * @param {Model} model
 * @param {string} [page] the template
 */
export function report(model, page = template()) {
  if (!SLOT.test(page)) throw new Error('report.html has no data slot');
  return page.replace(SLOT, () => scriptJson(model));
}

/**
 * Where an earlier run's report is: under the Pages site, by run and job.
 *
 * @param {string} base the site's address, e.g. https://jbhirsh.github.io/sift
 * @param {number | string} runId
 * @param {string} artifact the job's artifact name (history.mjs artifactName)
 */
export function reportUrl(base, runId, artifact) {
  return `${base.replace(/\/+$/, '')}/runs/${runId}/${artifact.replace(/^job-summary-/, '')}/`;
}

/**
 * The Pages site's address for a repository: GitHub's default for it.
 *
 * @param {string} repo owner/name
 */
export function pagesBase(repo) {
  const [owner, name] = repo.split('/');
  if (!owner || !name) return '';
  return name.toLowerCase() === `${owner.toLowerCase()}.github.io`
    ? `https://${name.toLowerCase()}`
    : `https://${owner.toLowerCase()}.github.io/${name}`;
}
