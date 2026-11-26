# Shared rules

These rules hold in jbhirsh/ci and in each app that uses its CI tooling. They live only in
jbhirsh/ci, in `claude-rules/CLAUDE.md`; change them there. Rules enforced by tooling aren't
repeated here.

## New features: ticket, plan, review, approval

Every new feature request, in this order:

1. **Ticket.** Open a GitHub issue in this repo (none is needed when an open one covers the
   request).
   - The body holds only:
     - a first section: Goal for a feature, Problem for a bug, with no sub-label inside it
       (a Goal is one "make X so that Y" sentence, then the why as bullets; a Problem is what
       is wrong and why it matters);
     - Acceptance criteria, as a checkbox list (`- [ ]`);
     - Examples and Out of scope, where they help;
     - Coordinates with (linking related issues).
   - The body never holds the approach.
   - Link wherever you can, in the body, the Plan comment and Revisions alike: issues and
     PRs (with a few words on what they are or why), the comments a decision came from,
     source files (blob links) and repos.
   - Put anything copied, run or read verbatim in a fenced code block with a language (`sh`,
     `json`, `text`), in the body and the Plan comment alike: commands, error and log
     messages, commit messages, config snippets, file trees. Names and paths inside a
     sentence stay inline code.
   - Once the plan exists (step 2), edit "The plan, with its revisions, is in
     [the Plan comment](URL)" into that first section.
   - An existing issue whose body holds the approach, or that has no Plan comment:
     - Move the approach into a Plan comment.
     - Rewrite the body as the Goal (Problem for a bug), Acceptance criteria (checkboxes) and
       Out of scope: old Problem becomes Goal; old What to add and Scope become criteria and
       out of scope.
     - Add a Revisions row ("**Restructured.** Approach moved from the body into this plan").
     - Don't paste the old body anywhere (GitHub keeps its edit history).
     - The owner asked for this structure: edit the body without asking.
2. **Plan.** Put the plan in ONE comment on the issue, titled "Plan (current)", edited in
   place, so it always holds the latest plan.
   - Write for a reader who only reads the top:
     - the top stands alone and lines are short;
     - bullets, numbered steps, checkbox lists and tables beat paragraphs, in the issue body
       (Goal, Examples, Out of scope, Coordinates too) as much as here.
   - `.github/ISSUE_TEMPLATE/feature.md` in jbhirsh/ci has the layout to copy. Keep its
     Status line in step with these steps.
   - Its Revisions table (What changed, Why, Who suggested it) has one row for each change:
     - Newest first, with no numbers.
     - "What changed" opens with a short bold title, then the change (a numbered list when
       several).
     - The last column says who (the owner, a review agent, or you) and states the question
       asked or the decision in plain words, never a bare quote ("You, asked whether X:
       yes"); quote them only when the quote stands alone, and link the source.
   - Earlier plan and review comments:
     - Fold what is still true into the plan, and note any decision one carried in a
       Revisions row.
     - Collapse one under a `Superseded` note that links the Plan comment (inside
       `<details>`, text unchanged, blank lines around its Markdown so tables still render)
       only when it holds something the plan lacks.
     - Never delete one (jbhirsh/ci#109 is the example).
   - A change anyone will see (a new or changed screen, page, or state of one) gets mockups
     of each screen and state it touches:
     - Phone size first where the app is phone first, then each wider size it looks different
       at, in both themes where the app has two.
     - Made from the app's own styles and components, so they show what will ship rather
       than a sketch: a throwaway build of the screen, never committed.
     - Where the app has a mockup run, run it (its `CLAUDE.md` gives the command, with
       `mockup_patch` and `mockup_issue`): visual review writes the before/after table into
       the issue's body (that table and the pictures route's `<!-- pictures:<block> -->` one
       are the only additions the body allows), and the Plan comment links it.
     - Where it has none, take the screenshots yourself and attach them with the pictures
       route ("Claude attaches every picture", below).
3. **Plan review.** Spawn a reviewer agent on the plan, briefed with the issue, its Plan
   comment (link) and its mockups, and these rules but not your reasoning, so its read is
   independent. Record its findings only as Revisions rows, the ones you reject too, with the
   reason, and a clean review too ("review: no findings"): no separate comment for a review.
   An owner's answer to a question is a Revisions row as well (the question and the
   decision).
4. **Approval.** Show the user the Plan comment's link (and the Revisions rows for the review)
   with its mockups, and wait for their approval of both before writing code.
5. **Implement** against the approved plan, ticking each acceptance criterion as it is met.
   If the plan or its mockups change, edit the Plan comment, add a Revisions row, and tell the
   user. A PR that is one of several leaves the issue open: tick what it meets, and set the
   Status to implemented when every criterion is ticked.

Bug fixes and chores skip the ticket and the plan. Every PR still gets the review below.

## Before opening a PR

- **Describe the PR from the repo's own `.github/pull_request_template.md`**, which
  jbhirsh/ci's sync keeps equal to the shared template there. `gh pr create --body` doesn't
  apply the template: read it and fill it in. A bug fix renames Goal to
  Problem and Plan to Solution, as the template says. Write every section as bullets,
  numbered steps, checkboxes or a table, linking every issue, PR, comment and file it
  mentions, with a fenced code block for any command or message: a paragraph is two
  sentences at most. Findings from your own review
  before the PR go to the owner in the chat, never in the description. When you edit the
  description later, keep its empty marker pairs (`pr-changes:change`, `pr-changes:revisions`,
  `pr-gif`) and the `pr-changes:index` block: the tools fill only inside them, and a
  description rewritten without them gets no table.
- **After every push, wait for `PR changes`, then write that push's Revisions rows.** A
  push adds a revision to the description's Revisions block (`pr-changes/revisions.mjs`'s
  header has the grammar).
  - Wait for the PR's `PR changes` run to end, then fill the current revision's table: one
    row for each change, in plain words and never a commit's subject. A rebase is a change
    too: say what it brought in.
  - Re-read the live description once. A run your push started can write an older copy over
    your edit; redo your rows if it did.
    ```sh
    gh run watch <id> --exit-status
    ```
  - An agent you brief to push is told all of this in its brief.
- **A bug someone can see gets a photo, before and after.** When the Problem's Example is
  something on a screen or in a rendered page (a blank card, a misplaced control, a
  description that shows plain text where pictures belong), the Example carries a picture of
  the bug as it is on `main`, and the Solution one of it fixed. Take them from the app's own
  visual review or a screenshot of the real page (for anything GitHub renders, GitHub's own
  page, signed out), never a sketch.
- **Claude attaches every picture**, in an issue or a PR alike:
  - through the app's own tools where they make it: visual review, PR GIFs, or
    `pictures/attach` from a CI run;
  - through the pictures route for one the session took itself: jbhirsh/ci `CONTRIBUTING.md`,
    "Pictures from a session", gives the commands, and the host PR to pass while
    `PICTURES_HOST_PR` is unset.
  - A picture is never left to the owner as a task, a file name or an apology, and a
    description never says one is missing or not attached. Where one truly can't be made, the
    description says in words what it shows, and nothing else.
- **A change that moves something needs a GIF**: a transition, a sheet or dialog opening or
  closing, a drag, swipe or scroll, a multi-step flow. Commit a GIF scenario for it where the
  repo's CONTRIBUTING says, so PR GIFs records it, and put an empty `pr-gif:<scenario>` marker
  pair under the change in the description for the GIFs to fill. Stills alone don't show motion.
- **Review the full diff first.** Once the local checks pass, spawn a code review agent on
  the diff, briefed with the issue (if any) and these rules rather than your conclusions,
  and fix what it finds. Then open the PR: review gates PR creation, rather than following
  it. The PR says `Closes #<issue>` when it finishes the issue, `Part of #<issue>` when it is
  one of several.

## Issues

- **Issues are the source of truth.** Check `gh issue list` (and `gh issue view <n> --comments`,
  which shows the Plan comment, and the issues it references) before designing or
  implementing a feature: issues carry rationale the code doesn't.

## Commits

- **An imperative subject, a body saying why, and the `Co-Authored-By:` trailer.** One
  logical change per commit. Amend or squash your own branch freely before it merges, but
  never amend, rebase or force-push `main`.
- **A branch holds only its final design.** When the design changes or a commit needs a fix,
  rework the earlier commits rather than adding a revert or a fix on top, so each commit is
  one change the PR keeps. Never leave tried-and-dropped work for a squash merge to hide.

## Never

- `git add -A` or `git add .`: stage files by name.
- Change a test to make it pass: fix the implementation.
- Turn on a PR's auto-merge: GitHub records it as the owner's, and the owner turning it on is
  how a changed screen is accepted (`Visual changes`, jbhirsh/ci#64). The owner merges.
  - The one exception, by the owner's decision (jbhirsh/ci#109): jbhirsh/ci's sync turns it on
    for its own `bot/sync-files` PR in each app, bound to the head it checked. That PR holds
    only files jbhirsh/ci has merged, byte for byte, and the app's required checks still gate
    it, `Visual changes` included, which holds it if a screen changed. The sync's `auto-merge`
    input turns it off. Even there, you never turn it on.
- Install packages outside the project root.

## Code

- **Validate only at boundaries.** Check untrusted input where it enters (an API handler or
  response, a URL or form value, an environment variable, stored data) and trust it after
  that. Don't add defensive checks for states the code itself can't produce: they hide real
  bugs.
- **Fix weekly-audit findings rather than suppressing them**, where the repo runs the weekly
  audit. knip and jscpd are expected to report nothing: an unused export goes, a real
  duplicate becomes a shared helper, and a deliberate jscpd exception says why beside its
  ignore entry or marker.

## Tests

- **A flaky test is a bug.** Find why it fails and fix that, in the test or the code,
  whichever is wrong. Never re-run CI or add a retry to get past it.
- **Property tests for pure helpers taking outside input.** Input a person, a link, the
  browser or an API hands over is generated by the hundred (fast-check, in
  `*.property.test.*` beside the example tests), and the test states what must hold for all
  of it: never throws, reads back what it wrote, stays in range. A failure prints its seed
  and smallest counterexample; fix the code, or the property if it claimed too much.

## CI

- **Shared CI tooling lives in jbhirsh/ci.** The apps' workflows call its tools at `@main`
  and keep their own triggers and job names (the required checks); an app's settings for
  each tool are its key in `.github/ci.json`, and how a tool works is in its headers. Change
  a tool in jbhirsh/ci, never by copying it into an app, and a file the apps hold in step
  (jbhirsh/ci's `sync/manifest.json`) there too: the next sync reverts an app's edit.
- **A required workflow has no trigger-level `paths:` filter.** A filtered-out workflow
  never reports, so its required check waits forever. Decide inside the job and skip the
  expensive step: a skipped step or job still passes.
- **One-off scripts and workflows never go on `main`.** A migration, backfill or cleanup
  that runs once runs from its own branch. A workflow there uses an `on: push` trigger
  filtered to that branch, since `workflow_dispatch` only works once the file is on the
  default branch. Record what it did and its result in the issue, then close any PR for it
  unmerged and delete the branch. `main` holds only what keeps being used.
- **No fixed-time waits.** CI, scripts and tests never pause for a duration we picked so
  that something else can happen: no `sleep N`, no `waitForTimeout`, no `setTimeout`
  promise delay, no polling every N seconds up to a deadline, no settle or quiet period
  (including a framework settle that always runs to its limit), no retry after a pause, no
  rate-limit pacing (a fixed delay between requests, or sleeping out a `Retry-After`), and
  no retrying a failed test in CI, such as Playwright's `retries` (a flaky test is a bug).
  Each is a guess: too short makes a flaky check, too long holds a runner, and either can
  hide a real bug. Instead:
  - **React to the event**: a workflow trigger (`deployment_status`, `workflow_run`,
    `check_suite`) or `needs:`.
  - **Use a call that returns when the thing happens**: a process's exit, a server's own
    "listening" line, a log stream read until the line, `simctl bootstatus -b`.
  - **Use the test framework's condition wait on the end state**, which returns as soon as
    it holds: Playwright's web-first assertions and `waitFor`, `expect.poll`,
    `toHaveScreenshot`'s stability check, Maestro's `extendedWaitUntil`, XCTest's
    `waitForExistence`.
  - **Or refuse and name it**: if a prerequisite isn't ready, fail at once, saying what's
    missing and what to do.

  Allowed, as they wait for nothing:
  - a timeout that only ends a hang and is never the success path: a job's or step's
    `timeout-minutes`, a request's timeout, the `timeout` command, a condition wait's own
    failure limit;
  - one immediate retry, with no pause, when a third party fails for a moment (a 429 or
    503, a service unreachable while a step sets up, a test driver that dies under a
    run), never for our own code or a test's own failure;
  - `setTimeout(…, 0)` in a unit test, a yield to the next turn rather than a wait;
  - a pause in a GIF scenario that holds a frame for whoever watches.

  A unit test never sleeps for real: it uses fake timers, or waits for the outcome.

- **Adding or renaming a required job means updating the branch rule.** The rule requires
  checks by job name, so a renamed job is no longer required, and a new one isn't until the
  rule names it; meanwhile bots' PRs auto-merge without it. Update the rule in the same PR.

## Docs

Put each line where the person who needs it reads it, when they need it:

| Place                                                                         | For                                     | Holds                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nowhere                                                                       |                                         | What a check fails on. Its failure message says how to fix it; if it doesn't, fix the message.                                                                                            |
| The code: a module's header, a function's JSDoc, a config or workflow comment | Whoever edits that file                 | What it does, why, and its traps. Change it with the code.                                                                                                                                |
| `README.md`                                                                   | Visitors                                | What the project is, its main technologies and what each gives it, the main parts of its architecture                                                                                     |
| `CONTRIBUTING.md`                                                             | People working on it                    | Installing, running, testing and deploying; one-time setup (secrets, GitHub settings, Pages); the required checks                                                                         |
| `CLAUDE.md`                                                                   | Every Claude session, so it stays short | Commands that aren't obvious, traps that cross files, rules no tool enforces, and pointers only where names don't tell. No file-by-file map: folder names and module headers are the map. |
| These shared rules                                                            | Every Claude session in every repo      | What `CLAUDE.md` would say in every repo                                                                                                                                                  |

None of them repeats another.
