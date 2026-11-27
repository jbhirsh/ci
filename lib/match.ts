// Which of a list of repository paths a setting picks out: those matching
// any `include` glob and no `exclude` glob. Globs are Node's own
// (path.matchesGlob, stable in Node 24): `*` within a segment, `**` across
// any number of them (none included), `{a,b}` alternatives. As in a shell, a
// wildcard doesn't match a segment starting with a dot (`**` skips
// `.github/`); name such a path outright.
//
// Shared by every tool reading app globs.

import path from 'node:path';

/**
 * A list of globs from an app's settings, checked.
 *
 * @param value
 * @param name the setting, for the error
 * @param fallback when the setting is absent
 */
export function globList(value: unknown, name: string, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((g) => typeof g === 'string' && g !== '')) {
    throw new Error(`.github/ci.json: ${name} must be a list of globs`);
  }
  return value;
}

/**
 * Whether `file` matches the glob.
 *
 * @param file a repository path, with forward slashes
 * @param glob
 */
export function matches(file: string, glob: string) {
  return path.posix.matchesGlob(file, glob);
}

/**
 * Whether `file` matches any of the globs.
 *
 * @param file a repository path, with forward slashes
 * @param globs
 */
export function matchesAny(file: string, globs: string[]) {
  return globs.some((glob) => matches(file, glob));
}

/**
 * The files that match `include` and not `exclude`, in order.
 */
export function pick(
  files: string[],
  { include, exclude }: { include: string[]; exclude: string[] },
): string[] {
  return files.filter((file) => matchesAny(file, include) && !matchesAny(file, exclude));
}
