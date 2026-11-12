import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseJsonc } from './jsonc.mjs';

/**
 * JSON text with a comment or whitespace after each structural token, and a
 * trailing comma before each closing bracket of a non-empty array or object.
 *
 * @param {string} json
 * @param {string[]} fillers what to put after each token, in turn
 */
function commented(json, fillers) {
  let out = '';
  let n = 0;
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inString) {
      out += c;
      if (c === '\\') out += json[++i];
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if ((c === ']' || c === '}') && !'[{'.includes(json[i - 1])) out += ',';
    out += c;
    if ('[]{},:'.includes(c)) out += fillers[n++ % fillers.length];
  }
  return out;
}

const filler = fc.constantFrom(
  ' ',
  '\n',
  '\t',
  ' // a comment, with "quotes"\n',
  '/* a, comment */',
  '/**/',
);

describe('parseJsonc', () => {
  it('reads back any JSON value, however commented and with trailing commas', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.array(filler, { minLength: 1 }), (value, fillers) => {
        const text = commented(JSON.stringify(value), fillers);
        expect(parseJsonc(text)).toEqual(JSON.parse(JSON.stringify(value)));
      }),
    );
  });

  it('returns or throws a SyntaxError on any text, never anything else', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        try {
          parseJsonc(text);
        } catch (error) {
          expect(error).toBeInstanceOf(SyntaxError);
        }
      }),
    );
  });
});
