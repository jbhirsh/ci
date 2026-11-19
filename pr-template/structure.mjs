// What a PR template of the shared shape holds (ci#79), checked by the unit
// test on this repo's master (`.github/pull_request_template.md`) and by the
// self-test on an app's copy:
//   - the headings Goal (Problem, for a bug fix), Plan (Solution, for a bug
//     fix), Changes, Checklist and Revisions, in that order;
//   - no `No visible UI change` box: visual review decides whether a screen
//     changed, so the template has nothing to tick;
//   - the empty marker pair visual review's summary goes in
//     (`describe:visual-review`), and the pairs the changes tool writes
//     (`pr-changes:change:1`, `pr-changes:revisions`);
//   - no picture outside a comment: a stray example would pass for evidence.
// A PR's own description is held to the same headings by body.mjs, with its
// tools' blocks filled in and the placeholders gone.

import { visibleText } from '../visuals/check.mjs';

/**
 * The headings, in order, each with the names it may have: a bug fix says
 * what was wrong (Problem) and what the fix does (Solution) where a feature
 * says its goal and, for a step of a plan, the plan.
 */
export const HEADINGS = [
  ['Goal', 'Problem'],
  ['Plan', 'Solution'],
  ['Changes'],
  ['Checklist'],
  ['Revisions'],
];

/** The marker pairs an empty template holds. */
export const PAIRS = ['describe:visual-review', 'pr-changes:change:1', 'pr-changes:revisions'];

/**
 * What is wrong with a template, in plain words; empty when nothing is.
 *
 * @param {string} template
 * @returns {string[]}
 */
export function problems(template) {
  /** @type {string[]} */
  const found = [];
  const seen = [...template.matchAll(/^## (.+?)\s*$/gm)].map((m) => m[1]);
  if (seen.length !== HEADINGS.length || !HEADINGS.every((names, i) => names.includes(seen[i]))) {
    const want = HEADINGS.map((names) => names.join(' or ')).join(', ');
    found.push(`its "##" headings must be ${want} in that order, not ${seen.join(', ') || 'none'}`);
  }
  if (/No visible UI change/i.test(template)) {
    found.push('it has a "No visible UI change" box: visual review decides, so drop it');
  }
  for (const key of PAIRS) {
    const pair = new RegExp(`<!-- ${key} -->\\s*<!-- /${key} -->`);
    if (!pair.test(template)) found.push(`it lacks the empty marker pair for ${key}`);
    // The tools write into the last pair: a second copy would take the table.
    if (template.split(`<!-- ${key} -->`).length > 2) {
      found.push(`it has more than one marker pair for ${key}`);
    }
  }
  if (/!\[[^\]]*\]\(|<img\b|<video\b/i.test(visibleText(template))) {
    found.push('it has a picture outside a comment');
  }
  return found;
}
