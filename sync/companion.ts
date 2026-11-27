// A companion (manifest.ts) is a key a synced file needs in the app's
// `.github/ci.json`: `autofix.exempt["PR changes"]` for a workflow on
// `pull_request_target`, which the app's autofix check otherwise fails. The
// sync sets it only when it adds the file, in the same commit, and never
// overwrites a key the app holds. Here:
//
//   - addCompanions writes the keys into the file's text, leaving every other
//     byte where it was: inside the deepest object of the key's path the app
//     already holds, after its last member, indented as its members are (a
//     missing object on the way is written whole). Re-serialising the parsed
//     file instead would expand every one-line array and object the app wrote.
//   - formatSettings then runs the app's own Prettier over it, as its format
//     check would, so the sync PR's file is Prettier-clean.
//   - settingsProblems is the guard on what reaches the PR: the file's parsed
//     value must be the app's plus exactly these keys, and no line of the app's
//     may go, apart from the comma JSON adds after the member that is no longer
//     the last. A reflow that rewrites a line fails it, naming the line.
//
// The app's ci.json is outside input: every function here takes any text and
// never throws on it except addCompanions, which refuses text that isn't a
// JSON object, or whose key on the way to a companion holds something other
// than an object (sync.ts reports it; the self-test catches it first).

import { isDeepStrictEqual } from 'node:util';
import { importFromApp, SETTINGS_FILE } from '../lib/app.ts';
import { holds, lineDiff } from './plan.ts';
import type { Companion } from './manifest.ts';

/**
 * An object in the text: where its closing brace is, where its last member's value ends (null when
 * it has none), and its members by key.
 */
export type ObjectAt = { close: number; lastEnd: number | null; members: Map<string, Value> };

export type Value = { start: number; object: ObjectAt | null };

/**
 * Reads a JSON value from `text` at `at` (after whitespace), recording where
 * each object's parts are. Text that JSON.parse accepts is all it is given.
 */
function readValue(text: string, at: { i: number }): Value {
  skip(text, at);
  const start = at.i;
  const char = text[at.i];
  if (char === '{') return { start, object: readObject(text, at) };
  if (char === '[') {
    at.i++;
    skip(text, at);
    if (text[at.i] === ']') {
      at.i++;
      return { start, object: null };
    }
    for (;;) {
      readValue(text, at);
      skip(text, at);
      if (text[at.i++] === ']') return { start, object: null };
    }
  }
  if (char === '"') {
    readString(text, at);
    return { start, object: null };
  }
  while (at.i < text.length && !/[\s,\]}]/.test(text[at.i])) at.i++;
  return { start, object: null };
}

/**
 * @param text
 * @param at on the opening quote
 */
function readString(text: string, at: { i: number }) {
  const start = at.i;
  at.i++;
  while (text[at.i] !== '"') at.i += text[at.i] === '\\' ? 2 : 1;
  at.i++;
  return JSON.parse(text.slice(start, at.i)) as string;
}

/**
 * @param text
 * @param at on the opening brace
 */
function readObject(text: string, at: { i: number }): ObjectAt {
  at.i++;
  const members: Map<string, Value> = new Map();
  let lastEnd: number | null = null;
  skip(text, at);
  if (text[at.i] === '}') return { close: at.i++, lastEnd, members };
  for (;;) {
    skip(text, at);
    const key = readString(text, at);
    skip(text, at);
    at.i++; // the colon
    const value = readValue(text, at);
    // A repeated key: JSON.parse keeps the last, and so does this.
    members.set(key, value);
    lastEnd = at.i;
    skip(text, at);
    if (text[at.i] === '}') return { close: at.i++, lastEnd, members };
    at.i++; // the comma
  }
}

function skip(text: string, at: { i: number }) {
  while (at.i < text.length && /\s/.test(text[at.i])) at.i++;
}

/**
 * The indentation of the line `offset` is on.
 */
function indentAt(text: string, offset: number) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
}

/**
 * A value as JSON, expanded with `step` per level, its first line unindented.
 *
 * @param value
 * @param indent the indentation of the line it starts on
 * @param step
 */
const serialize = (value: unknown, indent: string, step: string) =>
  JSON.stringify(value, null, step).replace(/\n/g, `\n${indent}`);

/**
 * The app's settings text with the companions' keys added that it lacks; the
 * rest of its text is unchanged. An app with no ci.json is given '' and gets
 * a new file.
 *
 * @param text the app's `.github/ci.json`, or ''
 * @param companions
 */
export function addCompanions(text: string, companions: Companion[]): string {
  let out = text.trim() === '' ? '{}\n' : text;
  for (const { key, value } of companions) {
    const parsed: unknown = JSON.parse(out);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${SETTINGS_FILE} must hold an object`);
    }
    if (holds(parsed as Record<string, unknown>, key)) continue;
    // The deepest object on the key's path that the text holds.
    let object = readValue(out, { i: 0 }).object as ObjectAt;
    let depth = 0;
    while (depth < key.length - 1) {
      const found = object.members.get(key[depth]);
      if (!found) break;
      if (!found.object) {
        // Never written over: a key on the way holds something else.
        throw new Error(
          `${SETTINGS_FILE}: "${key.slice(0, depth + 1).join('.')}" is not an object, so "${key.join('.')}" can't be set`,
        );
      }
      object = found.object;
      depth++;
    }
    let member: unknown = value;
    for (const segment of key.slice(depth + 1).reverse()) member = { [segment]: member };
    const name = JSON.stringify(key[depth]);
    const closeIndent = indentAt(out, object.close);
    if (object.lastEnd === null) {
      // An empty object: its members go one level in from its closing brace.
      const step = '  ';
      const inner = `${closeIndent}${step}`;
      const at = out.lastIndexOf('{', object.close);
      out =
        `${out.slice(0, at + 1)}\n${inner}${name}: ${serialize(member, inner, step)}\n` +
        `${closeIndent}${out.slice(object.close)}`;
    } else {
      const inner = indentAt(out, object.lastEnd);
      const step =
        inner.startsWith(closeIndent) && inner !== closeIndent
          ? inner.slice(closeIndent.length)
          : '  ';
      const oneLine = !out.slice(object.lastEnd, object.close).includes('\n');
      const insert = oneLine
        ? `, ${name}: ${JSON.stringify(member)}`
        : `,\n${inner}${name}: ${serialize(member, inner, step)}`;
      out = `${out.slice(0, object.lastEnd)}${insert}${out.slice(object.lastEnd)}`;
    }
  }
  return out;
}

/**
 * The settings text as the app's Prettier writes it (its own version and
 * config, as its format check reads them), from the app's node_modules.
 *
 * @param text
 * @param root the app's checkout, with its packages installed
 */
export async function formatSettings(text: string, root: string): Promise<string> {
  const prettier = (await importFromApp('prettier', root)) as typeof import('prettier');
  const filepath = `${root}/${SETTINGS_FILE}`;
  const options = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(text, { ...options, filepath });
}

/**
 * Whether a JSON text parses to an object, and to which.
 */
function objectOf(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text.trim() === '' ? '{}' : text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The guard's reading of a settings change: why `after` is not `before` with
 * exactly these companions' keys added, or [] when it is. Never throws.
 *
 * @param before the app's `.github/ci.json` ('' when it has none)
 * @param after what the sync PR holds
 * @param companions
 */
export function settingsProblems(before: string, after: string, companions: Companion[]): string[] {
  const old = objectOf(before);
  const now = objectOf(after);
  if (!old) return [`${SETTINGS_FILE} in the app is not a JSON object`];
  if (!now) return [`${SETTINGS_FILE} in the sync PR is not a JSON object`];
  const expected: Record<string, unknown> = structuredClone(old);
  for (const { key, value } of companions) {
    if (holds(expected, key)) continue;
    let at: Record<string, unknown> = expected;
    for (const segment of key.slice(0, -1)) {
      if (!Object.hasOwn(at, segment)) at[segment] = {};
      const next = at[segment];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        return [
          `${SETTINGS_FILE}: "${segment}" is not an object, so "${key.join('.')}" can't be set`,
        ];
      }
      at = next as Record<string, unknown>;
    }
    at[key.at(-1) as string] = value;
  }
  const problems: string[] = [];
  if (!isDeepStrictEqual(now, expected)) {
    problems.push(
      `${SETTINGS_FILE} in the sync PR changes more than the companion keys (${companions.map(({ key }) => key.join('.')).join(', ')})`,
    );
  }
  const { removed, added } = lineDiff(before, after);
  const gained = new Set(added);
  for (const line of removed) {
    if (line.trim() === '' && before.trim() === '') continue;
    if (!gained.has(`${line},`)) {
      problems.push(
        `${SETTINGS_FILE} in the sync PR removes or rewrites the line ${JSON.stringify(line)}`,
      );
    }
  }
  return problems;
}
