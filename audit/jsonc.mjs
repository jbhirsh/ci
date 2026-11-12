// Reads JSONC as knip reads its config (strip-json-comments with trailing
// commas): `//` and `/* */` comments outside strings and a comma before a
// closing `]` or `}` are dropped, then JSON.parse reads the rest. No
// dependency, as this repo has none for its audit (CLAUDE.md, "Runtime
// dependencies"). Invalid input throws JSON.parse's SyntaxError.

/**
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonc(text) {
  let out = '';
  // A byte-order mark, as some editors write, isn't JSON's.
  let i = text.startsWith('\uFEFF') ? 1 : 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      out += text.slice(start, i);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new SyntaxError('Unterminated comment in JSONC');
      out += ' ';
      i = end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(withoutTrailingCommas(out));
}

/**
 * Drops each comma that only whitespace separates from a closing `]` or
 * `}`, outside strings.
 *
 * @param {string} text comment-free JSON
 */
function withoutTrailingCommas(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      out += text.slice(start, i);
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === ']' || text[j] === '}') {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}
