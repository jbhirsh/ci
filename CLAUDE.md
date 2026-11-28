# CLAUDE.md

@claude-rules/CLAUDE.md

## This repo

Shared CI tooling for jbhirsh/fog-and-frontier, jbhirsh/sift and jbhirsh/BoardGames. The apps
run `main`, at every CI run, with no version pin: a merge here changes all three at once.
Changing and testing a tool against an app is in `CONTRIBUTING.md`.

- **Never break an app.** A change must work for all three apps as their `main` stands. CI
  runs every tool's self-test (`selftest.ts`, given an app's checkout) against each app; a
  new setting has a default that keeps today's behaviour, and a setting is removed only after
  no app uses it.
- **Explain a setting where it's read.** Each `action.yml`'s descriptions and each workflow's
  comments say what it does and why.
- **Runtime dependencies only for a library no app runs.** Scripts run from an app's checkout:
  a package the app runs itself (Prettier, Playwright, knip, Vite, jscpd) comes from the app,
  through `importFromApp` in `lib/app.ts`; a library only this repo's code imports (pixelmatch,
  pngjs) is this repo's `dependencies`, installed by the action that needs it from this repo's
  lockfile. A bump of one reaches all three apps without passing any app's CI, only this
  repo's tests and the self-tests against each app's checkout, so review it as a change to all
  three. `devDependencies` are for this repo's tests and type-checking only.
- **TypeScript that Node 24 runs as it is**, by stripping its types: no build, no compiled
  output. A relative import names the `.ts` file: TypeScript also takes `./x.js`, which Node
  then can't find. The only other source is `eslint.config.js`, as ESLint 10 loads a `.ts`
  config only through a loader or a flag. An action on the runner's own Node (`job-summary/note`,
  `sample-load`) checks that it strips types first, and warns rather than fails when not.
  `npm run typecheck` runs TypeScript 7 by path (`@typescript/native`), never bare `tsc`:
  `typescript` is the TypeScript 6 API that typescript-eslint, Stryker and the audit's tests
  load, with a `tsc` of its own.
- **One composite action per job.** An app's job keeps its `name:` (its required check) and
  calls `jbhirsh/ci/<tool>@main`; a tool that needs several jobs (a matrix) is a reusable
  workflow in `.github/workflows/`, used only where no required check depends on its job
  names. Secrets come in as inputs.
- **Node 24 and the latest major of each action**, everywhere.
- **A test beside each module** (`*.test.ts`, Vitest).
- **Stryker runs the tests over instrumented code** (`stryker.config.json`, ci#157): a function
  whose source a test sends into a page (`toString()`, `page.evaluate`) can't run there
  instrumented, so the page gets a binding Node answers (as `gif/overlay.ts` does) or an
  expression as text (as `job-summary/gif/scenarios/measures.ts` does) instead.
- **Each test file's temp directory is removed when the file ends**: `lib/test-tmpdir.ts`
  points `TMPDIR` at one of its own, so `tmpdir()` needs no cleanup; a child a test starts with
  an env of its own passes `TMPDIR` on, or what it writes stays in `/tmp`.
