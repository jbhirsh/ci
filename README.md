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

| Directory | What                                                                               |
| --------- | ---------------------------------------------------------------------------------- |
| `lib/`    | what every tool shares: the app's checkout, packages and settings; Actions outputs |
