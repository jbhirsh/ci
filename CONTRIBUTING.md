# Contributing

## Setup

Node 24, then `npm ci`. Nothing here is installed into the apps: they run these tools from
their own checkout, with their own dependencies, and the actions that need this repo's runtime
libraries (the compare actions' pixelmatch and pngjs, the review's Agent SDK) install them
into their own copy of it.

## Changing a tool

Clone this repo beside the apps (`../ci`), change it, and run it against an app before opening
the PR, either the script itself or its self-test (`.ts`, or `.mjs` in a tool not yet moved to
TypeScript, ci#155):

```bash
APP_ROOT=../BoardGames node <tool>/<script>.ts
```

```bash
node <tool>/selftest.ts ../BoardGames
```

The GIF tool runs as the apps run it, `node gif/cli.mjs <scenario>`: `gif/cli.ts` only exports its
`main`.

The probe runs against a deployment rather than a checkout (`probe/web/run.ts`'s header lists
its inputs; WebKit comes from `npx playwright install --with-deps webkit`):

```bash
APP_ROOT=../BoardGames PROBE_URL=https://<deployment> node probe/web/run.ts
```

The checks CI runs: `npm run lint`, `npm run typecheck`, `npm run format:check`,
`npm run test:coverage`.

## Required checks

`Check` (this repo's commit messages, lint, formatting, types, tests at 80% lines per file,
pins and actionlint) and `Against fog-and-frontier`, `Against sift` and `Against BoardGames`
(each tool's self-test against that app's `main`, with its dependencies installed), and
`PR description` (a PR's description held to the shared shape, as in the apps, including the
Revisions marker pair once a push has moved the PR's head, and a filled row in its current revision;
`.github/workflows/pr-description.yml` and `pr-template/body.ts`'s header say how). `.github/workflows/ci.yml` says what the others run.

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

Claude Review runs on the Claude Agent SDK (`review/sdk.ts`). An app's settings are in
`.github/ci.json` (`review/settings.ts` says what each does), for example:

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

`pr-changes/` fills each change's title, commit and files in a PR's description (you write only why, in bullets under its empty pair: there is no heading per change), with the line counts as small coloured pictures (ci#79, ci#100). Until the sync from #109 carries the new template into an app, a PR there keeps its numbered `### N.` heading above each pair and the tool writes the title under it, so each change shows twice for a while (intended); a link to an old change-heading anchor has no target in a description written the new way. Each app holds this repo's own `.github/workflows/pr-changes.yml`, which the sync keeps in step (The sync, below).

- **It runs on `pull_request_target`**, which runs the workflow as it is on the default branch, never the PR's copy, so it may hold `BOT_PR_TOKEN` (the apps' fine-grained token: attaching a file needs a person's token). That is safe because the job checks out and runs nothing from the PR: keep it that way. `pr-changes/action.yml`'s description lists the rules (no checkout, no cache, no PR text in a `run:` line or an expression, the token only on the attach call and the one Revisions edit). A change to the workflow takes effect once it is on the default branch.
- **Its own concurrency group**, not PR GIFs' attach group (which visual review's attach job shares): GitHub keeps one pending run per group, so sharing would let each cancel the other's pending run.
- **`autofix.exempt`:** the app's `.github/ci.json` needs its entry, or `autofix/check-triggers.mjs` fails the app's CI for a `pull_request_target` workflow: the sync adds it with the file (a companion in `sync/manifest.json`).
- **Revisions:** the same action keeps the description's Revisions block (`pr-changes/revisions.ts`'s header says the grammar and the rules).
  - **When it writes:**
    - A PR with one head gets nothing.
    - A description with no revisions marker at all gets the empty `<!-- pr-changes:revisions -->` pair back when a push moves the head: above the index block, or at the end ahead of a footer rule.
    - Once a push or a force-push moves the head it writes `## Revisions` inside the pair, row 1 for the head the PR opened at and one for each later head.
    - `revisions: "false"` turns it off.
  - **The shape:**
    - Each revision is a collapsible `<details>`, newest first: the newest is `<details open>`, the older ones closed.
    - Its `<summary>` is the head link (the current one bold with a pointer and `(current)`), a compare link to the head before it (`compare <code>old…new</code>`: GitHub drops a link whose whole text is the range), and the tool's note (`Opened`, `rewritten from … (N commits dropped)`).
    - Under it is a table `| What changed | Why |` that the AUTHOR fills: one row for each change, in plain words.
    - The tool never derives a row from a commit, because this repo reworks and squashes commits: it writes one empty row for a revision with none, and keeps every row an author wrote.
    - A table in HTML with set widths, one with three columns, a list and a heading per revision were tried on github.com at 402px and left: the owner found a table of two columns under a label easier to read on a phone.
  - **What an author can type:**
    - A pipe in a cell is written `\|`: a row with other than two cells is written as GitHub reads it (the cells after the second joined into it, or an empty second cell).
    - A tag that would end a block, a cell or the table (`</details>`, `<summary>`, a table's tags) is made harmless (`&lt;`) in what an author or a commit subject wrote.
    - A `(current)` typed after a head link in a row is defused with a zero-width space.
    - Text typed outside the blocks stays below them, in order; text typed in a block stays in it.
    - A summary an author types with a head link of this repo is read as a revision: delete it to remove it.
    - An unclosed code fence inside the block hides the end marker from the check, as it always did: close it.
  - **The size limit:**
    - The block is held to 12,000 characters only by leaving out whole old revisions, oldest first after revision 1 and never the newest, with a line saying how many.
    - A kept revision's rows are never shortened; text typed outside the blocks is never left out, so shorten it if it is what makes the description too long.
  - **Earlier shapes:** the HTML table of ci#132's first push, the two-column Markdown table and the old four-column one are still read and are rewritten as blocks, their Why in the first row's Why cell and their What lines as its What.
  - **The token:** it needs the person's token, as its edit is what makes the description check run again on a description whose current revision names the new head, and an edit by the Actions token starts no workflow.
    - A same-repo PR that needs a row and has no token fails the `PR changes` job (never a required check).
    - A fork's PR only gets a notice, and the check stays red until its author adds the row by hand.
  - **The first write** rebuilds the earlier revisions from the PR's timeline: the head each force-push made, in order.
    - It lists the first and the latest 19 at most, with their true numbers and a line, kept on later pushes, saying how many are not listed.
    - Each has a compare link and a note where GitHub still has the commits, "(commits replaced by a force-push)" where it doesn't, and a note where none of a revision's commits is on the PR any more or GitHub failed to read its range.
    - Revision 1 says `Opened` unless a force-push came before the head it names, and its first row is the goal's first sentence.
  - **What the timeline does not give:**
    - The head a PR opened at once a force-push replaced it (revision 1 is then the first head a force-push made).
    - The heads of plain pushes: one revision covers the commits of several between two force-pushes.
    - A head force-pushed away and never fetched.
    - For a PR whose timeline names no force-push, the only record of the opening head is the push event's `before`, so revision 1 shows the head before the push that first wrote the blocks: after two pushes in quick succession, or when the first push's run failed (no token, say), that is the head between them.
- **Without a token** (a fork's PR, or no secret) the counts are plain text and the run says why. `BOT_PR_TOKEN` also needs Contents, Pull requests and Issues read and write on this repository to try the tool here.

## Visual review

`.github/workflows/visual-review.yml`'s header says how an app calls it; nothing here needs an app's own change.

- **No comment** (ci#144): its attach job uploads a result's pictures in one edit of the PR's description, or a mockup issue's, with `BOT_PR_TOKEN`, then writes the table with the Actions token (`visual-review/attach.ts`'s header says in what order). That one edit runs `PR changes` and `PR description` once; visual review skips it.
- **`BOT_PR_TOKEN`** needs Pull requests write for a PR's description and Issues write for a mockup issue's, on each app.
- **Its attach job shares PR GIFs' attach group** (`pr-gif-attach-<repo>-<number>`), so neither overwrites the other's block.
- **Upload comments from before ci#144** stay until the cleanup ci#144's plan describes: a PR with one and no record uploads once in the new form at its next review, and the old comment is hidden.

## The sync

The sync (ci#109) keeps each app's copies of the files in `sync/manifest.json` byte-identical
to their source here, through one `bot/sync-files` PR per app that merges itself once the
app's required checks pass.
[`.github/workflows/sync-files.yml`](https://github.com/jbhirsh/ci/blob/main/.github/workflows/sync-files.yml)
says when it runs, [`sync/sync.mjs`](https://github.com/jbhirsh/ci/blob/main/sync/sync.mjs) what a run does and
[`sync/manifest.mjs`](https://github.com/jbhirsh/ci/blob/main/sync/manifest.mjs) the manifest's fields and rules.

- **One-time setup (the owner):** this repo's `BOT_PR_TOKEN`, a fine-grained token on the
  three apps (and on this repo, for the pictures route), with the permissions
  [`sync/action.yml`](https://github.com/jbhirsh/ci/blob/main/sync/action.yml)'s `token` input lists.
  Without it every run fails at its first step, naming the token, and changes nothing in an
  app.
- **Adding a synced file:** its canonical file here and one entry in `sync/manifest.json`
  (its path in the apps, its source here, which apps hold it).
  - `sync/coverage.test.mjs` fails a canonical caller or reusable workflow that is neither
    synced nor listed in `unsynced` with a reason.
  - A workflow that runs on `pull_request` or `pull_request_target` carries its
    `autofix.exempt` entry as a `companions` key: the sync sets it in the app's
    `.github/ci.json` in the same commit, never overwriting a key the app holds.
  - Try it before the PR: `node sync/sync.mjs dry-run sift ../sift` prints the PR the sync
    would open for that checkout and changes nothing; each `Against` job's self-test prints
    the same for the app's `main`.
- **A deliberate difference in one app** is a variant: the app's whole file under
  `sync/variants/<app>/`, named in the entry's `variants` with a `why`, which the sync PR
  shows. Change it here like any synced file. An app can't declare its own.
- **Reading a sync PR:** "Sync shared files with jbhirsh/ci", from `bot/sync-files`, one
  commit per file. Its table lists each file (added or updated, its source at the synced
  commit, the lines changed), then each variant's `why` and each `ci.json` key it adds.
  Auto-merge is on, bound to the head the sync checked. There is nothing to do unless a run
  goes red.
- **A run by hand,** from `main`, for one app or all of them; `auto-merge` false opens or
  updates the PR and leaves it, auto-merge off, for a person to merge:

  ```sh
  gh workflow run sync-files.yml --repo jbhirsh/ci -f app=sift
  gh workflow run sync-files.yml --repo jbhirsh/ci -f app=all
  gh workflow run sync-files.yml --repo jbhirsh/ci -f app=sift -f auto-merge=false
  ```

- **When a run goes red,** its log names the app and the cause; nothing waits, and a PR that
  gets stuck later is reported at the next run (a ci change, or one by hand).
  - **An unresolved review thread:** read it and resolve it in the app; never auto-resolved.
    CodeQL raises one ("unpinned action") once on each newly synced workflow.
  - **`Visual changes` in the app** ("1 screen changed, and this PR merges itself"): the
    app's visual review holds any PR that merges itself when a screen changed, a sync PR too
    (fog-and-frontier's first, [#373](https://github.com/jbhirsh/fog-and-frontier/pull/373)).
    Look at the PR's table, then merge it or turn its auto-merge off, as the status says. If
    the change is noise, fix the flaky screen in the app.
  - **A failed required check:** fix its cause. A synced file's source is fixed here, and the
    next run rebuilds the PR. For a cause in the app, fix it on the app's `main`, then close
    the sync PR and run the sync by hand, which opens a fresh one from the app's head (never
    GitHub's Update branch: the apps' commit check refuses its merge commit).
  - **Blocked, with every check passing and no thread open:** the log names main's rule
    types; the app's branch rule is the place to look.
  - **In conflict with the app's `main`, or behind it where the app requires an up-to-date
    branch:** not a failure; the run rebuilds the branch from the app's head. Each rebuild in
    sift, which requires an up-to-date branch, reruns its hour of checks.
  - **The token:** a missing Workflows permission fails the push, naming it, and changes
    nothing in the app.
- **Holding a sync PR:** make it a draft (the sync leaves a draft without auto-merge until it
  is marked ready), or run it by hand with `auto-merge` false. Closing it holds nothing: the
  next run opens a fresh one while a file still differs.
- **A hand edit in an app** to a synced file is reverted by the next sync PR, as a visible
  diff. To keep it, make it a variant here.

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
   run deletes it by name, and its run is named for it. Never push to it again once dispatched:
   a later push is deleted with it, unread.

   ```sh
   git worktree add --orphan -b pictures/ci-132-revisions ../pictures-ci-132
   cp before-402.png after-402.png ../pictures-ci-132/
   git -C ../pictures-ci-132 add before-402.png after-402.png
   git -C ../pictures-ci-132 commit -m "Pictures for ci#132"
   git -C ../pictures-ci-132 push origin pictures/ci-132-revisions
   git worktree remove ../pictures-ci-132 && git branch -D pictures/ci-132-revisions
   ```

4. Dispatch it on `main`. `host-pr` left out takes `PICTURES_HOST_PR`; while that is unset, the
   run refuses an empty one, so pass it: a ci target's own number (`-f 'inputs[host-pr]=132'`),
   or for an app's target any ci PR whose description may be overwritten, such as
   [ci#134](https://github.com/jbhirsh/ci/pull/134), the closed trial host kept for this. Ask for
   the run's id in the answer:

   ```sh
   gh api -X POST repos/jbhirsh/ci/actions/workflows/pictures.yml/dispatches -f ref=main \
     -F return_run_details=true \
     -f 'inputs[branch]=pictures/ci-132-revisions' -f 'inputs[target]=132' \
     -f 'inputs[block]=revisions' \
     -f "inputs[files]=$(printf 'before-402.png | Before (main), phone\nafter-402.png | After, phone')" \
     --jq .workflow_run_id
   ```

   If the answer has no id (or the API refuses `return_run_details`: drop it), find the run by
   its name, never by "the newest run". GitHub may not list it the moment the dispatch answers:
   if this read finds nothing, read once more, with no pause, and if that finds nothing too,
   stop and report the run's name (`Pictures from <branch>`) rather than loop or dispatch again:

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
  jobs" never works, as Files finds the branch it deleted.
- **A refused input still costs the branch.** Files deletes the branch once its name is
  accepted, whatever it refuses after that (an unset `PICTURES_HOST_PR`, a mistyped `target` or
  `block`, a missing path, a file that isn't a picture), and its log says which with a
  `pictures: …` line. Fix the input, push the pictures again under a new name and dispatch
  again. A branch name it refuses is never deleted, and a run cancelled while pending never
  started and kept its branch.
- **An app's issue or PR:** no app gets a workflow, secret or file. Dispatch with the host PR as
  `target` and a block named for the app's target (`<app>-<n>`, such as `sift-249`), put the empty pair in the app's
  description, then copy the finished block from the host into it by REST:

  ```sh
  gh api repos/jbhirsh/ci/pulls/<host> --jq .body > host.md
  gh api repos/jbhirsh/<app>/issues/<n> --jq .body > app.md
  # take the <!-- pictures:<app>-<n> --> … <!-- /pictures:<app>-<n> --> block from host.md
  # into app.md's empty pair, then:
  gh api -X PATCH repos/jbhirsh/<app>/issues/<n> -F body=@app.md
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
