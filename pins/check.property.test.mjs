import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { caretFor, ignoreFilesArgs, isPinnedRange, pinOnLine, rangeOf } from './check.mjs';

// A package.json, a workflow or a comment is whatever someone wrote.
describe('the parsers, for any text', () => {
  it('never throw', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        pinOnLine(text);
        ignoreFilesArgs(text);
        caretFor(text);
        const range = rangeOf(text);
        if (range !== null) isPinnedRange(range);
      }),
    );
  });

  it('never call a caret a pin, and always offer one in place of a pinned version', () => {
    const version = fc
      .tuple(fc.nat(99), fc.nat(99), fc.nat(99))
      .map(([a, b, c]) => `${a}.${b}.${c}`);
    fc.assert(
      fc.property(version, fc.constantFrom('', '~', '='), (v, op) => {
        expect(isPinnedRange(`^${v}`)).toBe(false);
        expect(isPinnedRange(`${op}${v}`)).toBe(true);
        expect(caretFor(`${op}${v}`)).toBe(`^${v}`);
        expect(isPinnedRange(caretFor(`${op}${v}`) ?? '')).toBe(false);
      }),
    );
  });
});

/**
 * A glob as a script would write it, single-quoted, double-quoted (its
 * `"`, `\\`, `$` and backquote escaped) or bare (every character that isn't
 * a glob's or a path's escaped).
 *
 * @param {string} glob
 * @param {'single' | 'double' | 'bare'} quoting
 */
function quote(glob, quoting) {
  if (quoting === 'single') return `'${glob}'`;
  if (quoting === 'double') return `"${glob.replace(/["\\$`]/g, '\\$&')}"`;
  return glob.replace(/[^\w*?/.,{}[\]@+=-]/g, '\\$&');
}

// A script is whatever someone wrote in package.json.
describe('ignoreFilesArgs, for any glob however it is quoted', () => {
  const glob = fc.string({ minLength: 1 });
  const arg = fc.tuple(
    glob,
    fc.constantFrom(/** @type {const} */ ('single'), 'double', 'bare'),
    fc.boolean(),
  );
  /** @param {[string, string, boolean]} arg */
  const safe = ([text, quoting]) => !(quoting === 'single' && text.includes("'"));

  it("reads back every glob given to type-coverage, in order, and no other command's", () => {
    fc.assert(
      fc.property(
        fc.array(arg.filter(safe), { maxLength: 5 }),
        fc.constantFrom(
          'type-coverage',
          'node_modules/type-coverage/bin/type-coverage',
          'npx type-coverage@2',
        ),
        fc.constantFrom('&&', '||', ';', '|', '\n'),
        (args, bin, op) => {
          const flags = args.map(([text, quoting, equals]) =>
            equals
              ? `--ignore-files=${quote(text, quoting)}`
              : `--ignore-files ${quote(text, quoting)}`,
          );
          const script = `${bin} -p tsconfig.json ${flags.join(' ')} ${op} eslint --ignore-files other`;
          expect(ignoreFilesArgs(script)).toEqual(args.map(([text]) => text));
        },
      ),
    );
  });
});
