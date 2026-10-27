import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, selftest } from './selftest.mjs';

/** A throwaway checkout holding this package.json. */
function app(/** @type {Record<string, unknown>} */ pkg) {
  const root = mkdtempSync(path.join(tmpdir(), 'pins-self-'));
  mkdirSync(path.join(root, '.github'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  return root;
}

describe('selftest', () => {
  it('prints the pins without judging them', () => {
    expect(selftest(app({ dependencies: { a: '1.2.3' } }))).toEqual([
      'pins: 1 pinned without a reason.',
      '  package.json:3: a 1.2.3 holds it below its next major: use ^1.2.3, or say why in "//pins".',
    ]);
  });
});

describe('cli', () => {
  it('passes when the files read', () => {
    /** @type {string[]} */
    const out = [];
    expect(cli([app({})], (l) => out.push(l))).toBe(0);
    expect(out).toEqual(['pins: 0 pinned without a reason.']);
  });

  it("fails when a file can't be read", () => {
    /** @type {string[]} */
    const out = [];
    expect(cli([app({ dependencies: { expo: '~57' } })], (l) => out.push(l))).toBe(1);
    expect(out[0]).toContain('pins self-test failed: expo is a dependency');
  });
});
