# ci

Shared CI tooling for [fog-and-frontier](https://github.com/jbhirsh/fog-and-frontier),
[sift](https://github.com/jbhirsh/sift) and [BoardGames](https://github.com/jbhirsh/BoardGames):
one place for the checks, reviews and bots all three run, so a fix or a new check lands in
every app at once.

## How it works

The apps follow `main`. Each app's workflow keeps its own job, so its required check keeps its
name, and calls a composite action here at `@main`; a change merged here reaches all three on
their next run, with no PR in any of them. That's why every PR here is tested against all
three apps, as their `main` stands, before it can merge. Each tool reads its settings from the
app's `.github/ci.json`, one key per tool, so the apps share the code and keep their own
choices. The few files GitHub reads only from an app itself (its PR template, the callers of
the PR tools) are kept here too, and the sync (`sync/`) carries a change to them into each app
as one PR that merges itself once the app's checks pass.

## What it gives the apps

- **AI review and repair.** Claude Review reads every changed file of every PR and checks it
  against the app's conventions (`review/`); Claude autofix fixes CI failures and review
  threads on bots' PRs (`autofix/`). Both run on the
  [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), which the Max plan's
  API credit pays for; the review has no shell (`review/sdk.mjs`).
- **Tests that test the tests.** Mutation testing with [StrykerJS](https://stryker-mutator.io)
  on the lines a PR changed, and a monthly sweep of everything (`mutation/`): a test that
  passes whatever the code does fails here.
- **Gates no linter has.** Commit messages (`commits/`), version pins and type-coverage
  ignores without a reason (`pins/`), source files the coverage gate doesn't measure, with no
  reason (`unmeasured/`), a PR description out of the
  shared shape (`pr-template/`), secrets ([gitleaks](https://gitleaks.io),
  `gitleaks/`) and static analysis ([Semgrep](https://semgrep.dev), `semgrep/`).
- **Pictures of every change.** Before/after GIFs for a PR, recorded and attached to its
  description on their own whenever a push changes a GIF scenario (`gif/`), each PR's
  screenshots compared with main's, as an inline before/after table in its description and a
  `Visual changes` status that holds only a PR that merges itself (`visual-review/`, with
  `visual-shots/` in the app's screenshot job and `describe/` writing the bots' sections), README screenshots
  that refresh themselves (`readme-screenshots/`), and a CI run's pictures attached to an
  issue or a PR, so a plan's mockups reach its issue (`pictures/`), or a Claude session's own,
  pushed to a branch and attached by a dispatched workflow (`pictures.yml`).
  A PR's description lists each change's title, commit and files, written under its empty marker pair (`pr-changes/`).
- **Reports that remember.** Each job's summary, a report page on GitHub Pages and one PR
  comment, comparing the run with recent ones to show what got slower or flaky
  (`job-summary/`).
- **Upkeep on autopilot.** A weekly audit of dead code, duplication and broken links that
  keeps one issue per finding (`audit/`), Dependabot PRs that merge themselves once green
  (`dependabot-merge/`), and the shared Claude rules every repo here follows, kept here
  once and loaded by every Claude session, in every repo (`claude-rules/`).

Everything is plain JavaScript on Node 24: a tool runs from the app's checkout and uses the
app's own packages, so it tests with the versions the app ships. The one exception is the
screenshot comparison's pixelmatch and pngjs, which no app runs itself: they are this repo's
only runtime dependencies, installed by the actions that compare.

Working on it: `CONTRIBUTING.md`.
