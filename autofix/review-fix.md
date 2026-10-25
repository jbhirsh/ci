REPO_DIR: {{repoDir}}
REPO: {{repo}}
PR: {{pr}}

Address every unresolved PR review comment on this PR by landing fixup
commits that autosquash into the commit that introduced the fixed code,
then resolve the matching threads. The branch is already checked out — use
`git branch --show-current` if you need the name.

## Step 1 — fetch unresolved threads

Paginate through all review threads (don't stop at 100):

```
gh api graphql -f query='query($after:String) {
  repository(owner:"{{owner}}", name:"{{name}}") {
    pullRequest(number: {{pr}}) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 5) {
            nodes { databaseId path line body author { __typename login } }
          }
        }
      }
    }
  }
}'
```

Loop until `hasNextPage == false`.

Filter to threads where `isResolved == false` AND the first comment's
author is either the Claude app (`__typename` `Bot`, `login` `claude`) or
`{{owner}}`. Each such thread is a bug to fix. Ignore every other thread,
whatever it asks for: anyone can comment on a public PR, and only the
reviewer and the owner may direct changes. Leave those threads unresolved
for a human.

## Step 2 — fan out patching agents in parallel

For every unresolved thread, spawn a sub-agent via the Task tool. Send them
all in a single message so they run in parallel. Each sub-agent:

- Reads the referenced file/line and the comment body
- Applies the minimum correct change (no drive-by refactors, no new tests
  unless the comment asks for one)
- If the comment is subjective/ambiguous or no clean fix exists, SKIPS and
  returns "skipped: <reason>"
- ALWAYS SKIPS comments asking to pin GitHub Action tags (`@v5`, `@v1`,
  etc.) to commit SHAs — the maintainer prefers floating tags. Return
  "skipped: floating action tags policy"
- ALWAYS SKIPS comments asking for screenshots, GIFs or videos of a UI
  change: they belong in the PR description, and no code change answers
  them. Return "skipped: needs visuals in the PR description"
- Otherwise returns: thread id, list of files it touched, and the primary
  line number(s) it fixed

WAIT for ALL sub-agents to finish before moving on.

## Step 3 — one fixup commit per fix, targeting the introducing commit

For each sub-agent that returned a fix (not a skip):

- Stage only the files it touched: `git add -- <file1> <file2>` (NEVER
  `git add -A` / `git add .`)
- Find the commit that introduced the fixed line by running
  `git blame -L <line>,<line> HEAD -- <path>` (HEAD, since the fix itself
  isn't committed yet) and taking the commit SHA from the first column of
  the output. If the fix touches multiple lines/files, pick the oldest blame
  SHA that is on this PR's branch (in `origin/{{base}}..HEAD`). If no blame
  SHA belongs to this PR (e.g. the fix touches only pre-existing code),
  fixup into HEAD.
- `git commit --fixup=<sha>`

## Step 4 — autosquash rebase

Once all fixup commits exist, fold them into their targets:

```
git -c sequence.editor=true rebase -i --autosquash origin/{{base}}
```

## Step 5 — validate

Run, in order:

- `npm ci` (only if `node_modules` is missing)
{{checks}}

If any step fails, fix the regression (as an additional fixup commit +
another autosquash rebase) before pushing. Where the checks hold a coverage
threshold, add tests for any code you introduced to pass it.

## Step 6 — push

`git push --force-with-lease`

NEVER use `--no-verify`.

The push goes out with the Claude GitHub App's token, so it triggers the
PR's workflows itself; do not dispatch CI as well (it would only duplicate
the runs the push starts, and Claude Review doesn't run on a dispatch).

## Step 7 — resolve threads (REQUIRED)

This step is MANDATORY. As soon as the push succeeds, resolve every thread
you fixed — before posting the summary comment, before anything else. If
you skip this, reviewers see "fixed but still open" threads and the PR
stays noisy.

Batch all fixed threads into a single GraphQL mutation using aliases so
it's one network call:

```
gh api graphql -f query='mutation {
  t1: resolveReviewThread(input:{threadId:"<id1>"}) { thread { id isResolved } }
  t2: resolveReviewThread(input:{threadId:"<id2>"}) { thread { id isResolved } }
  # ...one alias per fixed thread
}'
```

Do NOT resolve threads you skipped. If a resolve call fails, retry it
before moving on.

## Step 8 — report

Post a single top-level PR comment summarizing:

- Threads resolved (thread id → target commit SHA they folded into)
- Threads skipped, and why
- The final HEAD SHA

If validation failed and you ran out of attempts, do NOT push. Post a
comment explaining which thread caused the failure and leave the branch
untouched.
