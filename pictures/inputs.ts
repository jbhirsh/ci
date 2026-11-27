// pictures/attach's inputs, read from the environment the action sets
// (action.yml), where they enter: whoever dispatched the app's caller wrote
// them, so each is checked here and trusted after. A value that could do
// more than name what it names (an option, a path out of the artifact, a
// marker-ending `--`) is refused with a `pictures: …` message saying what it
// should be. The token comes in as GH_TOKEN, for gh alone: it is never read
// here, logged or parsed.
//
//   node pictures/inputs.ts   exits 1 with the first refusal: the action's
//                              first step, so a bad input (an unset
//                              PICTURES_HOST_PR) stops the job before it
//                              downloads anything

import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** One file to attach, as FILES names it. */
export type Picture = {
  /** relative to the artifact's folder, with `/` */
  path: string;
  /** its header and alt text in the table */
  caption: string;
};

export type Inputs = {
  /** owner/name */
  repo: string;
  /** the issue's or PR's number the table goes in */
  target: string;
  /** the PR whose description the files upload to */
  hostPr: string;
  /** the run whose artifact holds the files */
  runId: string;
  artifact: string;
  /** in the order the table shows them */
  files: Picture[];
  /** the marker's name, in the host's and the target's descriptions */
  block: string;
  /** the table's width in pictures */
  columns: number;
  /** each picture's, in pixels */
  width: number;
};

const NUMBER = /^[1-9]\d*$/;

/** A file's path in the artifact: plain names with `/` between (parseFiles refuses `.` and `..`). */
const PATH = /^[\w.-]+(?:\/[\w.-]+)*$/;

/**
 * A positive number given as `name`, as a string.
 */
function number(name: string, value: string | undefined, what: string) {
  const text = (value ?? '').trim();
  if (!NUMBER.test(text)) throw new Error(`pictures: ${name} is ${what}, not "${value ?? ''}"`);
  return text;
}

/**
 * A whole number from `min` to `max`, or `fallback` when empty.
 */
function within(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const text = (value ?? '').trim();
  if (text === '') return fallback;
  const n = NUMBER.test(text) ? Number(text) : NaN;
  if (!(n >= min && n <= max)) {
    throw new Error(`pictures: ${name} is a whole number from ${min} to ${max}, not "${value}"`);
  }
  return n;
}

/**
 * The block's name, as pr-gif's scenario names are: a word character, then
 * word characters, `.` or `-`, never `--`, which would end the marker's
 * HTML comment.
 */
export function parseBlock(value: string | undefined) {
  const name = (value ?? '').trim();
  if (!/^\w[\w.-]*$/.test(name) || name.includes('--')) {
    throw new Error(
      `pictures: BLOCK names the block (letters, digits, _, . and -, no --), not ${JSON.stringify(value ?? '')}`,
    );
  }
  return name;
}

/**
 * FILES: one picture a line, `path | caption`, the caption optional (the
 * file's name by default); blank lines are passed over. A path is relative
 * to the artifact's folder and stays in it: no leading `/`, no `..` anywhere,
 * no `.` segment, no NUL, only plain name characters (it goes into a Markdown
 * link, where a space or `)` would end it).
 */
export function parseFiles(value: string | undefined): Picture[] {
  const files: Picture[] = [];
  for (const line of (value ?? '').split(/\r\n|\r|\n/)) {
    if (line.trim() === '') continue;
    const bar = line.indexOf('|');
    const file = (bar === -1 ? line : line.slice(0, bar)).trim();
    const caption = bar === -1 ? '' : line.slice(bar + 1).trim();
    const segments = file.split('/');
    if (!PATH.test(file) || file.includes('..') || segments.includes('.')) {
      throw new Error(
        `pictures: ${JSON.stringify(file)} isn't a file's path in the artifact (relative, plain names, no . or ..)`,
      );
    }
    if (files.some((f) => f.path === file)) {
      throw new Error(`pictures: FILES names ${file} twice`);
    }
    files.push({ path: file, caption: caption || path.posix.basename(file) });
  }
  if (files.length === 0) throw new Error('pictures: FILES names no file to attach');
  return files;
}

/**
 * REPO: owner/name.
 */
export function parseRepo(value: string | undefined) {
  const repo = (value ?? '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`pictures: REPO is owner/name, not "${value ?? ''}"`);
  }
  return repo;
}

/**
 * Every input, from the environment.
 */
export function parseInputs(env: Record<string, string | undefined>): Inputs {
  const repo = parseRepo(env.REPO);
  const artifact = (env.ARTIFACT ?? '').trim();
  if (!/^\w[\w.-]*$/.test(artifact)) {
    throw new Error(`pictures: ARTIFACT is an artifact's name, not "${env.ARTIFACT ?? ''}"`);
  }
  return {
    repo,
    target: number('TARGET', env.TARGET, "the issue's or PR's number"),
    hostPr: number(
      'HOST_PR',
      env.HOST_PR,
      'the number of a PR whose description may be overwritten (sift: the PICTURES_HOST_PR variable)',
    ),
    runId: number('RUN_ID', env.RUN_ID, "the run's id"),
    artifact,
    files: parseFiles(env.FILES),
    block: parseBlock(env.BLOCK),
    columns: within('COLUMNS', env.COLUMNS, 2, 1, 4),
    width: within('WIDTH', env.WIDTH, 300, 1, 10_000),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    parseInputs(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
