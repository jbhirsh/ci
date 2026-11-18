## Goal

A PR that moves something gets its before/after GIFs without the author recording or hosting anything: it adds or changes a scenario in `scripts/gif-scenarios/` and pushes.

**This PR:** fog-and-frontier's adoption of jbhirsh/ci's automatic PR GIFs, the GIF parts of fog#343 only. Part of jbhirsh/ci#92.

## Plan

| Step  | Where                                                            | What                                                      | State                                                              |
| ----- | ---------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| 1     | [ci#94](https://github.com/jbhirsh/ci/pull/94)                   | The canonical callers and the rules every copy is held to | ✅ merged ([#94](https://github.com/jbhirsh/ci/pull/94))           |
| 2     | [BoardGames#340](https://github.com/jbhirsh/BoardGames/pull/340) | BoardGames' copy                                          | ✅ merged ([#340](https://github.com/jbhirsh/BoardGames/pull/340)) |
| **3** | **this PR**                                                      | **fog-and-frontier's copy**                               | **👉 this PR**                                                     |

> ⚠️ **Before this merges**
>
> `BOT_PR_TOKEN` is already documented here (Contents, Pull requests and Issues write); nothing new to set. Nothing attaches on this PR itself: `workflow_run` runs only main's copy, and main has no `pr-gif-attach.yml` yet, so the by-hand check is a test PR after this merges.

> ℹ️ **Not in this PR**
>
> The PR template and `visuals.advice` still describe the old `screenshots`-branch route; jbhirsh/ci#79's shared template replaces them in fog's adoption PR for it, so they aren't edited twice. The scenario changes in fog#343 (a `PublicKeyCredential` shim in `phone.ts`, used by `sign-in.ts` and `account-menu.ts`) stay with that PR: until they land, those two scenarios can fail in Actions when a PR changes them, and nothing else is affected. fog#343 itself is left to its own session.

## Changes

### 1. fog-and-frontier records and attaches a PR's GIFs on its own

`.github/workflows/pr-gif.yml` records each scenario the PR changes, built for production as the GIF tool does locally, with no secret (and by hand, with the token only on `workflow_dispatch`); `pr-gif-attach.yml`, woken by `workflow_run` from main's copy, attaches them with `BOT_PR_TOKEN`, so the token is never in a run holding the PR's code. Both are the files fog#343 carries, and pass jbhirsh/ci's rules for them. `gif.build.env` gets the stand-in Apple client id the sign-in scenarios need. `autofix.exempt` gets "PR GIFs"; `CONTRIBUTING.md` says where GIFs now come from and that attaching needs the person's token.

<!-- pr-changes:change:1 -->

[`7fb4948`](https://github.com/jbhirsh/fog-and-frontier/commit/7fb4948) Record and attach a PR's GIFs on its own when it changes a scenario

<details><summary>4 files changed +104 −4</summary>

```diff
+ 104 added
- 4 removed
```

- [`.github/ci.json`](https://github.com/jbhirsh/fog-and-frontier/pull/365/files#diff-13e9ba853b2cefc45947027a800333c9772ce29e1e7ac02eb001fd27135b27f8) +4 −2
- [`.github/workflows/pr-gif-attach.yml`](https://github.com/jbhirsh/fog-and-frontier/pull/365/files#diff-09806ef32b284ce1a268007f75a5904d6e33f6191234c067a5902b3e2be0e9b9) +32 −0
- [`.github/workflows/pr-gif.yml`](https://github.com/jbhirsh/fog-and-frontier/pull/365/files#diff-b4d0b06fb84121074374f16d8e7f051d47644524974f1d68b14d8cf209b04ab1) +65 −0
- [`CONTRIBUTING.md`](https://github.com/jbhirsh/fog-and-frontier/pull/365/files#diff-eca12c0a30e25b4b46522ebf89465a03ba72a03f540796c979137931d8f92055) +3 −2

</details>
<!-- /pr-changes:change:1 -->

## Checklist

- [x] Independent review run on the diff; its findings are fixed or listed above
- [ ] **You:** after merging, open a test PR that changes a scenario and check the GIFs attach (it needs `BOT_PR_TOKEN`)

## Revisions

<!-- pr-changes:revisions -->

| Rev | Head                                                                    | What changed | Why                                                                                                   |
| --- | ----------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| 1   | [`7fb4948`](https://github.com/jbhirsh/fog-and-frontier/commit/7fb4948) | Opened       | A PR that moves something gets its before/after GIFs without the author recording or hosting anything |

<!-- /pr-changes:revisions -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_019ECXoiXXuwAJAQmvNhK1D2
