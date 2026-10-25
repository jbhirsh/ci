# CLAUDE.md

Shared CI tooling for jbhirsh/fog-and-frontier, jbhirsh/sift and
jbhirsh/BoardGames. The apps run `main`, at every CI run, with no version
pin: a merge here changes all three at once.

## Rules

- **Never break an app.** A change must work for all three apps as their
  `main` stands. CI runs every tool's self-test (`selftest.mjs`, given an app's checkout)
  against each app; a new setting has a default that keeps
  today's behaviour, and a setting is removed only after no app uses it.
- **Docs live with the code.** Each module's header, each `action.yml`'s
  descriptions, each workflow's comments say what it does and why. README is
  a map, this file is rules; neither repeats what a header says. Explain a
  setting where it's read, not here.
- **No runtime dependencies.** Scripts run from an app's checkout with
  nothing installed from this repo: Node's built-ins, plus what the app
  installs (through `importFromApp` in `lib/app.mjs`). `devDependencies`
  are for this repo's tests and type-checking only.
- **Plain JavaScript (`.mjs`), typed in JSDoc**, checked by TypeScript
  (`checkJs`, strict; `npm run typecheck`): it runs on Node 24 from any path,
  with no build or type stripping.
- **One composite action per job.** An app's job keeps its `name:` (its
  required check) and calls `jbhirsh/ci/<tool>@main`; a tool that needs
  several jobs (a matrix) is a reusable workflow in `.github/workflows/`,
  used only where no required check depends on its job names. Secrets come
  in as inputs.
- **Node 24 and the latest major of each action**, everywhere.
- **Tests ship with the code**: a test beside each module (`*.test.mjs`,
  Vitest), 80% lines per file (`npm run test:coverage`); property tests
  (`fast-check`) for pure helpers taking outside input.
- **Commits**: imperative subject <=72 chars, a body saying why, the
  Co-Authored-By trailer; linear history.

## Changing a tool

Clone this repo beside the apps (`../ci`), change it, and run it against an
app before opening the PR: `APP_ROOT=../BoardGames node <tool>/<script>.mjs`
or `node <tool>/selftest.mjs ../BoardGames`.

Checks: `npm run lint`, `npm run typecheck`, `npm run format:check`,
`npm run test:coverage`.
