import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEMPLATE, cli, selftest } from './selftest.mjs';

const GOOD_TEMPLATE = '<!--\n<img src="x">\n-->\n\n- [ ] No visible UI change\n';

/** A git checkout holding these files (path → contents). */
function app(/** @type {Record<string, string>} */ files) {
  const root = mkdtempSync(path.join(tmpdir(), 'visuals-app-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}

describe('selftest', () => {
  it('passes an app on the defaults with a good template', () => {
    const lines = selftest(app({ 'src/App.tsx': '', [TEMPLATE]: GOOD_TEMPLATE }));
    expect(lines).toEqual([
      'visuals: 1 of 2 tracked files count as UI.',
      `visuals: ${TEMPLATE} fails untouched and passes ticked.`,
    ]);
  });

  it('skips the template when there is none', () => {
    expect(selftest(app({ 'src/App.tsx': '' })).at(-1)).toBe(`visuals: no ${TEMPLATE}; skipped.`);
  });

  it('fails a glob that names no tracked file', () => {
    const root = app({
      'src/App.tsx': '',
      '.github/ci.json': JSON.stringify({ visuals: { ui: ['src/**', 'gone/**'] } }),
    });
    expect(() => selftest(root)).toThrow('visuals.ui names no tracked file: gone/**');
  });

  it('fails when notUi leaves nothing', () => {
    const root = app({
      'src/App.tsx': '',
      '.github/ci.json': JSON.stringify({ visuals: { notUi: ['src/**'] } }),
    });
    expect(() => selftest(root)).toThrow('leaves no UI file');
  });

  it.each([
    [
      'shows a picture untouched',
      '<img src="x">\n- [ ] No visible UI change',
      'passes a UI change',
    ],
    ['has no box', '<!-- x -->', 'has no "No visible UI change" box'],
    ['quotes the box in code', '```\n- [ ] No visible UI change\n```', 'still fails once'],
  ])('fails a template that %s', (_, template, error) => {
    expect(() => selftest(app({ 'src/App.tsx': '', [TEMPLATE]: template }))).toThrow(error);
  });
});

describe('cli', () => {
  it('prints the self-test and returns its exit code', () => {
    const lines = /** @type {string[]} */ ([]);
    expect(cli([app({ 'src/App.tsx': '' })], (l) => lines.push(l))).toBe(0);
    expect(cli([app({ 'README.md': '' })], (l) => lines.push(l))).toBe(1);
    expect(lines.at(-1)).toBe('visuals self-test failed: visuals.notUi leaves no UI file');
  });
});
