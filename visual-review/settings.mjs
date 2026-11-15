// Visual review's settings, `visual-review` in the app's .github/ci.json
// (ci#64):
//
//   workflow     the screenshot workflow's file (e2e.yml, visual.yml, ci.yml):
//                its runs on main are the reference, a PR's are compared
//   job          the job in it that takes the shots, to tell "no shots"
//                from "the job failed"
//   folders      globs of the folders the shots land in, relative to the
//                checkout (fog: tests/visual/*-snapshots, in a folder git
//                ignores); visual-shots uploads them, paths kept
//   ratio        the share of a shot's pixels that may differ before it
//                counts as changed (default 0); for screens with motion
//   columns      how the shots pair into the table's rows, as
//                lib/baselines.mjs's parseColumns reads them (BoardGames:
//                Phone and Desktop; sift: Light and Dark). None: a row per
//                shot, named by its path
//   mockupPaths  globs of the paths a mockup patch may change (src/**,
//                public/**): everything else, lockfiles always, is refused
//
// An app without the key doesn't use visual review, and every tool that
// reads it (enable.mjs's gate, the self-test) behaves as before it.

import { matchesAny } from '../lib/match.mjs';
import { parseColumns } from '../lib/baselines.mjs';

/**
 * @typedef {object} Settings
 * @property {string} workflow
 * @property {string} job
 * @property {string[]} folders
 * @property {number} ratio
 * @property {import('../lib/baselines.mjs').Column[]} columns
 * @property {string[]} mockupPaths
 */

/** Files a mockup patch never changes, whatever `mockupPaths` says. */
const LOCKFILES = [
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/*.lock',
];

/**
 * A list of globs inside the checkout, checked.
 *
 * @param {unknown} value
 * @param {string} name
 */
function globs(value, name) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (g) =>
        typeof g === 'string' && g !== '' && !g.startsWith('/') && !g.split('/').includes('..'),
    )
  ) {
    throw new Error(`.github/ci.json: visual-review.${name} must list globs inside the checkout`);
  }
  return /** @type {string[]} */ (value).map((g) => g.replace(/\/+$/, ''));
}

/**
 * The settings, checked; null when the app has no `visual-review` key.
 *
 * @param {Record<string, unknown>} config
 * @returns {Settings | null}
 */
export function settings(config) {
  if (Object.keys(config).length === 0) return null;
  const known = ['workflow', 'job', 'folders', 'ratio', 'columns', 'mockupPaths'];
  const unknown = Object.keys(config).filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    throw new Error(`.github/ci.json: visual-review has an unknown key: ${unknown.join(', ')}`);
  }
  const { workflow, job, ratio = 0 } = config;
  if (typeof workflow !== 'string' || !/^[\w.-]+\.ya?ml$/.test(workflow)) {
    throw new Error(
      ".github/ci.json: visual-review.workflow is the screenshot workflow's file name (e2e.yml)",
    );
  }
  if (typeof job !== 'string' || job.trim() === '' || /[\n\r]/.test(job)) {
    throw new Error(".github/ci.json: visual-review.job is the screenshot job's name");
  }
  if (typeof ratio !== 'number' || !(ratio >= 0 && ratio < 1)) {
    throw new Error('.github/ci.json: visual-review.ratio must be a share from 0 up to 1');
  }
  return {
    workflow,
    job,
    folders: globs(config.folders, 'folders'),
    ratio,
    columns: parseColumns(config.columns, 'visual-review.columns') ?? [],
    mockupPaths: config.mockupPaths === undefined ? [] : globs(config.mockupPaths, 'mockupPaths'),
  };
}

/**
 * Whether a mockup patch may change this path.
 *
 * @param {string} file a repository path
 * @param {Settings} s
 */
export function mockupMayChange(file, s) {
  return matchesAny(file, s.mockupPaths) && !matchesAny(file, LOCKFILES);
}
