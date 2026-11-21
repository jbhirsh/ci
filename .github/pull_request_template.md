## Goal

<!--
Write every section of this description as bullets and sub-bullets, not
paragraphs: numbered steps where order matters, checkboxes for what the owner
does, a table where it compares things, a hyperlink for every issue, PR,
comment and source file it mentions, and a fenced code block (with a language)
for any command, message or snippet. A paragraph is two sentences at most.

The goal as a few short bullets: what this gives whom.

For one step of a plan across PRs, add a second bullet: "**This PR:**", this
step's own goal and why, ending "Closes #N", or "Part of #N" when the issue is
bigger than this PR. Otherwise end the last bullet with "Closes #N" when there
is an issue. Say it here only: the plan below doesn't repeat it. Delete this
comment's advice with the text it was for.

For a bug fix, rename this heading "Problem": bullets for what is wrong, who
sees it and what causes it, the last ending "Closes #N" when there is an issue.

A bug fix or a change in behaviour (not a cosmetic change, a rename, a chore or a
bot's PR) also gets an Example: the simplest case that shows it, in code, as long
as it needs and no longer. Write it here as a bold "**Example**" paragraph, or, in
a PR with several changes, under the change it belongs to; never as a heading.
Use made-up code where the real code is long, a diff block where lines change
(GitHub colours it), and input and output for a call that now returns something
else. When the bug is something someone sees (a screen, a rendered page), add a picture of
it as it is on main, and in the Solution one of it fixed. This one, for the PR that fixed a
mutation check, shows the shape:

**Example**

**In one line:** a PR that only added a comment was scored on code it never touched.

Main's file, where a mutant survived on line 2:

```tsx
1  export function Icon() {
2    return <svg style={{ overflow: 'visible' }} />;   // survived here
3  }
```

The PR adds a two-line comment above it and changes nothing else:

```diff
+ 1  /** The rules icon. */
+ 2  /** Drawn at 24px. */
  3  export function Icon() {
  4    return <svg style={{ overflow: 'visible' }} />;   // same code, now line 4
  5  }
```

What happened, in order:

1. The PR's changed lines are 1-2.
2. Main's result is stored as "line 2", inside 1-2, so it was kept.
3. It then moved to line 4, outside the changed lines, and still counted.

**What it does now:** a stored line number is trusted only if the file reads the
same from line 1 down to it.

_Real case: BoardGames#343, the unchanged svg moved from line 83 to line 90._
-->

## Plan

<!--
Only for a step of a plan: a table with this PR's row in bold and earlier steps
linked. A State is one of: "✅ merged (#N)", "👉 this PR",
"next (#N)", "later". For a single-feature PR delete this heading and the table, but keep the
comment below.

The table is HTML, so that GitHub shades only this PR's row: it shades the
even rows of each <tbody>, so each step is a <tbody> of its own, and only this
PR's starts with an empty <tr></tr>. Cells take HTML, not Markdown (<a href>,
<b>, <code>). Every other step is a plain row, like
<tbody><tr><td>1</td><td><a href="…/pull/12">#12</a></td><td>…</td><td>✅ merged (#12)</td></tr></tbody>

For a bug fix, rename this heading "Solution" and replace what is below with
bullets: what the fix does and why it removes the cause.
-->

<table>
<thead><tr><th>Step</th><th>Where</th><th>What</th><th>State</th></tr></thead>
<tbody><tr></tr><tr><td><b>1</b></td><td><b>this PR</b></td><td><b></b></td><td><b>👉 this PR</b></td></tr></tbody>
</table>

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
write each change's commit and files (a dropdown of the linked files; the title
and every file's counts are small green and red pictures) and the Revisions
table: there is no totals line, as the PR's own header has the totals. -->
<!-- describe:visual-review -->
<!-- /describe:visual-review -->

<!--
One empty marker pair per change, numbered from 1 and in the order of the commits:
`pr-changes:change:N` for the Nth change, written as the markers above are. The
changes tool writes the change's title (its number, its commit's subject and a
link to the commit) and its files there; you write only why, as bullets (or
numbered steps) under the pair, with sub-bullets for detail, links, and a fenced
block for a command or a message. There is no heading to write for a change.
Visual review's screens go under the change that made them: add a pair
`describe:visual-review:<screen>` for each screen (the screen's name in the
table), written as the markers above are.

Does the change move something: a transition, a sheet or dialog opening or
closing, a drag, swipe or scroll, a multi-step flow? Then it needs a GIF, which
a still can't show. Commit a GIF scenario for it (the repo's CONTRIBUTING says
where and how); PR GIFs records it before and after and attaches it to this
description. Put an empty `pr-gif:<scenario>` marker pair, written as the
markers above are, under the change it belongs to, and the GIFs fill it in
place; without one they are added at the very end. `<scenario>` is the
scenario's own name (the `name` it exports, else its file's name without the
extension).

In a PR with several changes, a change that fixes a bug or changes behaviour takes
its own bold "**Example**" paragraph under its pair, as the one under Goal does.
-->

<!-- pr-changes:change:1 -->
<!-- /pr-changes:change:1 -->

- Why this change.

## Checklist

<!--
Only what CI doesn't show: "- [x] done" for what you did, and, for anything the
owner has to do, an open box that starts "**You:**". Keep the heading: the
description check needs it. Write "Nothing to do." when there is nothing to list.
-->

<!--
Revisions: leave the markers below empty. Once the PR has a revision (a push
after it opened, or a force-push), the changes tool writes the "## Revisions"
heading and, for each revision, newest first, a collapsible block: its summary
(the head, the current one bold with a pointer; a compare link; and a note such
as "rewritten from … (2 commits dropped)" or "Opened") and under it a table of
two columns, "What changed" and "Why", with one empty row. The newest revision is
open and the older ones are closed. Fill the table in the description, one row
for each change, in plain words: what changed and why (not the commit's subject,
as a commit may be reworked into another). The tool keeps every row you write. A
row has two cells: write a pipe inside a cell as \|, as GitHub drops any cell
after the second.
-->

<!-- pr-changes:revisions -->
<!-- /pr-changes:revisions -->
