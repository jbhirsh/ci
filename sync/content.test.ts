// The workflows the sync writes into each app, linted here, in this repo's
// CI, rather than by the sync as it runs: lint/actions.mjs reads YAML, and the
// sync imports no package, so its jobs install none. The sync runs only from
// a commit whose CI passed (sync.ts's check), so a synced workflow that
// fails here never reaches an app. The Against jobs' `lint/actions.mjs --app`
// still lints each app's copies as they stand.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { lintWorkflow, targetsIn } from '../lint/actions.mjs';
import { writeFiles } from '../review/testApp.ts';
import { APPS, CI_ROOT, loadManifest, resolve } from './manifest.ts';

/**
 * The workflows of each app that a synced PR GIF attach caller may wait for
 * and that the sync doesn't write (sift's recording is its own CI).
 */
const OWN_WORKFLOWS = /** @type {Record<string, string[]>} */ ({ sift: ['CI'] });

/**
 * What lint/actions.mjs finds wrong with the workflows an app would hold.
 *
 * @param {string} ciRoot
 * @param {string} app
 */
function lintSynced(ciRoot, app) {
  const docs = resolve(loadManifest(ciRoot), app)
    .filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path))
    .map((file) => ({ file, doc: parse(readFileSync(path.join(ciRoot, file.source), 'utf8')) }));
  // GitHub names a workflow with no `name:` by its path.
  const names = new Set([
    ...(OWN_WORKFLOWS[app] ?? []),
    ...docs.map(({ file, doc }) => String(doc?.name ?? file.path)),
  ]);
  return docs.flatMap(({ file, doc }) =>
    lintWorkflow(file.source, doc, targetsIn(ciRoot), names).map((p) => `${p} (for ${file.path})`),
  );
}

/** @type {string[]} */
const temps = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the workflows the sync writes', () => {
  it.each(APPS)('fit what they call, for %s', (app) => {
    expect(lintSynced(CI_ROOT, app)).toEqual([]);
  });

  it("would fail a call that names nothing, and an attach caller's missing workflow", () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ci-'));
    temps.push(root);
    writeFiles(root, {
      'sync/manifest.json': JSON.stringify({
        files: [
          { path: '.github/workflows/a.yml', source: 'sync/callers/a.yml', apps: ['BoardGames'] },
          { path: '.github/workflows/b.yml', source: 'sync/callers/b.yml', apps: ['BoardGames'] },
        ],
        unsynced: [],
      }),
      'sync/callers/a.yml':
        'name: A\non: push\njobs:\n  a:\n    uses: jbhirsh/ci/.github/workflows/nothing.yml@main\n',
      'sync/callers/b.yml': readFileSync(
        path.join(CI_ROOT, 'sync/variants/sift/pr-gif-attach.yml'),
        'utf8',
      ),
    });
    expect(lintSynced(root, 'BoardGames')).toEqual([
      'sync/callers/a.yml: job a: jbhirsh/ci/.github/workflows/nothing.yml@main names nothing here (for .github/workflows/a.yml)',
      expect.stringMatching(
        /^sync\/callers\/b\.yml: job gif: workflow_run waits for "CI", which no workflow of the app is named/,
      ),
      expect.stringMatching(/names nothing here \(for \.github\/workflows\/b\.yml\)$/),
    ]);
  });
});
