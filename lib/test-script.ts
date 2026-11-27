// A test helper, not part of any tool: runs a script's command line in the
// test's own process, as `node <file> …args` would run it.
//
// A script's command line sits behind a guard (`process.argv[1]` is the
// file) that a plain import skips, so a test that wants it starts the script
// as a child `node` process. Coverage and Stryker see only the test's own
// process, so the lines run there count as never run, and Stryker reports
// their mutants as NoCoverage (ci#157's Q4). Here the script is imported
// afresh with `process.argv`, `process.env` and `process.exitCode` set as the
// child would have them, and all three restored after, so its lines run in
// process. The child-process test stays beside it, as the only check of what
// `node` itself does with the exit code.
//
// Its traps:
// - Only a command line that finishes while the module is evaluated: one
//   that starts a promise nothing awaits (`main().catch(…)`) runs on after
//   everything is restored, so its status is lost and it reads the test's
//   own env. One that calls `process.exit` makes Vitest throw.
// - `vi.resetModules()` resets the whole test file's registry, not this one
//   module: a later `import()` in the file gets a fresh copy too.

import { vi } from 'vitest';

type Env = Record<string, string | undefined>;

/** Makes Node's own `process.env` hold exactly `values`, so it keeps its string-only rules. */
function setEnv(values: Env) {
  for (const name of Object.keys(process.env)) delete process.env[name];
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) process.env[name] = value;
  }
}

/**
 * Imports `file` afresh (Vitest's module registry reset first, so its
 * top-level code runs again), with `process.exitCode` cleared, `argv` as
 * `process.argv` and `env`, when given, as the whole of `process.env`.
 * Returns the exit code the module left, or undefined when it set none, and
 * puts all three back whatever happens.
 */
async function importFresh(
  file: string,
  argv: string[],
  env?: Env,
): Promise<number | string | null | undefined> {
  const saved = { argv: process.argv, env: { ...process.env }, exitCode: process.exitCode };
  process.argv = argv;
  // TMPDIR stays unless given: it is this test file's own (lib/test-tmpdir.ts),
  // so what the script writes there is removed with it.
  if (env) setEnv({ TMPDIR: saved.env.TMPDIR, ...env });
  process.exitCode = undefined;
  try {
    vi.resetModules();
    await import(file);
    return process.exitCode;
  } finally {
    process.argv = saved.argv;
    setEnv(saved.env);
    process.exitCode = saved.exitCode;
  }
}

/**
 * Runs `file` as `node file …args` would, in this process, with `env` as its
 * whole environment (as a child given `env` gets nothing else, but for this
 * test file's TMPDIR), and returns its exit status as Node would exit with
 * it: the number it set as `process.exitCode`, or 0 when it set none.
 */
export async function runAsScript(file: string, args: string[], env: Env): Promise<number> {
  return Number((await importFresh(file, [process.execPath, file, ...args], env)) ?? 0);
}

/**
 * Imports `file` afresh as a module, not a script (`process.argv` and
 * `process.env` left as they are), and returns the exit code it set, which a
 * module whose command line stays behind its guard leaves undefined.
 */
export async function importOnly(file: string): Promise<number | string | null | undefined> {
  return importFresh(file, process.argv);
}
