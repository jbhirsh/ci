// The GitHub CLI a tool needs to upload a PR's attachments: `gh pr edit
// --attach` came in gh 2.99.0 (1 September 2026), and an older gh doesn't
// know the flag. A floor, not a pin: any newer gh is fine, so the pins rule
// doesn't apply, and nothing is downloaded here. Its caller is gif's attach
// job (gif/attach/action.yml), on the runner, whose image's gh may lag: the
// action upgrades it from the runner's own apt source when this says it's
// too old (`node gif/workflow.mjs gh`).

import { spawnSync } from 'node:child_process';

/** The first gh with `--attach` on `gh pr create`, `gh pr edit` and `gh pr comment`. */
export const MIN_GH = '2.99.0';

/**
 * A version's numbers from `gh --version`'s first line, or null.
 *
 * @param {string} text
 * @returns {[number, number, number] | null}
 */
export function ghVersion(text) {
  const m = /gh version (\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Whether `have` is at least `want`.
 *
 * @param {readonly number[]} have
 * @param {readonly number[]} want
 */
function atLeast(have, want) {
  for (let i = 0; i < want.length; i++) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return true;
}

/**
 * Throws, saying what to install, unless gh is MIN_GH or newer.
 *
 * @param {() => string} [version] what `gh --version` prints
 */
export function checkGh(version = ghVersionText) {
  let text = '';
  try {
    text = version();
  } catch {
    // No gh at all: the message below covers it.
  }
  const have = ghVersion(text);
  const want = /** @type {[number, number, number]} */ (ghVersion(`gh version ${MIN_GH}`));
  if (!have || !atLeast(have, want)) {
    const shows = have ? `yours is ${have.join('.')}` : 'none found';
    throw new Error(
      `install gh ≥ 2.99, which can attach files to a PR (\`gh --version\` shows yours; ${shows})`,
    );
  }
}

/** What the installed gh's `--version` prints. */
function ghVersionText() {
  const result = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result.stdout ?? '';
}
