# ci

Shared CI tooling for [fog-and-frontier](https://github.com/jbhirsh/fog-and-frontier),
[sift](https://github.com/jbhirsh/sift) and [BoardGames](https://github.com/jbhirsh/BoardGames).

The apps follow `main`: each app's workflow keeps its own job (so its required
check keeps its name) and calls a composite action here at `@main`, so a change
merged here reaches all three on their next run, with no PR in any of them.
Every PR here is therefore tested against all three apps before it can merge
(`.github/workflows/ci.yml`).

Each directory is one tool; its `action.yml` and module headers say what it
does and what it reads from the app's `.github/ci.json`. This file is only a
map; the documentation lives with the code.

| Directory             | What                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/`                | what every tool shares: the app's checkout, packages and settings; Actions outputs                                                                     |
| `mutation/`           | Stryker on the lines a PR changed, and the monthly sweep (`.github/workflows/mutation-sweep.yml`)                                                      |
| `commits/`            | the commit-message check                                                                                                                               |
| `pins/`               | a version pinned (package.json, overrides, Dependabot ignores, actions, images, tools) needs a reason beside it                                        |
| `visuals/`            | `PR visuals`: a UI change needs pictures in its description                                                                                            |
| `audit/`              | the weekly audit (`.github/workflows/audit.yml`): knip, jscpd, lychee, the dependency graph, one tracking issue per finding                            |
| `readme-screenshots/` | the README screenshot bot's comparison and its one PR                                                                                                  |
| `dependabot-merge/`   | auto-merge for Dependabot's npm PRs                                                                                                                    |
| `gitleaks/`           | `Secret scan`                                                                                                                                          |
| `semgrep/`            | `SAST scan`                                                                                                                                            |
| `gif/`                | before/after PR GIFs: the web recorder for fog and BoardGames, sift's videos, publishing to `screenshots`                                              |
| `review/`             | `Claude Review`: the AI review, its check that every changed file was read, and carrying unchanged files over between pushes                           |
| `autofix/`            | Claude autofix on bots' PRs: CI failures and review threads, once every run on the head has finished; `check-triggers` keeps its trigger list complete |
