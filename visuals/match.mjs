// Which of a list of repository paths a setting picks out: those matching
// any `include` glob and no `exclude` glob. Globs are Node's own
// (path.matchesGlob, stable in Node 24): `*` within a segment, `**` across
// any number of them (none included), `{a,b}` alternatives. As in a shell, a
// wildcard doesn't match a segment starting with a dot (`**` skips
// `.github/`); name such a path outright.
//
// Shared by visuals/check.mjs (what counts as a UI change) and
// readme-screenshots/decide.mjs (what the README's screenshots show).

import path from 'node:path';

/**
 * A list of globs from an app's settings, checked.
 *
 * @param {unknown} value
 * @param {string} name the setting, for the error
 * @param {string[]} fallback when the setting is absent
 * @returns {string[]}
 */
export function globList(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((g) => typeof g === 'string' && g !== '')) {
    throw new Error(`.github/ci.json: ${name} must be a list of globs`);
  }
  return value;
}

/**
 * Whether `file` matches any of the globs.
 *
 * @param {string} file a repository path, with forward slashes
 * @param {string[]} globs
 */
export function matchesAny(file, globs) {
  return globs.some((glob) => path.posix.matchesGlob(file, glob));
}

/**
 * The files that match `include` and not `exclude`, in order.
 *
 * @param {string[]} files
 * @param {{ include: string[], exclude: string[] }} globs
 * @returns {string[]}
 */
export function pick(files, { include, exclude }) {
  return files.filter((file) => matchesAny(file, include) && !matchesAny(file, exclude));
}
