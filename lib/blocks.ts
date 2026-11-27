// Blocks a tool keeps in an issue's or a PR's description, each between a
// pair of HTML-comment markers named for the tool and the block
// (`<!-- pr-gif:<scenario> -->` … `<!-- /pr-gif:<scenario> -->`), so a later
// run finds its own block and replaces it in place, and leaves the rest of
// the description, someone else's words and other tools' blocks, as it was.
// gif/publish.ts (prefix `pr-gif`) and pictures/ (prefix `pictures`) use
// it. A marker left without its pair (an edit gone wrong) is never taken for
// a block: it stays as it is, with what follows it.

/** One tool's blocks, by key. */
export type Blocks = {
  /**
   * the markers around a key's block; throws for a key that could end the HTML comment a marker is
   * (a space, `<`, `>` or `--`)
   */
  markers: (key: string) => { start: string; end: string };
  /** where the key's block is, markers included, or null: the last start that an end follows */
  find: (body: string, key: string) => { from: number; to: number } | null;
  /**
   * the description with the key's block in it (`block` without its markers): in place of an
   * earlier one, or after the rest
   */
  write: (body: string, key: string, block: string) => string;
  /**
   * the description without the key's block, nor the blank line that kept it apart from what came
   * before; unchanged when it has none
   */
  remove: (body: string, key: string) => string;
  /** the keys of every block of this prefix in the description, in order */
  keys: (body: string) => string[];
};

/**
 * The blocks marked with `prefix`.
 *
 * @param prefix the tool's name in its markers: letters, digits, `-`
 * @param words how a refused key's
 *   error names it ("a scenario named") and where its block goes ("a PR
 *   description")
 */
export function blocksFor(
  prefix: string,
  { named = 'a block named', where = 'a description' }: { named?: string; where?: string } = {},
): Blocks {
  const markers = (key: string) => {
    if (!/^[^\s<>]+$/.test(key) || key.includes('--')) {
      throw new Error(
        `${prefix}: ${named} ${JSON.stringify(key)} can't mark its block in ${where}; rename it`,
      );
    }
    return { start: `<!-- ${prefix}:${key} -->`, end: `<!-- /${prefix}:${key} -->` };
  };

  const find = (body: string, key: string) => {
    const { start, end } = markers(key);
    for (
      let from = body.lastIndexOf(start);
      from !== -1;
      from = body.lastIndexOf(start, from - 1)
    ) {
      const to = body.indexOf(end, from);
      if (to !== -1) return { from, to: to + end.length };
      if (from === 0) break;
    }
    return null;
  };

  const write = (body: string, key: string, block: string) => {
    const { start, end } = markers(key);
    const marked = `${start}\n${block}\n${end}`;
    const found = find(body, key);
    if (found) return body.slice(0, found.from) + marked + body.slice(found.to);
    return body.trimEnd() ? `${body.trimEnd()}\n\n${marked}\n` : `${marked}\n`;
  };

  const remove = (body: string, key: string) => {
    const found = find(body, key);
    if (!found) return body;
    const head = body.slice(0, found.from).trimEnd();
    const tail = body.slice(found.to).replace(/^\n+/, '');
    return head && tail ? `${head}\n\n${tail}` : head || tail;
  };

  const opening = new RegExp(`<!-- ${prefix}:([^\\s<>]+) -->`, 'g');
  const keys = (body: string) => {
    const found = [...body.matchAll(opening)].map((m) => m[1]);
    return [...new Set(found)].filter((key) => {
      try {
        return find(body, key) !== null;
      } catch {
        // A name no marker of ours could hold (`--`): someone else's comment.
        return false;
      }
    });
  };

  return { markers, find, write, remove, keys };
}
