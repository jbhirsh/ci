import type { Picture } from './inputs.ts';

// The two blocks pictures/cli.ts writes. In the host PR's description, one
// `![path](./path)` line a picture: the form gh's `--attach` rewrites in
// place with each upload's URL (ci#33's trial T1, BoardGames#309), read back
// in the same order. Its alt text is the file's path, which inputs.ts keeps
// to plain name characters, so nothing in it can end the link or add one.
// In the target's description, a table of `<img>` tags pointing at those
// URLs, `columns` wide, each at `width` pixels (Markdown images can't take a
// width): a row of captions, then the row of their pictures.
//
// A caption is plain text, whatever the dispatcher wrote: a line break
// becomes a space, `&`, `<`, `>`, `"` and `|` (which would end a table
// cell) become HTML entities, and in a cell, where the text is Markdown, a
// backslash goes before each mark that formats inline Markdown, so none
// formats it or ends the bold around it.

/**
 * A caption as text in an HTML attribute: on one line, with no character
 * that ends the attribute, the tag or the table cell.
 */
export function escapeCaption(caption: string) {
  return caption
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('|', '&#124;');
}

/**
 * A caption as a table cell's text: escaped as for an attribute, and each
 * mark that formats inline Markdown (a cell holds no blocks) backslashed,
 * so it shows as written.
 */
export function cellText(caption: string) {
  return escapeCaption(caption.replace(/[\\`*_[\]()!~]/g, '\\$&'));
}

/**
 * The host PR's block: a line saying what it's for, then each picture by its
 * local path, for gh to upload and link.
 */
export function hostBlock(
  files: readonly Picture[],
  { target, runId }: { target: string; runId: string },
) {
  return [
    `Pictures for #${target}, from run ${runId}.`,
    '',
    ...files.map((f) => `![${f.path}](./${f.path})`),
  ].join('\n');
}

/**
 * One picture's cell.
 */
export function imageCell(url: string, caption: string, width: number) {
  return `<img src="${url}" width="${width}" alt="${escapeCaption(caption)}">`;
}

/**
 * The target's table: `columns` pictures a row, each row's captions above
 * it (the first as the table's header, the rest in bold), the last row's
 * empty cells left blank.
 */
export function pictureTable(
  pictures: readonly { url: string; caption: string }[],
  { columns, width }: { columns: number; width: number },
) {
  const n = Math.min(columns, pictures.length);
  const row = (cells: string[]) =>
    `| ${[...cells, ...Array(n - cells.length).fill('')].join(' | ')} |`;
  const lines: string[] = [];
  for (let i = 0; i < pictures.length; i += n) {
    const chunk = pictures.slice(i, i + n);
    const captions = chunk.map((p) => cellText(p.caption));
    if (i === 0) lines.push(row(captions), row(Array(n).fill('---')));
    else lines.push(row(captions.map((c) => `**${c}**`)));
    lines.push(row(chunk.map((p) => imageCell(p.url, p.caption, width))));
  }
  return lines.join('\n');
}
