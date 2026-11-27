import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFiles } from '../review/testApp.ts';
import { cli, selftest } from './selftest.ts';

const master = readFileSync(
  new URL('../.github/pull_request_template.md', import.meta.url),
  'utf8',
);

const app = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(tmpdir(), 'app-'));
  writeFiles(root, files);
  return root;
};
const ci = (c: Record<string, unknown>) => JSON.stringify(c);
const TEMPLATE = '.github/pull_request_template.md';
const review = { workflow: 'v.yml', job: 'v', folders: ['shots'] };

describe('selftest', () => {
  it('passes an app whose template is the master and which has visual review', () => {
    const root = app({
      '.github/ci.json': ci({ 'visual-review': review }),
      [TEMPLATE]: master,
    });
    expect(selftest(root)[0]).toMatch(/has the shared shape/);
  });

  it('fails without visual review, without a template, and with a box', () => {
    expect(() => selftest(app({ '.github/ci.json': ci({}), [TEMPLATE]: master }))).toThrow(
      /needs visual review/,
    );
    const withReview = { 'visual-review': review };
    expect(() => selftest(app({ '.github/ci.json': ci(withReview) }))).toThrow(/is missing/);
    expect(() =>
      selftest(
        app({
          '.github/ci.json': ci(withReview),
          [TEMPLATE]: `${master}\n- [ ] No visible UI change`,
        }),
      ),
    ).toThrow(/No visible UI change/);
  });

  it('prints the self-test and returns its exit code', () => {
    const out: string[] = [];
    const good = app({ '.github/ci.json': ci({ 'visual-review': review }), [TEMPLATE]: master });
    expect(cli([good], (l) => out.push(l))).toBe(0);
    const bad = app({ '.github/ci.json': ci({}) });
    expect(cli([bad], (l) => out.push(l))).toBe(1);
    expect(out.at(-1)).toMatch(/^pr-template self-test failed: .*needs visual review/);
  });
});
