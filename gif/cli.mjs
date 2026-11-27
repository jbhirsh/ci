// The GIF tool's command line, as the apps run it: their `npm run gif`
// (scripts/gif.mjs in BoardGames and fog-and-frontier, scripts/pr-gifs.ts
// in sift) clones this repo beside the app as ../ci and runs
//
//   node ../ci/gif/cli.mjs <scenario> [options]
//
// cli.ts says what it does; this only calls its main and turns a failure
// into a message and exit code 1. It stays .mjs, where the rest of this
// repo is TypeScript (ci#155), because the apps name this path: renaming it
// would break their command until each app changed. Node strips cli.ts's
// types as it loads it, so a Node below 22.18 fails here.

import { main } from './cli.ts';

main(process.argv.slice(2)).catch((/** @type {unknown} */ error) => {
  console.error(error instanceof Error ? error.message : error);
  if (error instanceof Error && error.cause instanceof Error) console.error(error.cause.message);
  process.exitCode = 1;
});
