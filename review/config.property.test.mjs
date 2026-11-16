import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { advisorSetting, checkEngine } from './config.mjs';

/** Values an app's .github/ci.json might hold for a setting. */
const value = fc.oneof(
  fc.string(),
  fc.constantFrom('sdk', 'action', 'opus', null, undefined),
  fc.jsonValue(),
);

/**
 * What a setting reads as, or the error it throws.
 *
 * @template T
 * @param {() => T} read
 * @returns {{ ok: true, value: T } | { ok: false, message: string }}
 */
function attempt(read) {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}

describe('engine and advisor settings, for any value in .github/ci.json', () => {
  it('accept only "sdk" or no engine, or fail naming the setting', () => {
    fc.assert(
      fc.property(value, (v) => {
        const out = attempt(() => checkEngine('autofix.engine', v));
        if (out.ok) expect([undefined, 'sdk']).toContain(v);
        else expect(out.message).toContain('"autofix.engine"');
      }),
    );
  });
  it('read back as a model name or none, or fail naming the setting', () => {
    fc.assert(
      fc.property(value, (v) => {
        const out = attempt(() => advisorSetting('review.advisor', v));
        if (out.ok)
          expect(out.value === null || /^[a-z0-9][a-z0-9.-]*$/.test(out.value)).toBe(true);
        else expect(out.message).toContain('"review.advisor"');
      }),
    );
  });
});
