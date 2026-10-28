// Visual regression's settings, `visual-baselines` in the app's
// .github/ci.json. Each app compares its screenshots with baselines
// committed in its tree; these say where they are and how fresh ones come:
//
//   folders   globs of the folders holding the baselines, which a rewrite
//             replaces and commits (BoardGames: e2e/*-snapshots)
//   command   the shell command that writes them afresh on this runner,
//             for rewrite/ (Playwright's --update-snapshots, its browsers
//             installed first)
//   artifact  { workflow, name }: the workflow (its file name, ci.yml)
//             whose run's artifact holds this
//             commit's screenshots, for from-run/ (sift's, taken on the iOS
//             Simulator, which no Linux runner has); its PNGs replace the
//             one folder `folders` then names
//   ratio     the share of a screenshot's pixels that may differ before
//             compare/ calls it changed (default 0: any pixel pixelmatch
//             counts); for an app whose screens hold something that moves
//
// An app sets `command` or `artifact`, whichever its rewrite action reads.

/**
 * @typedef {object} Settings
 * @property {string[]} folders
 * @property {string | undefined} command
 * @property {{ workflow: string, name: string } | undefined} artifact
 * @property {number} ratio
 */

/**
 * Whether a glob stays inside the checkout.
 *
 * @param {string} glob
 */
function inCheckout(glob) {
  return !glob.startsWith('/') && !glob.split('/').includes('..');
}

/**
 * A text setting, checked: undefined when absent.
 *
 * @param {unknown} value
 * @param {string} name
 */
function text(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`.github/ci.json: visual-baselines.${name} must be text`);
  }
  return value;
}

/**
 * The settings, checked, with the defaults filled in.
 *
 * @param {Record<string, unknown>} config
 * @returns {Settings}
 */
export function settings(config) {
  const { folders, ratio = 0 } = config;
  if (
    !Array.isArray(folders) ||
    folders.length === 0 ||
    !folders.every((f) => typeof f === 'string' && f !== '' && inCheckout(f))
  ) {
    throw new Error(
      '.github/ci.json: visual-baselines.folders must list the baselines folders, in the checkout',
    );
  }
  if (typeof ratio !== 'number' || !(ratio >= 0 && ratio < 1)) {
    throw new Error('.github/ci.json: visual-baselines.ratio must be a share from 0 up to 1');
  }
  /** @type {Settings['artifact']} */
  let artifact;
  if (config.artifact !== undefined) {
    const a = /** @type {Record<string, unknown>} */ (config.artifact);
    artifact = {
      workflow: text(a?.workflow, 'artifact.workflow') ?? '',
      name: text(a?.name, 'artifact.name') ?? '',
    };
    if (!artifact.workflow || !artifact.name) {
      throw new Error('.github/ci.json: visual-baselines.artifact needs a workflow and a name');
    }
    if (!/^[\w.-]+\.ya?ml$/.test(artifact.workflow)) {
      throw new Error(
        ".github/ci.json: visual-baselines.artifact.workflow is the workflow's file name (ci.yml)",
      );
    }
  }
  return {
    folders: folders.map((f) => f.replace(/\/+$/, '')),
    command: text(config.command, 'command'),
    artifact,
    ratio,
  };
}

/**
 * The one folder compare/ and from-run/ use: `folders` must then name
 * exactly one, with no wildcard.
 *
 * @param {Settings} s
 */
export function singleFolder(s) {
  const [folder, ...rest] = s.folders;
  if (rest.length > 0 || /[*?[{]/.test(folder)) {
    throw new Error(
      '.github/ci.json: visual-baselines.folders must name exactly one folder, with no wildcard, for a comparison or a rewrite from a run',
    );
  }
  return folder;
}

// A screenshot's name, as the README bot checks it: a PNG directly in the
// folder, no path, since names arrive from another job's artifact.
export { isShotName } from '../readme-screenshots/settings.mjs';
