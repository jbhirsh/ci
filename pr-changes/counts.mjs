// A pair of line counts (`+81 −37`) as a small picture, so the colour shows
// in the GitHub app as well as on the web (ci#100). GitHub strips HTML
// colour, shows a diff block's colour only in a block, and the app shows
// math (`$\color…$`) as raw source, so what survives everywhere is an image
// of the coloured numbers: transparent background, +N in green and −N in
// red, the digits drawn as shapes (glyphs.mjs), since an image can't load a
// font. Two sizes of each pair: 14px for screens 768px wide and up, and 12px
// lifted 1px everywhere else (the app included), shown with one `<picture>`;
// the lift is in the image, as GitHub strips `style`. The alt text is the
// plain `+81 −37`. Pure: numbers in, text out; run.mjs attaches the files.
//
// Contrast is about 4.3:1 on GitHub's light and dark themes (3.4:1 dark
// dimmed); the + and − carry the meaning without the colour.
//
// A description also keeps an index of what it uploaded, so a later run can
// reuse an image instead of attaching it again: a hidden comment between
// `<!-- pr-changes:index -->` markers mapping each image's content hash to
// its link. The description is the PR author's to edit, so an index entry is
// only a claim: run.mjs fetches the link and compares the bytes' hash before
// trusting it, and every link must have GitHub's attachment form (isLink).

import { createHash } from 'node:crypto';
import { ownBlock } from './changes.mjs';
import { GLYPHS, RISE, SPACE, UNITS } from './glyphs.mjs';

/** The colours, as the owner picked them. */
export const GREEN = '#3d874d';
export const RED = '#b6605d';

/** The two sizes: pixels, how far the image lifts its digits, and the screens it is for. */
export const SIZES = /** @type {const} */ ([
  { size: 12, lift: 1 },
  { size: 14, lift: 0 },
]);

/** The screen width, in pixels, from which the larger image is shown. */
export const WIDE = 768;

/** What an attachment's link looks like, and so the only form a link may take. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const LINK = new RegExp(`^https://github\\.com/user-attachments/assets/${UUID}$`);

/** @param {string} text */
export const isLink = (text) => LINK.test(text);

/**
 * The plain text of a pair.
 *
 * @param {number} added
 * @param {number} removed
 */
export const pairText = (added, removed) => `+${added} −${removed}`;

/**
 * A character run as paths, in font units, from `x`.
 *
 * @param {string} text
 * @param {number} x
 * @param {string} fill
 * @returns {{ markup: string, end: number }}
 */
function run(text, x, fill) {
  let markup = '';
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    markup += `<path transform="translate(${x} 0)" fill="${fill}" d="${glyph.d}"/>`;
    x += glyph.advance;
  }
  return { markup, end: x };
}

/**
 * One size of a pair, as an SVG.
 *
 * @param {number} added
 * @param {number} removed
 * @param {{ size: number, lift: number }} look
 * @returns {string}
 */
export function svg(added, removed, { size, lift }) {
  const plus = run(`+${added}`, 0, GREEN);
  const minus = run(`−${removed}`, plus.end + SPACE, RED);
  const k = size / UNITS;
  const rise = Math.ceil(RISE * k);
  const width = Math.ceil(minus.end * k);
  const height = rise + lift;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<g transform="translate(0 ${rise}) scale(${k})">${plus.markup}${minus.markup}</g></svg>`
  );
}

/**
 * An image's content hash, which names it and keys the index.
 *
 * @param {string | Uint8Array} bytes
 */
export const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Both images of a pair.
 *
 * @param {number} added
 * @param {number} removed
 * @returns {{ size: number, svg: string, sha: string, file: string }[]} the
 *   file name is the hash and the size only, never from the PR
 */
export function images(added, removed) {
  return SIZES.map((look) => {
    const text = svg(added, removed, look);
    const sha = hashOf(text);
    return { size: look.size, svg: text, sha, file: `${sha}-${look.size}.svg` };
  });
}

/**
 * The markup of a pair from its two links: the smaller image everywhere, the
 * larger from WIDE up.
 *
 * @param {number} added
 * @param {number} removed
 * @param {{ small: string, large: string }} links
 */
export const picture = (added, removed, { small, large }) =>
  `<picture><source media="(min-width: ${WIDE}px)" srcset="${large}"><img src="${small}" alt="${pairText(added, removed)}"></picture>`;

/** The index's entries: a content hash, `=`, the link's id. */
const ENTRY = new RegExp(`(?<![0-9a-f])([0-9a-f]{64})=(${UUID})(?![0-9a-f-])`, 'g');
const PREFIX = 'https://github.com/user-attachments/assets/';
/** A staging block's line once gh has rewritten it: `![<hash>](<link>)`. */
const STAGED = /!\[([0-9a-f]{64})\]\((https:\/\/github\.com\/[^)\s]*)\)/g;

/**
 * What a description's index and staging block claim: image hash → link.
 * Only these two blocks are read, and a link only in its attachment form;
 * the claim is checked by fetching before it is used.
 *
 * @param {string} body
 * @returns {Map<string, string>}
 */
export function readIndex(body) {
  /** @type {Map<string, string>} */
  const found = new Map();
  const index = ownBlock(body, 'index');
  if (index) {
    for (const [, sha, id] of body.slice(index.from, index.to).matchAll(ENTRY)) {
      if (isLink(PREFIX + id)) found.set(sha, PREFIX + id);
    }
  }
  const staging = ownBlock(body, 'staging');
  if (staging) {
    const images = body.slice(staging.from, staging.to).matchAll(STAGED);
    for (const [, sha, link] of images) if (isLink(link)) found.set(sha, link);
  }
  return found;
}

/**
 * The index block's text for some entries: one hidden comment.
 *
 * @param {ReadonlyMap<string, string>} links image hash → link
 * @returns {string} empty for none
 */
export function indexText(links) {
  // In hash order, so the same links give the same text however they were found.
  const entries = [...links]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sha, link]) => `${sha}=${link.slice(PREFIX.length)}`);
  return entries.length === 0 ? '' : `<!-- ${entries.join(' ')} -->`;
}

/** How many characters an index entry takes: for the budget, before anything is uploaded. */
export const ENTRY_CHARS = 64 + 1 + 36 + 1;
