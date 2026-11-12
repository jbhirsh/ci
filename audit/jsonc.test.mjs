import { describe, expect, it } from 'vitest';
import { parseJsonc } from './jsonc.mjs';
import { APP_CONFIGS } from './test-app.mjs';

describe('parseJsonc', () => {
  it('drops line and block comments', () => {
    expect(parseJsonc('// a\n{ /* b */ "x": 1 // c\n}')).toEqual({ x: 1 });
    expect(parseJsonc('{"x": /* multi\nline */ [1]}')).toEqual({ x: [1] });
  });

  it('keeps comment markers and commas inside strings', () => {
    expect(parseJsonc('{"u": "https://a//b", "g": "/* not */", "c": ",]"}')).toEqual({
      u: 'https://a//b',
      g: '/* not */',
      c: ',]',
    });
  });

  it('reads escaped quotes inside strings', () => {
    expect(parseJsonc('{"q": "a \\"//\\" b", "s": "\\\\"} // x')).toEqual({
      q: 'a "//" b',
      s: '\\',
    });
  });

  it('reads past a byte-order mark', () => {
    expect(parseJsonc('\uFEFF{"a": 1}')).toEqual({ a: 1 });
  });

  it('drops trailing commas in objects and arrays, nested', () => {
    expect(parseJsonc('{"a": [1, 2, ], "b": {"c": [ {}, ], }, }')).toEqual({
      a: [1, 2],
      b: { c: [{}] },
    });
    expect(parseJsonc('[1, /* x */ ]')).toEqual([1]);
  });

  it.each(Object.entries(APP_CONFIGS))('reads %s', (_, text) => {
    const config = /** @type {Record<string, unknown>} */ (parseJsonc(text));
    expect(config.$schema).toBe('https://unpkg.com/knip@6/schema.json');
  });

  it.each([['{'], ['{"a": 1,, }'], ['/* open'], ['"unterminated'], ['']])(
    'throws a SyntaxError on %j',
    (text) => {
      expect(() => parseJsonc(text)).toThrow(SyntaxError);
    },
  );
});
