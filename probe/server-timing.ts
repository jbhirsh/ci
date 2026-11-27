// Reads a response's `Server-Timing` header (W3C Server Timing, RFC 9110's
// list syntax): a comma-separated list of entries, each a token name and
// `;param=value` parameters, a value a token or a quoted string. Every
// driver reads the same header, so this is shared and pure.
//
// The parameters read are the ones the apps send (BoardGames'
// api/_lib/timing.ts):
//   dur      the entry's time, in ms;
//   desc     a label (`Query.games` for a field);
//   calls    how many times a field ran;
//   slowest  a field's slowest call, in ms;
//   start    when the entry started, in ms from the handler's start;
//   span     a repeated field's wall-clock span, in ms: its last call's end
//            less its first call's start, where `dur` adds its calls up.
// A number that isn't finite and at least 0 is left out, as if it weren't
// sent, so a row is never negative or NaN. An entry with no `dur` (the
// `cold` flag) still counts as an entry: it's how hasEntry finds the flag.
//
// It never throws: what isn't a valid entry is skipped to the next comma
// outside a quoted string, as a browser does. A parameter named twice keeps
// its first value, as the spec says.

/** One `Server-Timing` entry. */
export interface TimingEntry {
  name: string;
  dur?: number;
  desc?: string;
  calls?: number;
  slowest?: number;
  start?: number;
  span?: number;
}

/** RFC 9110's token characters. */
const TOKEN_CHAR = /[!#$%&'*+.^_`|~0-9A-Za-z-]/;
/** A plain decimal number, with an exponent if any: no sign, hex or Infinity. */
const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const NUMERIC = ['dur', 'calls', 'slowest', 'start', 'span'] as const;
type Numeric = (typeof NUMERIC)[number];

/** A parameter's value as a number of at least 0, or undefined. */
function amount(value: string): number | undefined {
  if (!NUMBER.test(value)) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Parses a `Server-Timing` value, or several (repeated headers), into its
 * entries in header order.
 */
export function parseServerTiming(header: string | string[]): TimingEntry[] {
  const text = Array.isArray(header) ? header.join(',') : header;
  const entries: TimingEntry[] = [];
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  };
  const token = () => {
    const from = i;
    while (i < text.length && TOKEN_CHAR.test(text[i])) i += 1;
    return text.slice(from, i);
  };
  const quoted = (): string | null => {
    // At the opening quote. Returns the unescaped text, or null when it never closes.
    i += 1;
    let out = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i += 1;
        return out;
      }
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
      } else {
        out += c;
        i += 1;
      }
    }
    return null;
  };
  // Past whatever is left of a broken entry: to the next comma outside quotes.
  const skipEntry = () => {
    while (i < text.length && text[i] !== ',') {
      if (text[i] === '"') quoted();
      else i += 1;
    }
  };

  while (i < text.length) {
    skipSpace();
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    const name = token();
    if (name === '') {
      skipEntry();
      continue;
    }
    const entry: TimingEntry = { name };
    const seen = new Set<string>();
    let broken = false;
    for (;;) {
      skipSpace();
      if (i >= text.length || text[i] === ',') break;
      if (text[i] !== ';') {
        broken = true;
        break;
      }
      i += 1;
      skipSpace();
      const param = token().toLowerCase();
      if (param === '') {
        broken = true;
        break;
      }
      skipSpace();
      let value = '';
      if (text[i] === '=') {
        i += 1;
        skipSpace();
        if (text[i] === '"') {
          const q = quoted();
          if (q === null) {
            broken = true;
            break;
          }
          value = q;
        } else {
          value = token();
        }
      }
      if (seen.has(param)) continue;
      seen.add(param);
      if (param === 'desc') entry.desc = value;
      else if ((NUMERIC as readonly string[]).includes(param)) {
        const n = amount(value);
        if (n !== undefined) entry[param as Numeric] = n;
      }
    }
    if (broken) {
      skipEntry();
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Whether the header names an entry `name` (the app's cold flag), wherever
 * it sits.
 */
export function hasEntry(entries: TimingEntry[], name: string): boolean {
  return entries.some((entry) => entry.name === name);
}

/** Writes entries as a `Server-Timing` value, as an app would send them. */
export function formatServerTiming(entries: TimingEntry[]): string {
  return entries
    .map((entry) => {
      let out = entry.name;
      if (entry.dur !== undefined) out += `;dur=${entry.dur}`;
      if (entry.desc !== undefined) out += `;desc="${entry.desc.replace(/["\\]/g, '\\$&')}"`;
      if (entry.calls !== undefined) out += `;calls=${entry.calls}`;
      if (entry.slowest !== undefined) out += `;slowest=${entry.slowest}`;
      if (entry.start !== undefined) out += `;start=${entry.start}`;
      if (entry.span !== undefined) out += `;span=${entry.span}`;
      return out;
    })
    .join(', ');
}
