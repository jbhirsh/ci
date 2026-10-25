// Claude Review's settings: the `review` key of the app's `.github/ci.json`,
// read from the PR's base branch (config.mjs says why).
//
//   "review": {
//     "instructions": ".github/claude-review.md",
//     "skip": ["src/gql/**"]
//   }
//
// - instructions: a Markdown file in the app holding what only that app's
//   review needs: what the app is, its focus areas, its server-side gates,
//   where its data lives, its architecture rules. It goes into the prompt
//   as-is (prompt.md, `{{appGuide}}`), so write it as Markdown sections
//   (`## ...`) addressed to the reviewer. Like the shared prompt, it must
//   not ask for anything an automated check of the app already decides.
//   Default: none; the shared prompt and the app's CLAUDE.md stand alone.
// - skip: globs (repo-relative; `*` within a folder, `**` across folders)
//   of generated files the review may skim rather than read whole, as it
//   may lockfiles, images and fonts; the coverage check (coverage.mjs)
//   doesn't count them. Default: none.

import { loadConfig, onlyKnownKeys, readAppFile, stringList } from './config.mjs';

/**
 * @typedef {object} ReviewSettings
 * @property {string | null} instructions the guide's path, if the app names one
 * @property {string} guide the guide's text ('' without one)
 * @property {string[]} skip
 */

/**
 * @param {{ root: string, ref?: string }} where
 * @returns {ReviewSettings}
 */
export function reviewSettings(where) {
  const section = loadConfig('review', where);
  onlyKnownKeys('review', section, ['instructions', 'skip']);
  const skip = stringList('review.skip', section.skip, []);
  const { instructions } = section;
  if (instructions === undefined) return { instructions: null, guide: '', skip };
  if (typeof instructions !== 'string' || instructions.trim() === '') {
    throw new Error('.github/ci.json: "review.instructions" must be a file path');
  }
  const guide = readAppFile(instructions, where);
  if (guide === null) {
    throw new Error(
      `.github/ci.json: "review.instructions" names ${instructions}, which ${where.ref ?? 'the checkout'} doesn't hold`,
    );
  }
  return { instructions, guide: guide.trim(), skip };
}
