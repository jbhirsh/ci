// Adds a job's notes for its summary (job-summary/note's action.yml): the
// `Label: value` lines in NOTES, merged into RUNNER_TEMP/job-summary/notes.json
// (telemetry.mjs), which job-summary shows in its report's Environment when
// its own `notes` input is empty. The job's first note also says what the
// machine is: the runner image, its cores, memory and Node. A label noted
// again takes its new value.
//
// It never fails the job: a note it can't write is a warning.
//
//   node note.mjs   (env: NOTES, RUNNER_TEMP)

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { machineNotes, mergeNotes, parseNoteLines, telemetryFiles } from './telemetry.mjs';

/**
 * The machine's cores, memory and Node, from this process.
 *
 * @returns {{ cores: number, memory: number, node: string }}
 */
export function thisMachine() {
  return { cores: os.availableParallelism(), memory: os.totalmem(), node: process.version };
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {() => { cores: number, memory: number, node: string }} [machine]
 * @returns {string[]} what it said, for a test
 */
export function main(env = process.env, machine = thisMachine) {
  /** @type {string[]} */
  const said = [];
  const say = (/** @type {string} */ line) => {
    said.push(line);
    console.log(line);
  };
  try {
    const files = telemetryFiles(env);
    if (!files) {
      say('::warning::job-summary/note: RUNNER_TEMP is not set, so there is nowhere to note');
      return said;
    }
    const { notes, skipped } = parseNoteLines(env.NOTES ?? '');
    for (const line of skipped) {
      say(`::warning::job-summary/note: "${line}" isn't a "Label: value" line; left out`);
    }
    const first = !existsSync(files.notes);
    const all = first ? [...machineNotes(env, machine()), ...notes] : notes;
    mkdirSync(files.dir, { recursive: true });
    const tmp = `${files.notes}.tmp`;
    writeFileSync(tmp, mergeNotes(first ? null : readFileSync(files.notes, 'utf8'), all));
    renameSync(tmp, files.notes);
    say(`Noted ${all.map(([label]) => label).join(', ') || 'nothing'} in ${files.notes}`);
  } catch (error) {
    say(`::warning::job-summary/note: ${error instanceof Error ? error.message : error}`);
  }
  return said;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
