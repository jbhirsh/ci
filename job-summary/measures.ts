// A probe's measurements (probe/results.ts, the `measurements` input), as
// job-summary tracks them: one value per request, phase and start (cold or
// warm) kept in the run's record, compared with main's earlier runs, and
// drawn as the report's "Where the time went" card (model.ts, report.html).
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
//
// Each request's parts are placed in time, in ms from the browser sending
// the request, for the card's waterfall (no clocks are compared):
//   - the browser's row starts at 0, its `requestStartMs` (the probe
//     counts both from Playwright's own start of the request);
//   - the server's `total` ends when the browser saw its headers, its
//     `responseStartMs` less its `requestStartMs`;
//   - `loaded` (loading the code, a cold start's) ends where the server
//     starts;
//   - the other phases and the GraphQL fields sit at the server's start
//     plus their `atMs`, or one after another in header order when the app
//     sends no `start=`. With no `total`, the server's span is theirs, still
//     ending when the headers arrived.

import { median } from '../probe/results.ts';
import { formatServerTiming } from '../probe/server-timing.ts';
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
/** The server's own time, from its `Server-Timing`. */
const TOTAL = 'total';
/** Loading the function's code, before the handler ran: a cold start's. */
const LOADED = 'loaded';
/** A GraphQL field's entry: `field.<path>`. */
const FIELD = 'field.';

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

/** What a part of a request is, for its colour and where it's drawn. */
export type Kind = 'browser' | 'cold' | 'server' | 'phase' | 'field';

/** A part of a request, one start's. */
export type Part = Summary & {
  /** ms from the browser sending the request */
  at: number;
};

/** A part of a request, with what it is and where it sits. */
export type Place = {
  /** its phase, unique in its request */
  key: string;
  /** how the report names it ("Opening the database"; a field's `Type.field`) */
  title: string;
  /** its short name: the phase ("db-open"), or a field's `Type.field` */
  label: string;
  /** a field's path ("games.bgg"), '' otherwise */
  path: string;
  kind: Kind;
  /** 0 the browser; 1 loading the code and the server; 2 and on, inside the server */
  depth: number;
  cold: Part | null;
  warm: Part | null;
};

/** The parts an app's `Server-Timing` names that read better in words. */
const TITLES: Record<string, string> = {
  [BROWSER]: 'Browser',
  [TOTAL]: 'Server',
  [LOADED]: 'Loading the code',
  deps: 'Building services',
  'db-open': 'Opening the database',
  'auth-init': 'Setting up sign-in',
};

/**
 * One start's parts of a request placed in time: the browser's from 0,
 * the server ending when the browser saw its headers, loading the code
 * ending where it starts, and the rest from the server's start.
 */
function placed(rows: Summary[]): Map<string, Part> {
  const browser = rows.find((r) => r.phase === BROWSER);
  const total = rows.find((r) => r.phase === TOTAL);
  const end =
    browser?.responseStartMs === undefined
      ? undefined
      : browser.responseStartMs - (browser.requestStartMs ?? 0);
  // Inside the server, from its start: at their own start, or one after
  // another in header order.
  const inside = new Map<string, number>();
  let next = 0;
  for (const r of rows) {
    if (r.phase === BROWSER || r.phase === TOTAL || r.phase === LOADED) continue;
    const at = r.atMs ?? next;
    inside.set(r.phase, at);
    next = at + r.ms;
  }
  const span =
    total?.ms ??
    Math.max(
      0,
      ...rows.flatMap((r) => (inside.has(r.phase) ? [(inside.get(r.phase) ?? 0) + r.ms] : [])),
    );
  const server = end === undefined ? 0 : Math.max(0, end - span);
  const out = new Map<string, Part>();
  for (const r of rows) {
    const at =
      r.phase === BROWSER
        ? 0
        : r.phase === TOTAL
          ? server
          : r.phase === LOADED
            ? Math.max(0, server - r.ms)
            : server + (inside.get(r.phase) ?? 0);
    out.set(r.phase, { ...r, at });
  }
  return out;
}

/**
 * The fields' paths in tree order: each after its parent, siblings in the
 * order they were first seen.
 */
function treeOrder(paths: string[]): string[] {
  const seen = (prefix: string) =>
    paths.findIndex((p) => p === prefix || p.startsWith(`${prefix}.`));
  const rank = (p: string) => {
    const parts = p.split('.');
    return parts.map((_, i) => seen(parts.slice(0, i + 1).join('.')));
  };
  const ranks = new Map(paths.map((p) => [p, rank(p)]));
  return [...paths].sort((a, b) => {
    const [x, y] = [ranks.get(a) ?? [], ranks.get(b) ?? []];
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  });
}

/**
 * How many of a field's ancestors are among the fields: its depth below
 * the first, so one whose parent wasn't timed sits under its nearest
 * ancestor that was.
 */
function ancestors(path: string, paths: string[]): number {
  const parts = path.split('.');
  return parts.slice(1).filter((_, i) => paths.includes(parts.slice(0, i + 1).join('.'))).length;
}

/**
 * Each request's parts, in the order things happen: the browser's whole
 * request; loading the code and the server; inside the server, its other
 * phases in header order, then the GraphQL fields by their path. Requests
 * in the order first seen.
 */
export function requests(measurements: Measurement[]): { name: string; parts: Place[] }[] {
  const summaries = summarize(measurements);
  const names = [...new Set(summaries.map((s) => s.name))];
  return names.map((name) => {
    const mine = summaries.filter((s) => s.name === name);
    const cold = placed(mine.filter((s) => s.start === 'cold'));
    const warm = placed(mine.filter((s) => s.start === 'warm'));
    const phases = [...new Set(mine.map((s) => s.phase))];
    const label = (phase: string) =>
      mine.find((s) => s.phase === phase && s.label)?.label ?? phase.slice(FIELD.length);
    const place = (phase: string, kind: Kind, depth: number): Place => ({
      key: phase,
      title: kind === 'field' ? label(phase) : Object.hasOwn(TITLES, phase) ? TITLES[phase] : phase,
      label: kind === 'field' ? label(phase) : phase,
      path: kind === 'field' ? phase.slice(FIELD.length) : '',
      kind,
      depth,
      cold: cold.get(phase) ?? null,
      warm: warm.get(phase) ?? null,
    });
    const fixed = [BROWSER, LOADED, TOTAL];
    const fields = treeOrder(
      phases.filter((p) => p.startsWith(FIELD)).map((p) => p.slice(FIELD.length)),
    );
    const parts = [
      ...(phases.includes(BROWSER) ? [place(BROWSER, 'browser', 0)] : []),
      ...(phases.includes(LOADED) ? [place(LOADED, 'cold', 1)] : []),
      ...(phases.includes(TOTAL) ? [place(TOTAL, 'server', 1)] : []),
      ...phases
        .filter((p) => !fixed.includes(p) && !p.startsWith(FIELD))
        .map((p) => place(p, warm.has(p) ? 'phase' : 'cold', 2)),
      ...fields.map((path) => place(FIELD + path, 'field', 2 + ancestors(path, fields))),
    ];
    return { name, parts };
  });
}

/** Two decimals at most, as an app would write them. */
const round = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 100) / 100);

/**
 * A part's `Server-Timing` entry, as the app sends it ('' for the
 * browser's own time, which isn't one).
 */
export function rawEntry(part: Summary): string {
  if (part.phase === BROWSER) return '';
  return formatServerTiming([
    {
      name: part.phase,
      dur: round(part.ms),
      desc: part.label,
      calls: part.calls,
      slowest: round(part.slowestMs),
      start: round(part.atMs),
    },
  ]);
}
