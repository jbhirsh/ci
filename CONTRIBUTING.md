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
(each tool's self-test against that app's `main`, with its dependencies installed), and
`PR description` (a PR's description held to the shared shape, as in the apps, including the
Revisions marker pair once a push has moved the PR's head;
`.github/workflows/pr-description.yml` and `pr-template/body.mjs`'s header say how). `.github/workflows/ci.yml` says what the others run.

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
- **Out of credit.** A pass the API refuses for credit or a spend or usage limit runs once more
  on the owner's Claude subscription, then fails the check if it's still stopped, for every PR.
  One PR comment says which limit and when it resets; re-run the job after then.
- **The subscription token.** Each app keeps `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`)
  as an Actions secret and as a Dependabot secret, since Dependabot's PRs see only Dependabot
  secrets, and its review stub passes `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`.
  Without it a stop isn't retried. A fork's PR gets no secrets, so a stop fails it.

## PR changes

`pr-changes/` fills each change's title, commit and files in a PR's description (you write only why, in bullets under its empty pair: there is no heading per change), with the line counts as small coloured pictures (ci#79, ci#100). Until the sync from #109 carries the new template into an app, a PR there keeps its numbered `### N.` heading above each pair and the tool writes the title under it, so each change shows twice for a while (intended); a link to an old change-heading anchor has no target in a description written the new way. An app adopts it with a workflow of its own, `.github/workflows/pr-changes.yml`:

```yaml
on:
  pull_request_target:
    types: [opened, reopened, synchronize, edited]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: pr-changes-${{ github.repository }}-${{ github.event.pull_request.number }}
  cancel-in-progress: false
jobs:
  pr-changes:
    runs-on: ubuntu-latest
    steps:
      - uses: jbhirsh/ci/pr-changes@main
        with:
          number: ${{ github.event.pull_request.number }}
          # A fork's PR gets no person's token: its counts are plain text.
          token: ${{ github.event.pull_request.head.repo.full_name == github.repository && secrets.BOT_PR_TOKEN || '' }}
```

- **It runs on `pull_request_target`**, which runs the workflow as it is on the default branch, never the PR's copy, so it may hold `BOT_PR_TOKEN` (the apps' fine-grained token: attaching a file needs a person's token). That is safe because the job checks out and runs nothing from the PR: keep it that way. `pr-changes/action.yml`'s description lists the rules (no checkout, no cache, no PR text in a `run:` line or an expression, the token only on the attach call and the one Revisions edit). A change to the workflow takes effect once it is on the default branch.
- **Its own concurrency group**, not describe's: GitHub keeps one pending run per group, so sharing would let each cancel the other's pending run.
- **`autofix.exempt`:** add an entry for it in `.github/ci.json`, with its reason ("PR changes: reads the PR as data, runs none of its code"), or `autofix/check-triggers.mjs` fails the app's CI for a `pull_request_target` workflow.
- **Revisions:** the same action keeps the description's Revisions table (`pr-changes/revisions.mjs`'s header says the row grammar and the rules). A PR with one head gets nothing; a description with no revisions marker at all (rewritten without the template's pair) gets the empty pair back when a push moves the head, above the index block or, with none, at the end ahead of a footer rule; once a push or a force-push moves the head it writes `## Revisions` and a table inside the template's `<!-- pr-changes:revisions -->` pair, row 1 for the head the PR opened at and a row for each later head, whose Why the author writes. The table has two columns, What changed (the head link first, then what changed) and Why; the current row is bold with a pointer, and each push moves it (the header of `pr-changes/revisions.mjs` says why, and how a row is read). A table in the old four-column shape is still read and is rewritten in the new one. It needs the token: its edit is what makes the description check run again on a description whose current row names the new head, and an edit by the Actions token starts no workflow. A same-repo PR that needs a row and has no token fails the `PR changes` job (never a required check); a fork's PR only gets a notice, and the check stays red until its author adds the row by hand. `revisions: "false"` turns it off. The first write rebuilds the earlier rows from the PR's timeline: the head each force-push made, in order (the first and the latest 19 at most, with their true numbers and a line, kept on later pushes, saying how many are not listed), with what changed where GitHub still has the commits, "(commits replaced by a force-push)" where it doesn't, and a note where none of a row's commits is on the PR any more or GitHub failed to read its range. Row 1 says `Opened` unless a force-push came before the head it names. What the author typed in the block stays below the table. The timeline does not give the head a PR opened at once a force-push replaced it (row 1 is then the first head a force-push made), the heads of plain pushes (one row covers the commits of several between two force-pushes), or a head force-pushed away and never fetched. A PR whose timeline names no force-push has no record of the head it opened at except the push event's `before`, so row 1 shows the head before the push that first wrote the table: after two pushes in quick succession, or when the first push's run failed (no token, say), that is the head between them. A Why with `|` in it is kept as one cell, its pipes escaped.
- **Without a token** (a fork's PR, or no secret) the counts are plain text and the run says why. `BOT_PR_TOKEN` also needs Contents, Pull requests and Issues read and write on this repository to try the tool here.

## Pictures from a session

A Claude session can push a branch and dispatch a workflow, but can't upload a file. The
pictures route (`.github/workflows/pictures.yml`, ci#133) attaches a session's own PNGs to an
issue or a PR here, as a table between `<!-- pictures:<block> -->` markers; the workflow's
header says how it works and what it trusts.

- **One-time setup (the owner):** a draft PR in this repo whose description may be overwritten
  (`Pictures host (never merge)`), its number in the repository variable `PICTURES_HOST_PR`, and
  `BOT_PR_TOKEN` with Contents, Pull requests and Issues write here.
- **Trust:** the token is only in the Attach job, which runs none of a PR's code or the
  session's files and checks nothing out. That does not guard the token against anyone who can
  push here: it is a plain repository secret, which any workflow on a pushed branch can use.
- **A ci PR target:** dispatch only after the PR's `PR changes` run has finished (it edits the
  same description in its own group), then read the block back.

1. Shoot GitHub's own page, signed out, cropped to the element: ci's Playwright on the
   session's Chrome (`chromium.launch({ executablePath: '/usr/bin/google-chrome' })`, a 402 or
   1000 viewport, `colorScheme` light or dark, `page.locator(…).screenshot({ path })`).
2. Put the empty pair where the table belongs, in the target's description, before dispatching
   (a block with no pair lands at the end):

   ```markdown
   <!-- pictures:revisions --><!-- /pictures:revisions -->
   ```

3. Push an orphan `pictures/<name>` branch holding only the PNGs, staged by name. Use a new name
   for each dispatch (`pictures/` then letters, digits, `_`, `.` and `-`, no `--` or `..`): the
   run deletes it, and its run is named for it.

   ```sh
   git worktree add --orphan -b pictures/ci-132-revisions ../pictures-ci-132
   cp before-402.png after-402.png ../pictures-ci-132/
   git -C ../pictures-ci-132 add before-402.png after-402.png
   git -C ../pictures-ci-132 commit -m "Pictures for ci#132"
   git -C ../pictures-ci-132 push origin pictures/ci-132-revisions
   ```

4. Dispatch it on `main` (`host-pr` left out takes `PICTURES_HOST_PR`). Ask for the run's id in
   the answer:

   ```sh
   gh api -X POST repos/jbhirsh/ci/actions/workflows/pictures.yml/dispatches -f ref=main \
     -F return_run_details=true \
     -f 'inputs[branch]=pictures/ci-132-revisions' -f 'inputs[target]=132' \
     -f 'inputs[block]=revisions' \
     -f "inputs[files]=$(printf 'before-402.png | Before (main), phone\nafter-402.png | After, phone')" \
     --jq .workflow_run_id
   ```

   If the answer has no id (or the API refuses `return_run_details`: drop it), find the run once
   by its name, never by "the newest run":

   ```sh
   gh run list -R jbhirsh/ci -w pictures.yml -L 100 --json databaseId,displayTitle \
     --jq '.[] | select(.displayTitle == "Pictures from pictures/ci-132-revisions") | .databaseId'
   ```

5. Wait for it to end, then read the description back and check the block:

   ```sh
   gh run watch <run id> -R jbhirsh/ci --exit-status
   gh api repos/jbhirsh/ci/issues/132 --jq .body
   ```

- **Redo:** a failed Attach reruns on the same artifact, within a day (its retention)
  (`gh api -X POST repos/jbhirsh/ci/actions/runs/<run id>/rerun-failed-jobs`); "Re-run all
  jobs" never works, as Files finds the branch it deleted. A failed Files
  run has deleted the branch (once its name was accepted), and a run cancelled while pending
  never started and kept it: push again under a new name and dispatch again.
- **An app's issue or PR:** no app gets a workflow, secret or file. Dispatch with the host PR as
  `target` and a block named for the app's target (`sift-249`), put the empty pair in the app's
  description, then copy the finished block from the host into it by REST:

  ```sh
  gh api repos/jbhirsh/ci/pulls/<host> --jq .body > host.md
  # take the <!-- pictures:sift-249 --> … <!-- /pictures:sift-249 --> block from host.md
  # into the app description's empty pair, then:
  gh api -X PATCH repos/jbhirsh/sift/issues/249 -F body=@app.md
  ```

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
