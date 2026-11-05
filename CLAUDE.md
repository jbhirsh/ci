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
- **No runtime dependencies.** Scripts run from an app's checkout with nothing installed from
  this repo: Node's built-ins, plus what the app installs (through `importFromApp` in
  `lib/app.mjs`). `devDependencies` are for this repo's tests and type-checking only.
- **Plain JavaScript (`.mjs`), typed in JSDoc**, checked by TypeScript (`checkJs`, strict): it
  runs on Node 24 from any path, with no build or type stripping.
- **One composite action per job.** An app's job keeps its `name:` (its required check) and
  calls `jbhirsh/ci/<tool>@main`; a tool that needs several jobs (a matrix) is a reusable
  workflow in `.github/workflows/`, used only where no required check depends on its job
  names. Secrets come in as inputs.
- **Node 24 and the latest major of each action**, everywhere.
- **A test beside each module** (`*.test.mjs`, Vitest).
