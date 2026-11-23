// Properties of writing companion keys into an app's ci.json, over any JSON
// object an app could hold: it never throws on one, reads back as the app's
// settings plus exactly the keys it lacked, and the guard passes what it
// writes into expanded objects (the apps' shape).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addCompanions, settingsProblems } from './companion.mjs';
import { holds } from './plan.mjs';

// The manifest refuses a key that reaches a prototype (manifest.mjs).
const keyName = fc
  .oneof(
    fc.constantFrom('autofix', 'exempt', 'PR GIFs', 'a"b', 'x\\y', '', ' '),
    fc.string({ maxLength: 6 }),
  )
  .filter((key) => !['__proto__', 'constructor', 'prototype'].includes(key));
const leaf = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.oneof(fc.string({ maxLength: 4 }), fc.integer()), { maxLength: 3 }),
);
/** @type {fc.Arbitrary<Record<string, unknown>>} */
const settings = fc
  .letrec((tie) => ({
    node: fc.dictionary(keyName, fc.oneof({ depthSize: 'small' }, leaf, tie('node')), {
      maxKeys: 4,
    }),
  }))
  .node.map((value) => /** @type {Record<string, unknown>} */ (value));
const companions = fc.array(
  fc.record({ key: fc.array(keyName, { minLength: 1, maxLength: 3 }), value: fc.string() }),
  { maxLength: 3 },
);

/**
 * The settings with each companion set that can be, in order, never
 * overwriting: what addCompanions must produce. Null when a key on the way
 * to one holds something other than an object, which it must refuse.
 *
 * @param {Record<string, unknown>} value
 * @param {{ key: string[], value: string }[]} list
 * @returns {Record<string, unknown> | null}
 */
function expected(value, list) {
  const out = structuredClone(value);
  for (const { key, value: v } of list) {
    if (holds(out, key)) continue;
    /** @type {Record<string, unknown>} */
    let at = out;
    for (const segment of key.slice(0, -1)) {
      if (!Object.hasOwn(at, segment)) at[segment] = {};
      const next = at[segment];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) return null;
      at = /** @type {Record<string, unknown>} */ (next);
    }
    at[/** @type {string} */ (key.at(-1))] = v;
  }
  return out;
}

/**
 * Whether a companion is written into an object the settings hold empty,
 * which the guard reads as a rewritten line (`{}` becomes `{` and `}`).
 *
 * @param {Record<string, unknown>} value
 * @param {{ key: string[] }[]} list
 */
function intoEmpty(value, list) {
  return list.some(({ key }) => {
    /** @type {unknown} */
    let at = value;
    for (const segment of ['', ...key.slice(0, -1)].entries()) {
      if (segment[0] > 0) {
        if (typeof at !== 'object' || at === null || !Object.hasOwn(at, segment[1])) return false;
        at = /** @type {Record<string, unknown>} */ (at)[segment[1]];
      }
      if (typeof at === 'object' && at !== null && Object.keys(at).length === 0) return true;
    }
    return false;
  });
}

describe('addCompanions over any settings', () => {
  it('reads back as the settings plus exactly the keys they lacked, or refuses', () => {
    fc.assert(
      fc.property(settings, companions, fc.boolean(), (value, list, expanded) => {
        const text = expanded ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value);
        const want = expected(value, list);
        if (want === null) {
          expect(() => addCompanions(text, list)).toThrow(/is not an object, so .* can't be set/);
        } else {
          expect(JSON.parse(addCompanions(text, list))).toEqual(want);
        }
      }),
    );
  });

  it('writes into expanded settings what the guard passes', () => {
    fc.assert(
      fc.property(settings, companions, (value, list) => {
        fc.pre(expected(value, list) !== null && !intoEmpty(value, list));
        const text = `${JSON.stringify(value, null, 2)}\n`;
        expect(settingsProblems(text, addCompanions(text, list), list)).toEqual([]);
      }),
    );
  });

  it('gives the guard text it never throws on', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), companions, (before, after, list) => {
        expect(Array.isArray(settingsProblems(before, after, list))).toBe(true);
      }),
    );
  });
});
