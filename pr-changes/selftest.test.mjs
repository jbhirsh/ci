import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
