import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findLinks, rewriteText } from './links.mjs';

const names = { branch: 'screenshots', legacy: 'pr-screenshots' };
const repo = 'jbhirsh/BoardGames';

const hex = fc.stringMatching(/^[0-9a-f]{7,40}$/);
const ref = fc.oneof(
  hex,
  fc.constant('screenshots'),
  fc.constant('pr-screenshots/carousel'),
  fc.constant('main'),
);
const file = fc.stringMatching(/^[\w-]{1,12}(\/[\w-]{1,12}){0,2}\.(png|gif)$/);
const link = fc
  .tuple(
    fc.constantFrom(
      'https://raw.githubusercontent.com/jbhirsh/BoardGames/',
      'https://github.com/jbhirsh/boardgames/blob/',
    ),
    ref,
    file,
    fc.constantFrom('', '?raw=true'),
  )
  .map(([host, r, f, q]) => `${host}${r}/${f}${q}`);
const filler = fc.string({ maxLength: 40 }).map((s) => s.replace(/https?:/g, ''));
const text = fc
  .array(
    fc.oneof(link, filler, fc.constantFrom('![a](', ') ', '<img src="', '">', '\n', ' | ', '. ')),
    { maxLength: 20 },
  )
  .map((parts) => parts.join(''));
const anyText = fc.oneof(text, fc.string({ maxLength: 200 }));
const attachment = fc.uuid().map((id) => `https://github.com/user-attachments/assets/${id}`);

describe('links, for any text', () => {
  it('never throws', () => {
    fc.assert(
      fc.property(anyText, (t) => {
        findLinks(t, repo, names);
        rewriteText(t, repo, () => 'x');
      }),
    );
  });

  it('a rewrite with nothing to replace is the identity', () => {
    fc.assert(fc.property(anyText, (t) => rewriteText(t, repo, () => undefined) === t));
  });

  it('a rewrite to attachments is idempotent, and leaves no link it replaced', () => {
    fc.assert(
      fc.property(text, attachment, (t, to) => {
        const once = rewriteText(t, repo, () => to);
        expect(rewriteText(once, repo, () => to)).toBe(once);
        expect(findLinks(once, repo, names)).toEqual([]);
      }),
    );
  });

  it('changes nothing outside the links', () => {
    fc.assert(
      fc.property(text, attachment, (t, to) => {
        const found = findLinks(t, repo, names).map((l) => l.url);
        const once = rewriteText(t, repo, (url) => (found.includes(url) ? to : undefined));
        // Splitting each text at its links leaves the same pieces between.
        const outside = (/** @type {string} */ s, /** @type {string[]} */ urls) =>
          [...urls]
            .sort((a, b) => b.length - a.length)
            .reduce((acc, url) => acc.split(url).join('\u0000'), s);
        expect(outside(once, [to])).toBe(outside(t, found));
      }),
    );
  });

  it('finds every link it was given', () => {
    fc.assert(
      fc.property(fc.array(link, { minLength: 1, maxLength: 5 }), (links) => {
        const found = findLinks(links.map((l) => `![x](${l})`).join(' '), repo, names);
        expect(found.map((l) => l.url)).toEqual(links);
      }),
    );
  });
});
