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
//   columns   how the baselines a PR changes pair up, for visuals' before/after
//             table and Claude Review's look at them (lib/baselines.mjs
//             says how): a list of { label, file, width? }, each column's
//             `file` a basename holding {state} once, or an ordered list of
//             them, the first that matches winning; `width` the pixels its
//             pictures show at in the table. BoardGames: Phone
//             `{state}-visual-phone-webkit-linux.png` and Desktop
//             `{state}-visual-webkit-linux.png`. None by default: nothing
//             pairs, and the tools that read it do as they did without it.
//
// An app sets `command` or `artifact`, whichever its rewrite action reads.

/**
 * @typedef {object} Settings
 * @property {string[]} folders
 * @property {string | undefined} command
 * @property {{ workflow: string, name: string } | undefined} artifact
 * @property {number} ratio
 * @property {import('../lib/baselines.mjs').Column[] | undefined} columns
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
 * The `columns` setting, checked: undefined when absent.
 *
 * @param {unknown} value
 * @returns {import('../lib/baselines.mjs').Column[] | undefined}
 */
function columns(value) {
  if (value === undefined) return undefined;
  const fail = (/** @type {string} */ why) => {
    throw new Error(`.github/ci.json: visual-baselines.columns ${why}`);
  };
  if (!Array.isArray(value) || value.length === 0) fail('must list { label, file } columns');
  /** @type {import('../lib/baselines.mjs').Column[]} */
  const out = [];
  for (const raw of /** @type {unknown[]} */ (value)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fail('must list { label, file } columns');
    }
    const c = /** @type {Record<string, unknown>} */ (raw);
    const unknown = Object.keys(c).filter((k) => !['label', 'file', 'width'].includes(k));
    if (unknown.length > 0) fail(`has an unknown key: ${unknown.join(', ')}`);
    // A label heads a Markdown table's column.
    if (
      typeof c.label !== 'string' ||
      !/^[^|\n\r<>`]+$/.test(c.label) ||
      c.label.trim() !== c.label
    ) {
      fail('labels must be text, with no | < > ` or line break');
    }
    const label = /** @type {string} */ (c.label);
    if (out.some((o) => o.label === label)) fail(`repeats the label ${label}`);
    const files = typeof c.file === 'string' ? [c.file] : c.file;
    if (
      !Array.isArray(files) ||
      files.length === 0 ||
      !files.every(
        (f) =>
          typeof f === 'string' &&
          f.split('{state}').length === 2 &&
          !f.includes('/') &&
          f.toLowerCase().endsWith('.png'),
      )
    ) {
      fail(`${label}'s file must be a .png basename holding {state} once, or a list of them`);
    }
    if (c.width !== undefined && !(Number.isInteger(c.width) && Number(c.width) > 0)) {
      fail(`${label}'s width must be a whole number of pixels`);
    }
    out.push({
      label,
      file: /** @type {string[]} */ (files),
      ...(c.width === undefined ? {} : { width: /** @type {number} */ (c.width) }),
    });
  }
  return out;
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
    columns: columns(config.columns),
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
