import { describe, expect, it } from 'vitest';
import { findLinks, parseLink, rewriteText } from './links.mjs';

const names = { branch: 'screenshots', legacy: 'pr-screenshots' };
const repo = 'jbhirsh/BoardGames';
const raw = 'https://raw.githubusercontent.com/jbhirsh/BoardGames';

/** @param {string} text */
const refs = (text) => findLinks(text, repo, names).map((l) => [l.form, l.ref, l.path]);

describe('findLinks', () => {
  it('reads each form of link, wherever it sits in the text', () => {
    const text = [
      `![before](${raw}/7c4f0e1a2b/199/before.png)`,
      `<img src="${raw}/screenshots/199/after.png" width="300">`,
      `bare ${raw}/pr-screenshots/carousel/after-want.gif here`,
      `[ref]: https://github.com/jbhirsh/BoardGames/blob/e5fc838/tailwind/a.png?raw=true`,
      '`https://github.com/jbhirsh/BoardGames/raw/refs/heads/screenshots/x.png`',
      'https://github.com/jbhirsh/BoardGames/tree/e5fc838/tailwind',
      'https://github.com/jbhirsh/BoardGames/commit/E5FC8381234',
      `| ${raw}/abc1234/a.png | ${raw}/abc1234/b.png |`,
    ].join('\n');
    expect(refs(text)).toEqual([
      ['raw', '7c4f0e1a2b', '199/before.png'],
      ['raw', 'screenshots', '199/after.png'],
      ['raw', 'pr-screenshots/carousel', 'after-want.gif'],
      ['blob', 'e5fc838', 'tailwind/a.png'],
      ['raw', 'screenshots', 'x.png'],
      ['tree', 'e5fc838', 'tailwind'],
      ['commit', 'e5fc8381234', ''],
      ['raw', 'abc1234', 'a.png'],
      ['raw', 'abc1234', 'b.png'],
    ]);
  });

  it('matches the owner and repo without case, and only that repo', () => {
    expect(refs('https://raw.githubusercontent.com/JBHirsh/boardgames/abc1234/a.png')).toEqual([
      ['raw', 'abc1234', 'a.png'],
    ]);
    expect(refs('https://raw.githubusercontent.com/jbhirsh/sift/abc1234/a.png')).toEqual([]);
    expect(refs('https://raw.githubusercontent.com/jbhirsh/BoardGames-x/abc1234/a.png')).toEqual(
      [],
    );
  });

  it('leaves out trailing punctuation and keeps the query in the URL', () => {
    const [a, b] = findLinks(
      `See ${raw}/abc1234/a.png. And ${raw}/abc1234/b.png?raw=true,`,
      repo,
      names,
    );
    expect(a.url).toBe(`${raw}/abc1234/a.png`);
    expect(b.url).toBe(`${raw}/abc1234/b.png?raw=true`);
  });

  it('decodes %-escapes in the path, keeping a malformed one', () => {
    expect(refs(`${raw}/abc1234/my%20shot.png ${raw}/abc1234/bad%zz.png`)).toEqual([
      ['raw', 'abc1234', 'my shot.png'],
      ['raw', 'abc1234', 'bad%zz.png'],
    ]);
  });

  it('skips template placeholders and links with no file', () => {
    const text = [
      `${raw}/<sha>/<PR number>/before.png`,
      `${raw}/%3Csha%3E/before.png`,
      `${raw}/abc1234/…/before.png`,
      `<!-- | ![](${raw}/<sha>/<PR>/after.png) | -->`,
      `${raw}/abc1234/`,
      'https://github.com/jbhirsh/BoardGames/commit/<sha>',
      'https://github.com/jbhirsh/BoardGames/commit/main',
    ].join('\n');
    expect(refs(text)).toEqual([]);
  });
});

describe('parseLink', () => {
  it('reads a tree at a ref root as an empty path', () => {
    expect(parseLink('https://github.com/jbhirsh/BoardGames/tree/screenshots', names)).toEqual({
      url: 'https://github.com/jbhirsh/BoardGames/tree/screenshots',
      form: 'tree',
      ref: 'screenshots',
      path: '',
    });
  });

  it('keeps a branch name as written, and lower-cases a SHA', () => {
    expect(parseLink(`${raw}/main/README.md`, names)?.ref).toBe('main');
    expect(parseLink(`${raw}/ABC1234/a.png`, names)?.ref).toBe('abc1234');
  });
});

describe('rewriteText', () => {
  const to = new Map([
    [`${raw}/abc1234/a.png`, 'https://github.com/user-attachments/assets/1'],
    [`${raw}/abc1234/a.png?raw=true`, 'https://github.com/user-attachments/assets/2'],
  ]);

  it('swaps whole links only, never a prefix of a longer one', () => {
    const text = `![a](${raw}/abc1234/a.png) ![b](${raw}/abc1234/a.png?raw=true) ${raw}/abc1234/a.png.`;
    expect(rewriteText(text, repo, (url) => to.get(url))).toBe(
      '![a](https://github.com/user-attachments/assets/1) ![b](https://github.com/user-attachments/assets/2) https://github.com/user-attachments/assets/1.',
    );
  });

  it('keeps links with no new URL, and a second rewrite changes nothing', () => {
    const text = `${raw}/abc1234/a.png ${raw}/abc1234/other.png`;
    const once = rewriteText(text, repo, (url) => to.get(url));
    expect(once).toBe(`https://github.com/user-attachments/assets/1 ${raw}/abc1234/other.png`);
    expect(rewriteText(once, repo, (url) => to.get(url))).toBe(once);
  });
});
