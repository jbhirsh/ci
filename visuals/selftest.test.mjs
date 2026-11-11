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

describe('selftest with fromBaselines', () => {
  const config = (/** @type {unknown} */ columns) =>
    JSON.stringify({
      visuals: { fromBaselines: true },
      'visual-baselines': { folders: ['shots'], columns },
    });

  it("checks the cases against the app's own baselines", () => {
    const root = app({
      'src/App.tsx': '',
      'shots/light-01-home.png': '',
      'shots/dark-01-home.png': '',
      [TEMPLATE]: GOOD_TEMPLATE,
      '.github/ci.json': config([
        { label: 'Light', file: 'light-{state}.png' },
        { label: 'Dark', file: 'dark-{state}.png' },
      ]),
    });
    expect(selftest(root).at(-1)).toBe(
      'visuals: with fromBaselines, 6 cases hold (shots/light-01-home.png in a column passes).',
    );
  });

  it('skips the no-column case when every name lands in one', () => {
    const root = app({
      'src/App.tsx': '',
      'shots/a.png': '',
      [TEMPLATE]: GOOD_TEMPLATE,
      '.github/ci.json': config([{ label: 'All', file: '{state}.png' }]),
    });
    expect(selftest(root).at(-1)).toMatch(/5 cases hold/);
  });

  it('fails without columns, with columns that pair nothing, or a template that shows a still', () => {
    const files = { 'src/App.tsx': '', 'shots/a.png': '', [TEMPLATE]: GOOD_TEMPLATE };
    expect(() =>
      selftest(
        app({
          ...files,
          '.github/ci.json': JSON.stringify({
            visuals: { fromBaselines: true },
            'visual-baselines': { folders: ['shots'] },
          }),
        }),
      ),
    ).toThrow('needs visual-baselines.columns');
    expect(() =>
      selftest(
        app({ ...files, '.github/ci.json': config([{ label: 'A', file: 'x-{state}.png' }]) }),
      ),
    ).toThrow('pairs no tracked baseline');
    expect(() =>
      selftest(
        app({
          ...files,
          [TEMPLATE]: `${GOOD_TEMPLATE}\nhttps://github.com/user-attachments/assets/1\n`,
          '.github/ci.json': config([{ label: 'A', file: '{state}.png' }]),
        }),
      ),
    ).toThrow(/untouched .* passes a UI change/);
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
