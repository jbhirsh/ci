// What a job's steps leave for its summary to show, and where: its notes
// (labels and values, the report's Environment) and the machine's CPU across
// the job (the report's chart). job-summary/note writes the notes
// (note.ts) and job-summary/sample-load the CPU samples (sample-load.ts),
// each into RUNNER_TEMP/job-summary, which the runner empties at every job's
// start and end; job-summary reads them from there when its `notes` and
// `load` inputs are empty (summary.ts). This file holds where they go and
// the pure parts: reading `Label: value` lines, the machine's own notes, and
// a CPU sample's maths.
//
// Node's built-ins only: note.ts and sample-load.ts import it, and their
// actions run on the runner's own Node, with nothing installed.

import path from 'node:path';

/** How often the sampler writes a row, in milliseconds. */
export const SAMPLE_MS = 10_000;

/** The CSV's header, the columns summary.ts parseLoad reads. */
export const LOAD_HEADER = 'time,load,busy';

/** The machine's cores, memory (in bytes) and Node. */
export type Machine = { cores: number; memory: number; node: string };

/** A note: its label and its value. */
type Note = [string, string];

/**
 * Where a job's notes and CPU samples go, or null outside a runner (no
 * RUNNER_TEMP), where there's no job for them to describe.
 */
export function telemetryFiles(
  env: Record<string, string | undefined>,
): { dir: string; notes: string; load: string } | null {
  if (!env.RUNNER_TEMP) return null;
  const dir = path.join(env.RUNNER_TEMP, 'job-summary');
  return { dir, notes: path.join(dir, 'notes.json'), load: path.join(dir, 'machine-cpu.csv') };
}

/**
 * The notes in `Label: value` lines, one note a line: the label up to the
 * line's first colon, the value after it (colons and all), both trimmed. A
 * line with no colon or no label is skipped (and returned, to say so); a
 * blank one is left out.
 */
export function parseNoteLines(text: string): { notes: Note[]; skipped: string[] } {
  const notes: Note[] = [];
  const skipped: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    const label = colon < 0 ? '' : line.slice(0, colon).trim();
    if (label) notes.push([label, line.slice(colon + 1).trim()]);
    else if (line.trim()) skipped.push(line.trim());
  }
  return { notes, skipped };
}

/**
 * What the machine is, for a job's first note: the runner image (GitHub's
 * hosted runners set ImageOS and ImageVersion; a self-hosted one leaves them
 * out), its cores, its memory and the Node on the PATH.
 */
export function machineNotes(env: Record<string, string | undefined>, machine: Machine): Note[] {
  const image = [env.ImageOS, env.ImageVersion].filter(Boolean).join(' ');
  const notes: Note[] = image ? [['Runner image', image]] : [];
  notes.push(
    ['Cores', String(machine.cores)],
    ['Memory', `${Math.round(machine.memory / 2 ** 30)} GB`],
    ['Node', machine.node],
  );
  return notes;
}

/**
 * Notes as a JSON object, earlier ones kept and a label given again taking
 * its new value. Earlier notes that aren't a JSON object start afresh.
 *
 * @param earlier the file's text, null when there's none
 */
export function mergeNotes(earlier: string | null, notes: Note[]) {
  // A Map, so a label like __proto__ is a note like any other.
  const merged = new Map<string, string>();
  try {
    const data: unknown = JSON.parse(earlier ?? '{}');
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data)) merged.set(k, String(v));
    }
  } catch {
    // Not JSON: start afresh.
  }
  for (const [label, value] of notes) merged.set(label, value);
  return `${JSON.stringify(Object.fromEntries(merged), null, 2)}\n`;
}

/** The CPU's time so far, in ticks: all of it and the idle part. */
export type CpuTimes = { idle: number; total: number };

/**
 * The CPU's time from /proc/stat's first line, every core together:
 * `cpu  user nice system idle iowait irq softirq steal guest guest_nice`.
 * Idle counts iowait too (a core waiting on the disk is free for other
 * work); guest and guest_nice are left out of the total, as user and nice
 * already count them. Null when there's no such line.
 */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const ticks = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (ticks.length < 4 || !ticks.every((n) => Number.isFinite(n) && n >= 0)) return null;
  const [, , , idle, iowait = 0] = ticks;
  return { idle: idle + iowait, total: ticks.reduce((a, b) => a + b, 0) };
}

/**
 * The 1-minute load average from /proc/loadavg ("0.52 0.58 0.59 1/389
 * 12345"), null when it doesn't read as one.
 */
export function parseLoadavg(text: string) {
  const load = Number(text.trim().split(/\s+/)[0]);
  return text.trim() && Number.isFinite(load) && load >= 0 ? load : null;
}

/**
 * The CPU's time from os.cpus(), every core together (macOS, where there's
 * no /proc).
 */
export function cpusTimes(
  cpus: { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[],
): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/**
 * The % of the CPU busy between two readings, 100 × (1 − Δidle / Δtotal),
 * between 0 and 100; null when no time passed between them (or the counters
 * went back).
 */
export function busyPercent(before: CpuTimes, after: CpuTimes) {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (!(total > 0) || !Number.isFinite(idle)) return null;
  return Math.min(100, Math.max(0, 100 * (1 - idle / total)));
}

/**
 * One CSV row: `time,load,busy`, Unix seconds, the load average to two
 * places and % busy to one, as summary.ts parseLoad reads them.
 *
 * @param ms the sample's time, milliseconds
 */
export function loadRow(ms: number, load: number, busy: number) {
  return `${Math.floor(ms / 1000)},${Number(load.toFixed(2))},${busy.toFixed(1)}`;
}
