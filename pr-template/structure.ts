// What a PR template of the shared shape holds (ci#79), checked by the unit
// test on this repo's master (`.github/pull_request_template.md`) and by the
// self-test on an app's copy:
//   - the headings Goal (Problem, for a bug fix), Plan (Solution, for a bug
//     fix), Changes, Checklist and, optionally, Revisions, in that order;
//   - no `No visible UI change` box: visual review decides whether a screen
//     changed, so the template has nothing to tick;
//   - the empty marker pair visual review's summary goes in
//     (`describe:visual-review`), and the pairs the changes tool writes
//     (`pr-changes:change:1`, `pr-changes:revisions`);
//   - no picture outside a comment: a stray example would pass for evidence.
// A PR's own description is held to the same headings by body.ts, with its
// tools' blocks filled in and the placeholders gone.

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
 */
export function problems(template: string): string[] {
  const found: string[] = [];
  const seen = [...template.matchAll(/^## (.+?)\s*$/gm)].map((m) => m[1]);
  // Revisions is optional: a PR has the section once it has a revision (ci#111: the changes tool writes it).
  const wanted = seen.includes('Revisions') ? HEADINGS : HEADINGS.slice(0, -1);
  if (seen.length !== wanted.length || !wanted.every((names, i) => names.includes(seen[i]))) {
    const want = HEADINGS.map((names) => names.join(' or ')).join(', ');
    found.push(
      `its "##" headings must be ${want} (Revisions optional) in that order, not ${seen.join(', ') || 'none'}`,
    );
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

/**
 * Drops HTML comments the way GitHub's renderer hides them: from each `<!--`
 * to the next `-->`, and an unclosed one hides the rest. A scan, not a regex
 * replace, so no `<!--` can survive the removal.
 */
function withoutComments(text: string) {
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
 */
export function visibleText(body: string | undefined) {
  return withoutComments(
    (body ?? '')
      .replace(/```[\s\S]*?(```|$)/g, '')
      .replace(/~~~[\s\S]*?(~~~|$)/g, '')
      .replace(/`[^`]*`/g, ''),
  );
}
