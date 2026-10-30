// Samples the machine's CPU for the rest of the job (job-summary/sample-load's
// action.yml, a job's first step): a row of `time,load,busy` every SAMPLE_MS
// into RUNNER_TEMP/job-summary/machine-cpu.csv (telemetry.mjs), which
// job-summary charts across the job when its own `load` input is empty.
//
// `start` writes the header and starts the sampler, detached, with nothing
// of the step's output held open, so the step returns at once; the runner
// kills it with the job's other leftover processes as the job ends (it finds
// them by the RUNNER_TRACKING_ID they inherit). On Linux each row reads
// /proc/loadavg and /proc/stat, elsewhere (macOS) os.loadavg() and
// os.cpus(); a row's busy is the share of the CPU's time since the last row
// that wasn't idle. A row that can't be read or written is skipped.
//
// It never fails the job: a sampler that won't start is a warning.
//
//   node sample-load.mjs          start the sampler (env: RUNNER_TEMP)
//   node sample-load.mjs --loop <file>   the sampler itself

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LOAD_HEADER,
  SAMPLE_MS,
  busyPercent,
  cpusTimes,
  loadRow,
  parseLoadavg,
  parseProcStat,
  telemetryFiles,
} from './telemetry.mjs';

/** @typedef {import('./telemetry.mjs').CpuTimes} CpuTimes */

/**
 * The machine's load average and CPU times now, or null when they can't be
 * read.
 *
 * @param {string} [platform]
 * @param {(file: string) => string} [read]
 * @returns {{ load: number, cpu: CpuTimes } | null}
 */
export function reading(platform = process.platform, read = (f) => readFileSync(f, 'utf8')) {
  try {
    if (platform === 'linux') {
      const load = parseLoadavg(read('/proc/loadavg'));
      const cpu = parseProcStat(read('/proc/stat'));
      return load === null || cpu === null ? null : { load, cpu };
    }
    return { load: os.loadavg()[0], cpu: cpusTimes(os.cpus()) };
  } catch {
    return null;
  }
}

/**
 * The next row, from the reading before it and the one now; null when
 * either is missing or no time passed.
 *
 * @param {{ load: number, cpu: CpuTimes } | null} before
 * @param {{ load: number, cpu: CpuTimes } | null} now
 * @param {number} ms the time now
 */
export function nextRow(before, now, ms) {
  if (!before || !now) return null;
  const busy = busyPercent(before.cpu, now.cpu);
  return busy === null ? null : loadRow(ms, now.load, busy);
}

/**
 * The sampler: a row every SAMPLE_MS, until the runner ends it.
 *
 * @param {string} file
 * @param {() => ({ load: number, cpu: CpuTimes } | null)} [read]
 * @param {(fn: () => void, ms: number) => unknown} [later]
 * @param {() => number} [clock]
 */
export function loop(file, read = reading, later = setTimeout, clock = Date.now) {
  let before = read();
  const tick = () => {
    const now = read();
    const row = nextRow(before, now, clock());
    if (row) {
      try {
        appendFileSync(file, `${row}\n`);
      } catch {
        // A row that can't be written is skipped.
      }
    }
    before = now ?? before;
    later(tick, SAMPLE_MS);
  };
  later(tick, SAMPLE_MS);
}

/**
 * Spawns a process: child_process.spawn, or a stand-in in a test.
 *
 * @callback Spawn
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} options
 * @returns {{ on: (event: 'error', listener: () => void) => unknown, unref: () => void }}
 */

/**
 * Starts the sampler, unless this job's already has (its file is there).
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {Spawn} [run]
 * @returns {string} what it did
 */
export function start(env = process.env, run = spawn) {
  try {
    const files = telemetryFiles(env);
    if (!files) return '::warning::job-summary/sample-load: RUNNER_TEMP is not set';
    if (existsSync(files.load)) return `Already sampling into ${files.load}`;
    mkdirSync(files.dir, { recursive: true });
    writeFileSync(files.load, `${LOAD_HEADER}\n`);
    const child = run(process.execPath, [fileURLToPath(import.meta.url), '--loop', files.load], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
    return `Sampling the machine's CPU every ${SAMPLE_MS / 1000} s into ${files.load}`;
  } catch (error) {
    return `::warning::job-summary/sample-load: ${error instanceof Error ? error.message : error}`;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--loop') loop(process.argv[3]);
  else console.log(start());
}
