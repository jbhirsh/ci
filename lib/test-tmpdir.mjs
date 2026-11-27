// Vitest setup file (vitest.config.mjs's setupFiles), not part of any tool:
// gives each test file a temporary directory of its own and removes it once
// the file's tests end.
//
// Tests make throwaway apps, git repositories and outputs with
// `mkdtempSync(path.join(tmpdir(), …))`, and most never remove them: one run
// of the suite left 598 directories (58 MB) in /tmp. Stryker runs the tests
// again for every mutant, so a sweep leaks gigabytes until the disk fills,
// and then the next git command a test runs fails (`Command failed: git -C
// /tmp/app-…`, reviewSettings' failure in ci#157's trial, word for word on a
// nearly full disk). Pointing TMPDIR here, which `os.tmpdir()` reads at each
// call and child processes inherit, catches them all, those a script under
// test makes included. A child a test starts with an env of its own, without
// TMPDIR, still writes to the system's.
//
// The directory goes when the file's tests end, or when its worker exits
// (a file whose tests are all skipped runs no afterAll). A worker that is
// killed, as Stryker kills one stuck on a mutant, leaves it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const outside = tmpdir();
const mine = mkdtempSync(path.join(outside, 'ci-test-'));
process.env.TMPDIR = mine;

const remove = () => {
  // Off again, so a worker running many files (isolate off) holds one.
  process.off('exit', remove);
  process.env.TMPDIR = outside;
  rmSync(mine, { recursive: true, force: true });
};
process.once('exit', remove);
afterAll(remove);
