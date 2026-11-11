import { describe, expect, it } from 'vitest';
import { changedBaselines, pairBaselines } from '../lib/baselines.mjs';
import { MARKER, MAX_CHARS, rawUrl, renderTable } from './table.mjs';

const REPO = 'jbhirsh/BoardGames';
const BASE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const HEAD = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';
const COLUMNS = [
  { label: 'Phone', file: ['{state}-visual-phone-webkit-linux.png'], width: 200 },
  { label: 'Desktop', file: ['{state}-visual-webkit-linux.png'] },
];
const PHONE = 'e2e/visual-phone.spec.ts-snapshots';
const FULL = 'e2e/visual-full.spec.ts-snapshots';

/**
 * The table for these files API entries.
 *
 * @param {import('../lib/baselines.mjs').FileEntry[]} files
 */
function table(files) {
  const { rows, unpaired } = pairBaselines(
    changedBaselines(files, { folders: ['e2e/*-snapshots'] }),
    COLUMNS,
  );
  return renderTable({ rows, unpaired, columns: COLUMNS, repo: REPO, base: BASE, head: HEAD });
}

describe('renderTable', () => {
  it('shows each state before → after per column, linked by SHA', () => {
    const body = table([
      { filename: `${PHONE}/sign-in-light-visual-phone-webkit-linux.png`, status: 'modified' },
      { filename: `${FULL}/sign-in-light-visual-webkit-linux.png`, status: 'modified' },
      { filename: `${FULL}/sign-in-dark-visual-webkit-linux.png`, status: 'removed' },
      { filename: `${PHONE}/sign-in-passkey-light-visual-phone-webkit-linux.png`, status: 'added' },
      { filename: `${FULL}/sign-in-light-visual-firefox-linux.png`, status: 'modified' },
      { filename: 'src/App.tsx', status: 'modified' },
    ]);
    const img = (/** @type {string} */ sha, /** @type {string} */ file, /** @type {number} */ w) =>
      `<img src="https://raw.githubusercontent.com/${REPO}/${sha}/${file}" alt="${file}" width="${w}">`;
    expect(body).toBe(
      [
        MARKER,
        '### Visual changes',
        '',
        "From the 5 baselines this PR changed: before at `a1b2c3d` (the merge base), after at `9f8e7d6` (this PR's head). Rewritten on each push.",
        '',
        '| State | Phone | Desktop |',
        '|---|---|---|',
        `| <code>sign-in-dark</code> | — | ${img(BASE, `${FULL}/sign-in-dark-visual-webkit-linux.png`, 300)} → (removed) |`,
        `| <code>sign-in-light</code> | ${img(BASE, `${PHONE}/sign-in-light-visual-phone-webkit-linux.png`, 200)} → ${img(HEAD, `${PHONE}/sign-in-light-visual-phone-webkit-linux.png`, 200)} | ${img(BASE, `${FULL}/sign-in-light-visual-webkit-linux.png`, 300)} → ${img(HEAD, `${FULL}/sign-in-light-visual-webkit-linux.png`, 300)} |`,
        `| <code>sign-in-passkey-light</code> | (new) → ${img(HEAD, `${PHONE}/sign-in-passkey-light-visual-phone-webkit-linux.png`, 200)} | — |`,
        '',
        '<details>',
        '<summary>1 changed baseline in no column</summary>',
        '',
        `- <a href="https://github.com/${REPO}/blob/${HEAD}/${FULL}/sign-in-light-visual-firefox-linux.png">${FULL}/sign-in-light-visual-firefox-linux.png</a>`,
        '',
        '</details>',
      ].join('\n'),
    );
  });

  it('is null when no baseline changed, so the comment goes', () => {
    expect(table([{ filename: 'src/App.tsx', status: 'modified' }])).toBe(null);
  });

  it('lists only unpaired ones without a table, marking new and removed', () => {
    const body = /** @type {string} */ (
      table([
        { filename: `${FULL}/a-visual-firefox-linux.png`, status: 'added' },
        { filename: `${FULL}/b-visual-firefox-linux.png`, status: 'removed' },
      ])
    );
    expect(body).not.toContain('| State |');
    expect(body).toContain('a-visual-firefox-linux.png</a> (new)');
    expect(body).toContain(`blob/${BASE}/${FULL}/b-visual-firefox-linux.png">`);
    expect(body).toContain('b-visual-firefox-linux.png</a> (removed)');
    expect(body).toContain('From the 2 baselines');
  });

  it('labels a row by folder when a state makes one per folder', () => {
    const columns = [{ label: 'Phone', file: ['{state}.png'] }];
    const { rows, unpaired } = pairBaselines(
      changedBaselines(
        [
          { filename: 'a/x.png', status: 'modified' },
          { filename: 'b/x.png', status: 'modified' },
        ],
        { folders: ['a', 'b'] },
      ),
      columns,
    );
    const body = renderTable({ rows, unpaired, columns, repo: REPO, base: BASE, head: HEAD });
    expect(body).toContain('| <code>x</code> (a) |');
    expect(body).toContain('| <code>x</code> (b) |');
  });

  it('encodes paths and keeps names from breaking the table or mentioning anyone', () => {
    expect(rawUrl(REPO, HEAD, 'e2e/a b-snapshots/#1?.png')).toBe(
      `https://raw.githubusercontent.com/${REPO}/${HEAD}/e2e/a%20b-snapshots/%231%3F.png`,
    );
    const columns = [{ label: 'Phone', file: ['{state}.png'] }];
    const { rows, unpaired } = pairBaselines(
      changedBaselines([{ filename: 's/a|<b>@c".png', status: 'added' }], { folders: ['s'] }),
      columns,
    );
    const body = /** @type {string} */ (
      renderTable({ rows, unpaired, columns, repo: REPO, base: BASE, head: HEAD })
    );
    expect(body).toContain('<code>a&#124;&lt;b&gt;&#64;c&quot;</code>');
    const marks = pairBaselines(
      changedBaselines([{ filename: 's/a`*_[x]\\~.png', status: 'added' }], { folders: ['s'] }),
      columns,
    );
    expect(renderTable({ ...marks, columns, repo: REPO, base: BASE, head: HEAD })).toContain(
      '<code>a&#96;&#42;&#95;&#91;x&#93;&#92;&#126;</code>',
    );
    expect(body).toContain('alt="s/a&#124;&lt;b&gt;&#64;c&quot;.png"');
    expect(body).not.toContain('@');
  });

  it('stays under the limit, saying how many it left out', () => {
    const files = Array.from({ length: 400 }, (_, i) => ({
      filename: `${PHONE}/state-${String(i).padStart(3, '0')}-visual-phone-webkit-linux.png`,
      status: 'modified',
    }));
    const extra = Array.from({ length: 5 }, (_, i) => ({
      filename: `${FULL}/z${i}-visual-firefox-linux.png`,
      status: 'modified',
    }));
    const body = /** @type {string} */ (table([...files, ...extra]));
    expect(body.length).toBeLessThanOrEqual(MAX_CHARS);
    const shown = body.split('\n').filter((l) => l.startsWith('| <code>')).length;
    expect(shown).toBeGreaterThan(50);
    expect(shown).toBeLessThan(400);
    expect(body).toMatch(
      new RegExp(`And ${400 - shown + 5} more changed baselines: see Files changed\\.$`),
    );
    expect(body).not.toContain('<details>');
  });

  it('says how many of the unpaired it lists when they are cut short', () => {
    const extra = Array.from({ length: 1000 }, (_, i) => ({
      filename: `${FULL}/z${String(i).padStart(4, '0')}-visual-firefox-linux.png`,
      status: 'modified',
    }));
    const body = /** @type {string} */ (table(extra));
    expect(body.length).toBeLessThanOrEqual(MAX_CHARS);
    const listed = body.split('\n').filter((l) => l.startsWith('- <a ')).length;
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(1000);
    expect(body).toContain(`<summary>${listed} of 1000 changed baselines in no column</summary>`);
    expect(body).toMatch(
      new RegExp(`And ${1000 - listed} more changed baselines: see Files changed\\.$`),
    );
  });
});
