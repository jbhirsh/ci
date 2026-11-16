# Contributing

## Setup

Node 24, then `npm ci`. Nothing here is installed into the apps: they run these tools from
their own checkout, with their own dependencies, and the actions that need this repo's runtime
libraries (the compare actions' pixelmatch and pngjs, the review's Agent SDK) install them
into their own copy of it.

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

## Claude Review

Claude Review runs on the Claude Agent SDK (`review/sdk.mjs`). An app's settings are in
`.github/ci.json` (`review/settings.mjs` says what each does), for example:

```json
{ "review": { "advisor": "opus", "skipBots": ["dependabot[bot]"] } }
```

- **Payment.** The Max plan's API credit, in the linked Console organization, pays for it;
  it doesn't pay for Claude Code, which is why the review left claude-code-action
  (jbhirsh/ci#68). The review shows each pass's cost in its job summary.
- **Sign-in.** Workload identity federation: the app's stub passes the four IDs and grants
  `id-token: write`. The Console rule matches by CEL, since its subject-prefix match refuses
  GitHub's `repo:<owner>@<id>/<repo>@<id>` subjects:
  `claims.repository_owner_id == "22871808" && claims.repository_owner == "jbhirsh"`, scope
  `workspace:developer`. An API key (`anthropic_api_key`) works instead.
- **Comments.** It posts with the job's own token, as github-actions[bot]. Each inline comment
  ends with `<!-- claude-review -->`, which autofix's review fixer looks for
  (`autofix/threads.mjs`).
- **Dependabot.** With `skipBots`, a bump nobody has pushed to isn't reviewed, and auto-merges
  on CI alone: the owner's decision (#68). Once autofix pushes a fix, the PR is reviewed.
- **Out of credit.** A pass refused for credit or a spend limit warns and passes the check.

## Claude autofix

Claude autofix runs on the Claude Agent SDK too (`autofix/sdk.mjs`), signed in as the review
is, with `"autofix": { "advisor": "opus" }` in `.github/ci.json`. An app's
`claude-autofix.yml` stub passes `bot_token: ${{ secrets.BOT_PR_TOKEN }}` beside the four
federation IDs. The fixer pushes and runs `gh` with that token, so its pushes start the PR's
workflows; it commits as github-actions[bot]. The token needs Contents and Pull requests read
and write and Actions read on the app, and no Workflows permission. It sits in the job that
runs a Dependabot bump's npm scripts, which `pr-gif-attach.yml` keeps it out of: the owner
accepted that here (jbhirsh/ci#68), as the job held the Claude app's token the same way before
autofix left claude-code-action.
