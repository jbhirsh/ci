# Contributing

## Setup

Node 24, then `npm ci`. Nothing here is installed into the apps: they run these tools from
their own checkout, with their own dependencies.

## Changing a tool

Clone this repo beside the apps (`../ci`), change it, and run it against an app before opening
the PR, either the script itself or its self-test:

```bash
APP_ROOT=../BoardGames node <tool>/<script>.mjs
```

```bash
node <tool>/selftest.mjs ../BoardGames
```

The checks CI runs: `npm run lint`, `npm run typecheck`, `npm run format:check`,
`npm run test:coverage`.

## Required checks

`Check` (this repo's commit messages, lint, formatting, types, tests at 80% lines per file,
pins and actionlint) and `Against fog-and-frontier`, `Against sift` and `Against BoardGames`
(each tool's self-test against that app's `main`, with its dependencies installed).
`.github/workflows/ci.yml` says what each runs.

## The shared Claude rules

`claude-rules/CLAUDE.md`, the rules every repo here follows, exists only here, and no app holds
a copy. Every Claude session loads it from the user rules folder, where
`~/.claude/rules/jbhirsh-ci.md` links to it in a clone of this repo, so a change merged here
applies to every repo's next session:

- **In cloud sessions:** the Default environment's setup script clones this repo beside the
  session's repo and makes the link, fresh for every session.
- **On your computer:** make the link once, from the folder holding your clone of this repo:

  ```bash
  mkdir -p ~/.claude/rules && ln -sfn "$PWD/ci/claude-rules/CLAUDE.md" ~/.claude/rules/jbhirsh-ci.md
  ```

  The link reads the clone as it stands, so pull it to pick up a change.

- **Claude Review** reads the rules from its own checkout of this repo (`review/prompt.md`).
