// The probe's results file, the one format every driver writes (web/ now,
// an app driver later) and the job's later steps read (job-summary's
// `measurements` input). One JSON object:
//
//   version       1
//   driver        the driver's name ("web"); a label, read by nothing
//   target        what was probed (the deployment's URL); a label
//   environment   "production" or "preview"
//   measurements  named measurements, in the order they were taken:
//                   name             the request ("games")
//                   phase            the `Server-Timing` entry's name
//                                    ("total", "db-open", "field.games"), or
//                                    "browser", the browser's own time
//                   start            "cold" or "warm"
//                   ms               its time
//                   label            the entry's `desc` ("Query.games")
//                   calls            how many times a field ran
//                   slowestMs        a field's slowest call
//                   atMs             when the entry started, in ms from the
//                                    handler's start (its `start`)
//                   requestStartMs,  a browser row's request and response
//                   responseStartMs  starts, in ms from the request's start
//                 Every number is finite and at least 0.
//   notes         lines about the run for whoever reads it ("cold carried
//                 by: games", requests not sent)
//
// parseResults reads any JSON, never throws, and keeps only valid rows, so
// a reader trusts what it returns.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Start = 'cold' | 'warm';

export interface Measurement {
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
}

export interface Results {
  version: 1;
  driver: string;
  target: string;
  environment: string;
  measurements: Measurement[];
  notes: string[];
}

/** The optional numbers a row may carry, in the order they're written. */
const NUMBERS = ['calls', 'slowestMs', 'atMs', 'requestStartMs', 'responseStartMs'] as const;

const amount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const label = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * A row, or null when it isn't a valid one. Its optional values that aren't
 * valid are dropped.
 */
function measurement(value: unknown): Measurement | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!label(row.name) || !label(row.phase) || !amount(row.ms)) return null;
  if (row.start !== 'cold' && row.start !== 'warm') return null;
  const out: Measurement = { name: row.name, phase: row.phase, start: row.start, ms: row.ms };
  if (typeof row.label === 'string') out.label = row.label;
  for (const key of NUMBERS) {
    const n = row[key];
    if (amount(n)) out[key] = n;
  }
  return out;
}

/** Reads parsed results JSON: whatever isn't valid is left out. */
export function parseResults(value: unknown): Results {
  const doc =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    version: 1,
    driver: text(doc.driver),
    target: text(doc.target),
    environment: text(doc.environment),
    measurements: Array.isArray(doc.measurements)
      ? doc.measurements.map(measurement).filter((row) => row !== null)
      : [],
    notes: Array.isArray(doc.notes) ? doc.notes.filter((n) => typeof n === 'string') : [],
  };
}

/** The results as the file holds them. */
export function formatResults(results: Results): string {
  return `${JSON.stringify(results, null, 2)}\n`;
}

/** Writes the results file, making its folder. */
export function writeResults(file: string, results: Results): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, formatResults(results));
}

/**
 * The middle value, or the mean of the middle two, of at least one value.
 */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One request's phase, cold and warm. */
export interface Aggregate {
  name: string;
  phase: string;
  label: string | undefined;
  /** The first cold row's ms, or null when none. */
  cold: number | null;
  /** The warm rows' median, or null when none. */
  warm: number | null;
  /** How many warm rows. */
  warmCount: number;
}

/**
 * Each request's phases, cold and warm, in the order each was first seen
 * (`Server-Timing` order).
 */
export function aggregate(measurements: Measurement[]): Aggregate[] {
  const byKey = new Map<string, { row: Aggregate; warm: number[] }>();
  for (const m of measurements) {
    const key = JSON.stringify([m.name, m.phase]);
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        row: { name: m.name, phase: m.phase, label: m.label, cold: null, warm: null, warmCount: 0 },
        warm: [],
      };
      byKey.set(key, entry);
    }
    if (m.start === 'cold') entry.row.cold ??= m.ms;
    else entry.warm.push(m.ms);
    entry.row.label ??= m.label;
  }
  return [...byKey.values()].map(({ row, warm }) => ({
    ...row,
    warm: warm.length > 0 ? median(warm) : null,
    warmCount: warm.length,
  }));
}
