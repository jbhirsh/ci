// Self-test of visual review against an app's checkout:
// `node visual-review/selftest.ts <app dir>`. With no `visual-review` key
// the app doesn't use it yet, and that's said, not failed. With one, it
// checks that
//   - the settings parse (settings.ts);
//   - the screenshot workflow they name exists, and calls visual-shots;
//   - a visual-review.yml calls the reusable workflow, on workflow_run of
//     the screenshot workflow's name, and isn't listed among its own
//     triggers;
//   - the screenshot workflow never cancels a push run on main (its
//     concurrency doesn't cancel in progress, or keys pushes apart), since
//     a cancelled push run leaves its commit without shots.
// The workflows are read as text: the self-test runs with this repo's
// runtime packages only, which hold no YAML parser.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appConfig } from '../lib/app.mjs';
import { settings } from './settings.ts';

/**
 * A workflow's `name:`, or null.
 */
const nameOf = (text: string) => /^name:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1] ?? null;

/**
 * @returns what to print; throws on the first problem
 */
export function selftest(root: string): string[] {
  const s = settings(appConfig('visual-review', root));
  if (!s) return ['visual-review: no settings; the app uses no visual review yet.'];
  const workflows = path.join(root, '.github', 'workflows');
  const shots = path.join(workflows, s.workflow);
  if (!existsSync(shots))
    throw new Error(`visual-review.workflow: no .github/workflows/${s.workflow}`);
  const text = readFileSync(shots, 'utf8');
  if (!text.includes('jbhirsh/ci/visual-shots@')) {
    throw new Error(`${s.workflow} doesn't upload its shots (jbhirsh/ci/visual-shots)`);
  }
  if (/cancel-in-progress:\s*true\s*$/m.test(text)) {
    throw new Error(
      `${s.workflow} cancels runs in progress, which can cancel a push run on main and leave its commit without shots: set cancel-in-progress to false for push`,
    );
  }
  const name = nameOf(text) ?? s.workflow;
  const stub = path.join(workflows, 'visual-review.yml');
  if (!existsSync(stub))
    throw new Error('no .github/workflows/visual-review.yml calls visual review');
  const caller = readFileSync(stub, 'utf8');
  if (!caller.includes('jbhirsh/ci/.github/workflows/visual-review.yml@')) {
    throw new Error("visual-review.yml doesn't call jbhirsh/ci's visual-review workflow");
  }
  const listed =
    /workflows:\s*\[([^\]]*)\]/
      .exec(caller)?.[1]
      .split(',')
      .map((w) => w.trim().replace(/^["']|["']$/g, '')) ?? [];
  if (!listed.includes(name)) {
    throw new Error(
      `visual-review.yml's workflow_run doesn't list ${name}, the screenshot workflow`,
    );
  }
  const own = nameOf(caller);
  if (own && listed.includes(own))
    throw new Error('visual-review.yml lists itself among its triggers');
  return [
    `visual-review: ${s.workflow} (${s.job}) takes the shots of ${s.folders.join(', ')}; visual-review.yml wakes on ${listed.join(', ')}.`,
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const line of selftest(path.resolve(process.argv[2] ?? '.'))) console.log(line);
}
