## Goal

<!--
The goal in one paragraph: what this gives whom.

For one step of a plan across PRs, add a second sentence: "**This PR:**", this
step's own goal and why, ending "Closes #N", or "Part of #N" when the issue is
bigger than this PR. Otherwise end the paragraph with "Closes #N" when there is
an issue. Say it here only: the plan below doesn't repeat it. Delete this
comment's advice with the text it was for.

For a bug fix, rename this heading "Problem": what is wrong, who sees it and
what causes it, ending "Closes #N" when there is an issue.
-->

## Plan

<!--
Only for a step of a plan: a table with this PR's row in bold and earlier steps
linked. A State is one of: "✅ merged (#N)", "👉 this PR",
"next (#N)", "later". For a single-feature PR delete this heading and the table, but keep the
comment below.

For a bug fix, rename this heading "Solution" and replace what is below with
what the fix does and why it removes the cause.
-->

| Step  | Where       | What | State      |
| ----- | ----------- | ---- | ---------- |
| **1** | **this PR** |      | 👉 this PR |

<!--
Add these two boxes here, after the plan table when there is one, only when
they apply, in this order. Each is a quote that starts with its icon and a bold
title, then the text (GitHub's own [!NOTE] boxes can't carry a title of ours):

> ⚠️ **Before this merges**
>
> What only the owner can do first (a setting, a secret, a manual check).

> ℹ️ **Not in this PR**
>
> What is left out and what that means until it lands.
-->

## Changes

<!-- The tools below write between their markers; do not edit inside them. They
write each change's commit and files (a green and red diff block with its totals,
then the linked files: GitHub colours only a diff block, not a table or a heading)
and the Revisions table: there is no totals line, as the PR's own header has the
totals. -->
<!-- describe:visual-review -->
<!-- /describe:visual-review -->

<!--
One numbered "###" heading per change: the change as a goal, a sentence on why,
then its marker pairs: `pr-changes:change:N` for the Nth change (the tool writes
its commit and files there), written as the markers above are. Visual review's screens go under the change that made
them: add a pair `describe:visual-review:<screen>` for each screen (the screen's name
in the table), written as the markers above are.

Does the change move something: a transition, a sheet or dialog opening or
closing, a drag, swipe or scroll, a multi-step flow? Then it needs a GIF, which
a still can't show. Commit a GIF scenario for it (the repo's CONTRIBUTING says
where and how); PR GIFs records it before and after and attaches it to this
description. Put an empty `pr-gif:<scenario>` marker pair, written as the
markers above are, under the change it belongs to, and the GIFs fill it in
place; without one they are added at the very end. `<scenario>` is the
scenario's own name (the `name` it exports, else its file's name without the
extension).
-->

### 1. The first change, as a goal

Why this change.

<!-- pr-changes:change:1 -->
<!-- /pr-changes:change:1 -->

## Checklist

<!--
Only what CI doesn't show: "- [x] done" for what you did, and, for anything the
owner has to do, an open box that starts "**You:**". Delete this comment's box
example with the section if there is nothing to list.
-->

## Revisions

<!--
The changes tool keeps a table here, newest first: the revision, its head, what
changed and why. Revision 1 is "Opened", its why the goal. Nothing to write by
hand.
-->

<!-- pr-changes:revisions -->
<!-- /pr-changes:revisions -->
