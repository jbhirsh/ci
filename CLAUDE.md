# CLAUDE.md

@claude-rules/CLAUDE.md

## This repo

Shared CI tooling for jbhirsh/fog-and-frontier, jbhirsh/sift and jbhirsh/BoardGames. The apps
run `main`, at every CI run, with no version pin: a merge here changes all three at once.
Changing and testing a tool against an app is in `CONTRIBUTING.md`.

- **Never break an app.** A change must work for all three apps as their `main` stands. CI
  runs every tool's self-test (`selftest.mjs`, given an app's checkout) against each app; a
  new setting has a default that keeps today's behaviour, and a setting is removed only after
  no app uses it.
- **Explain a setting where it's read.** Each `action.yml`'s descriptions and each workflow's
  comments say what it does and why.
- **Runtime dependencies only for a library no app runs.** Scripts run from an app's checkout:
  a package the app runs itself (Prettier, Playwright, knip, Vite, jscpd) comes from the app,
  through `importFromApp` in `lib/app.mjs`; a library only this repo's code imports (pixelmatch,
  pngjs) is this repo's `dependencies`, installed by the action that needs it from this repo's
  lockfile. A bump of one reaches all three apps without passing any app's CI, only this
  repo's tests and the self-tests against each app's checkout, so review it as a change to all
  three. `devDependencies` are for this repo's tests and type-checking only.
- **Plain JavaScript (`.mjs`), typed in JSDoc**, checked by TypeScript (`checkJs`, strict): it
  runs on Node 24 from any path, with no build or type stripping.
  `npm run typecheck` runs TypeScript 7 by path, never bare `tsc`: the TypeScript 6 API the
  audit's tests parse with (`@typescript/typescript6`) brings a `tsc` of its own.
- **One composite action per job.** An app's job keeps its `name:` (its required check) and
  calls `jbhirsh/ci/<tool>@main`; a tool that needs several jobs (a matrix) is a reusable
  workflow in `.github/workflows/`, used only where no required check depends on its job
  names. Secrets come in as inputs.
- **Node 24 and the latest major of each action**, everywhere.
- **A test beside each module** (`*.test.mjs`, Vitest).
