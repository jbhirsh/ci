import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeFiles } from '../review/testApp.mjs';
import { cli, selftest } from './selftest.mjs';

const master = readFileSync(
  new URL('../.github/pull_request_template.md', import.meta.url),
  'utf8',
);
const TEMPLATE = '.github/pull_request_template.md';
const app = (/** @type {Record<string, string>} */ files) => {
  const root = mkdtempSync(path.join(tmpdir(), 'app-'));
  writeFiles(root, files);
  return root;
};

describe('selftest', () => {
  it('leaves an app whose template places no slot alone', () => {
    expect(selftest(app({}))[0]).toMatch(/places no change slot/);
    expect(selftest(app({ [TEMPLATE]: '## Goal\n' }))[0]).toMatch(/not used/);
  });

  it('passes the master template: its slot fills, and again without change', () => {
    expect(selftest(app({ [TEMPLATE]: master }))[0]).toMatch(/places 1 change slot/);
  });

  it("writes the master template's Revisions table and reads it back as current", () => {
    expect(selftest(app({ [TEMPLATE]: master }))[1]).toMatch(/gets its Revisions table/);
  });

  it("fails when the check doesn't ask for the new revision's row, or rejects it filled (ci#140)", async () => {
    const real = await import('../pr-template/body.mjs');
    /** @type {(body: string, sha: string) => string[]} */
    let check = () => [];
    vi.resetModules();
    vi.doMock('../pr-template/body.mjs', () => ({
      ...real,
      bodyProblems: (/** @type {string} */ body, /** @type {string} */ sha) => check(body, sha),
    }));
    try {
      const fresh = (await import('./selftest.mjs')).selftest;
      // A check that accepts the placeholder.
      expect(() => fresh(app({ [TEMPLATE]: master }))).toThrow(
        /ask only for the new revision's row/,
      );
      // A check that keeps asking once the row is filled.
      check = (body, sha) =>
        real.bodyProblems(body.replace('| A change | Its reason |', '|  |  |'), sha);
      expect(() => fresh(app({ [TEMPLATE]: master }))).toThrow(/once filled; it says/);
    } finally {
      vi.doUnmock('../pr-template/body.mjs');
      vi.resetModules();
    }
  });

  it('leaves Revisions unused for a template with a slot but no revisions pair', () => {
    const slot = '<!-- pr-changes:change:1 -->\n<!-- /pr-changes:change:1 -->\n';
    expect(selftest(app({ [TEMPLATE]: slot }))[1]).toMatch(/Revisions not used/);
  });

  it('leaves Revisions unused for a torn pair, which the tool never writes into', () => {
    const torn = master.replace('<!-- /pr-changes:revisions -->', '');
    expect(selftest(app({ [TEMPLATE]: torn }))[1]).toMatch(/Revisions not used/);
  });

  it('fails a template whose slots are not numbered from 1', () => {
    const odd = '<!-- pr-changes:change:2 -->\n<!-- /pr-changes:change:2 -->\n';
    expect(() => selftest(app({ [TEMPLATE]: odd }))).toThrow(/numbered from 1/);
  });
});

describe('cli', () => {
  it('returns 0 and prints for a good app, and 1 saying why for a bad one', () => {
    /** @type {string[]} */
    const out = [];
    expect(cli([app({ [TEMPLATE]: master })], (l) => out.push(l))).toBe(0);
    expect(
      cli(
        [app({ [TEMPLATE]: '<!-- pr-changes:change:3 -->\n<!-- /pr-changes:change:3 -->' })],
        (l) => out.push(l),
      ),
    ).toBe(1);
    expect(out.at(-1)).toMatch(/^pr-changes self-test failed: /);
  });
});
