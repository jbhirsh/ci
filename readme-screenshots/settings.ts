// The README screenshot bot's settings, `readme-screenshots` in the app's
// .github/ci.json. Taking the screenshots stays in each app (a Playwright
// build, or the E2E job's artifact); these say what the shared parts need:
//
//   dir      where the README's screenshots live (default docs/screenshots)
//   shows    globs of what the screenshots show, for decide.ts: a change to
//            one of these files since the last finished run retakes them
//            (default DEFAULT_SHOWS); list the capture's own scripts and
//            config too, since a change to how they're taken changes them
//   ignore   globs among those that show nothing (default DEFAULT_IGNORE)
//   source   how they were taken, for the bot PR's description and commit
//            ("a local production build reading production's catalog")

import { globList } from '../lib/match.ts';

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

export type Settings = {
  dir: string;
  shows: string[];
  ignore: string[];
  source: string;
};

/**
 * The settings, checked, with the defaults filled in.
 */
export function settings(config: Record<string, unknown>): Settings {
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
 */
export function isShotName(name: string) {
  return /^[\w][\w.-]*\.png$/.test(name);
}
