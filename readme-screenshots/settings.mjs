// The README screenshot bot's settings, `readme-screenshots` in the app's
// .github/ci.json. Taking the screenshots stays in each app (a Playwright
// build, or the E2E job's artifact); these say what the shared parts need:
//
//   dir      where the README's screenshots live (default docs/screenshots)
//   shows    globs of what the screenshots show, for decide.mjs: a change to
//            one of these files since the last finished run retakes them
//            (default DEFAULT_SHOWS); list the capture's own scripts and
//            config too, since a change to how they're taken changes them
//   ignore   globs among those that show nothing (default DEFAULT_IGNORE)
//   source   how they were taken, for the bot PR's description and commit
//            ("a local production build reading production's catalog")

import { globList } from '../visuals/match.mjs';

export const BRANCH = 'bot/readme-screenshots';
export const DEFAULT_DIR = 'docs/screenshots';
export const DEFAULT_SHOWS = ['src/**', 'index.html', 'public/**'];
export const DEFAULT_IGNORE = ['**/*.test.*', '**/__tests__/**', 'src/test/**'];
export const DEFAULT_SOURCE = 'a fresh capture of the app';

/**
 * Share of pixels that must differ (pixelmatch's colour threshold aside)
 * before a screenshot is replaced: font hinting, map tiles and a playing
 * song's progress move a few pixels from run to run; a real UI change moves
 * far more.
 */
export const CHANGED_RATIO = 0.005;

/**
 * @typedef {object} Settings
 * @property {string} dir
 * @property {string[]} shows
 * @property {string[]} ignore
 * @property {string} source
 */

/**
 * The settings, checked, with the defaults filled in.
 *
 * @param {Record<string, unknown>} config
 * @returns {Settings}
 */
export function settings(config) {
  const { dir = DEFAULT_DIR, source = DEFAULT_SOURCE } = config;
  if (
    typeof dir !== 'string' ||
    dir === '' ||
    dir.startsWith('/') ||
    dir.split('/').includes('..')
  ) {
    throw new Error('.github/ci.json: readme-screenshots.dir must be a folder in the checkout');
  }
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error('.github/ci.json: readme-screenshots.source must be text');
  }
  return {
    dir: dir.replace(/\/+$/, ''),
    shows: globList(config.shows, 'readme-screenshots.shows', DEFAULT_SHOWS),
    ignore: globList(config.ignore, 'readme-screenshots.ignore', DEFAULT_IGNORE),
    source,
  };
}

/**
 * Whether a file name is one this bot may write: a PNG directly in the
 * screenshots folder, no path. Names cross from the capture job to the job
 * holding the token, so they're checked on both sides.
 *
 * @param {string} name
 */
export function isShotName(name) {
  return /^[\w][\w.-]*\.png$/.test(name);
}
