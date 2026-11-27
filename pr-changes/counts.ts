// A pair of line counts (`+81 −37`) as a small picture, so the colour shows
// in the GitHub app as well as on the web (ci#100). GitHub strips HTML
// colour, shows a diff block's colour only in a block, and the app shows
// math (`$\color…$`) as raw source, so what survives everywhere is an image
// of the coloured numbers: transparent background, +N in green and −N in
// red, the digits drawn as shapes (glyphs.ts), since an image can't load a
// font. Two sizes of each pair: 14px for screens 768px wide and up, and 12px
// lifted 1px everywhere else (the app included), shown with one `<picture>`;
// the lift is in the image, as GitHub strips `style`. The alt text is the
// plain `+81 −37`. Pure: numbers in, text out; run.ts attaches the files.
//
// Contrast is about 4.3:1 on GitHub's light and dark themes (3.4:1 dark
// dimmed); the + and − carry the meaning without the colour.
//
// A description also keeps an index of what it uploaded, so a later run can
// reuse an image instead of attaching it again: a hidden comment between
// `<!-- pr-changes:index -->` markers mapping each image's content hash to
// its link. The description is the PR author's to edit, so an index entry is
// only a claim: run.ts fetches the link and compares the bytes' hash before
// trusting it, and every link must have GitHub's attachment form (isLink).

import { createHash } from 'node:crypto';
import { ownBlock } from './changes.ts';
import { GLYPHS, RISE, SPACE, UNITS } from './glyphs.ts';

/** The colours, as the owner picked them. */
export const GREEN = '#3d874d';
export const RED = '#b6605d';

/** The two sizes: pixels, how far the image lifts its digits, and the screens it is for. */
export const SIZES = [
  { size: 12, lift: 1 },
  { size: 14, lift: 0 },
] as const;

/** The screen width, in pixels, from which the larger image is shown. */
export const WIDE = 768;

/** What an attachment's link looks like, and so the only form a link may take. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const LINK = new RegExp(`^https://github\\.com/user-attachments/assets/${UUID}$`);

export const isLink = (text: string) => LINK.test(text);

/**
 * The plain text of a pair.
 */
export const pairText = (added: number, removed: number) => `+${added} −${removed}`;

/**
 * A character run as paths, in font units, from `x`.
 */
function run(text: string, x: number, fill: string): { markup: string; end: number } {
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
 */
export function svg(
  added: number,
  removed: number,
  { size, lift }: { size: number; lift: number },
): string {
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
 */
export const hashOf = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * Both images of a pair.
 *
 * @returns each size's image, whose file name is the hash and the size only,
 *   never from the PR
 */
export function images(
  added: number,
  removed: number,
): { size: number; svg: string; sha: string; file: string }[] {
  return SIZES.map((look) => {
    const text = svg(added, removed, look);
    const sha = hashOf(text);
    return { size: look.size, svg: text, sha, file: `${sha}-${look.size}.svg` };
  });
}

/**
 * The markup of a pair from its two links: the smaller image everywhere, the
 * larger from WIDE up.
 */
export const picture = (
  added: number,
  removed: number,
  { small, large }: { small: string; large: string },
) =>
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
 */
export function readIndex(body: string): Map<string, string> {
  const found: Map<string, string> = new Map();
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
 * @param links image hash → link
 * @returns empty for none
 */
export function indexText(links: ReadonlyMap<string, string>): string {
  // In hash order, so the same links give the same text however they were found.
  const entries = [...links]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sha, link]) => `${sha}=${link.slice(PREFIX.length)}`);
  return entries.length === 0 ? '' : `<!-- ${entries.join(' ')} -->`;
}

/** How many characters an index entry takes: for the budget, before anything is uploaded. */
export const ENTRY_CHARS = 64 + 1 + 36 + 1;
