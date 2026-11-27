// A probe's measurements (probe/results.ts, the `measurements` input), as
// job-summary tracks them: one value per request, phase and start (cold or
// warm) kept in the run's record, for later runs to compare theirs with.
// Pure: summary.ts reads the file and history.ts the earlier records.
//
// A record's value is the cold row, or the median of the warm repeats, as
// the probe's own table shows them. "Usual" is trends.ts' usual(): the
// median of at least MIN_SAMPLES earlier values, cold compared only with
// cold and warm with warm. Slower than usual is MEASURE_RATIO of usual and
// at least a floor more: MEASURE_FLOOR_MS, or BROWSER_FLOOR_MS for the
// browser's own time, which carries the network's wobble. trends.ts' rule
// is for steps and tests that take seconds; a field taking 0.8 ms more
// isn't news, nor a 2 s step taking 3 s. Both numbers are provisional
// (ci#151), to be settled once there's data.

import { median } from '../probe/results.ts';
import { usual } from './trends.ts';
import type { Measurement, Results, Start } from '../probe/results.ts';

/** How many times usual is slower than usual. */
export const MEASURE_RATIO = 1.25;
/** And by at least this many ms: a phase, the server or a field. */
export const MEASURE_FLOOR_MS = 5;
/** The browser's own time's floor, which carries the network's wobble. */
export const BROWSER_FLOOR_MS = 20;

/** The browser's own time for a request (probe/web), named apart from the server's. */
const BROWSER = 'browser';

/** One value a run's record keeps. */
export type Value = { name: string; phase: string; start: Start; ms: number };

/** What a run's record keeps of its measurements. */
export type Recorded = {
  /** the deployment's environment ("production", "preview") */
  environment: string;
  values: Value[];
};

/** One request's phase, cold or warm: the cold row, or the warm repeats' medians. */
export type Summary = {
  name: string;
  phase: string;
  start: Start;
  ms: number;
  label?: string;
  calls?: number;
  slowestMs?: number;
  atMs?: number;
  requestStartMs?: number;
  responseStartMs?: number;
};

/**
 * Whether a time is slower than its usual one, by the ms rule.
 *
 * @param ms this run's
 * @param typical usual, or null without enough earlier values
 * @param phase which floor applies
 */
export function measureSlower(ms: number, typical: number | null, phase: string): boolean {
  const floor = phase === BROWSER ? BROWSER_FLOOR_MS : MEASURE_FLOOR_MS;
  return typical !== null && ms >= typical * MEASURE_RATIO && ms - typical >= floor;
}

/** The optional numbers a summary carries, each the cold row's or the warm medians'. */
const NUMBERS = ['calls', 'slowestMs', 'atMs', 'requestStartMs', 'responseStartMs'] as const;

/**
 * Each request's phases, cold and warm, in the order each was first seen
 * (`Server-Timing` order): the first cold row, or the median of the warm
 * rows, number by number.
 */
export function summarize(measurements: Measurement[]): Summary[] {
  const groups = new Map<string, Measurement[]>();
  for (const m of measurements) {
    const key = JSON.stringify([m.name, m.phase, m.start]);
    const group = groups.get(key);
    if (group) group.push(m);
    else groups.set(key, [m]);
  }
  return [...groups.values()].map((group) => {
    const [first] = group;
    const rows = first.start === 'cold' ? [first] : group;
    const out: Summary = {
      name: first.name,
      phase: first.phase,
      start: first.start,
      ms: median(rows.map((m) => m.ms)),
    };
    const label = group.find((m) => m.label)?.label;
    if (label) out.label = label;
    for (const key of NUMBERS) {
      const values = rows.flatMap((m) => (m[key] === undefined ? [] : [m[key]]));
      if (values.length) out[key] = median(values);
    }
    return out;
  });
}

/**
 * What a run's record keeps of its results: one value per request, phase
 * and start.
 */
export function recorded(results: Results): Recorded {
  return {
    environment: results.environment,
    values: summarize(results.measurements).map(({ name, phase, start, ms }) => ({
      name,
      phase,
      start,
      ms,
    })),
  };
}

const text = (v: unknown): v is string => typeof v === 'string' && v !== '';
const amount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * A record's measurements, from its JSON, or null when it has none. Values
 * that aren't valid are left out. Never throws.
 */
export function parseRecorded(value: unknown): Recorded | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  if (!Array.isArray(doc.values)) return null;
  const values = doc.values.flatMap((v: unknown): Value[] => {
    if (typeof v !== 'object' || v === null) return [];
    const row = v as Record<string, unknown>;
    if (!text(row.name) || !text(row.phase) || !amount(row.ms)) return [];
    if (row.start !== 'cold' && row.start !== 'warm') return [];
    return [{ name: row.name, phase: row.phase, start: row.start, ms: row.ms }];
  });
  return { environment: typeof doc.environment === 'string' ? doc.environment : '', values };
}

/** How one value compares with its earlier ones. */
export type MeasureTrend = { usual: number | null; slower: boolean };

/**
 * A value's usual (the median of at least MIN_SAMPLES earlier values) and
 * whether it's slower than that.
 *
 * @param ms this run's
 * @param past its earlier values, null where a run didn't have it
 * @param phase which floor applies
 */
export function measureTrend(ms: number, past: (number | null)[], phase: string): MeasureTrend {
  const typical = usual(past.filter((v) => v !== null));
  return { usual: typical, slower: measureSlower(ms, typical, phase) };
}
