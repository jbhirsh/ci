import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseBlock, parseFiles } from './inputs.mjs';

// FILES and BLOCK are whatever the dispatcher typed: any text, and text
// built from the pieces a way out of the folder is made of.
const piece = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom(
    '/',
    '..',
    '.',
    '|',
    '\n',
    '\r',
    '\r\n',
    '\0',
    '\\',
    ' ',
    'a.png',
    '--',
    '<',
    '>',
    'C:',
  ),
);
const text = fc.oneof(
  fc.string(),
  fc.array(piece, { maxLength: 16 }).map((parts) => parts.join('')),
);

/**
 * Runs `parse`, returning what it gives or null for its own refusal; any
 * other error (a TypeError, say) fails the property.
 *
 * @template T
 * @param {() => T} parse
 * @returns {T | null}
 */
function ownRefusal(parse) {
  try {
    return parse();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(/** @type {Error} */ (error).constructor).toBe(Error);
    expect(/** @type {Error} */ (error).message).toMatch(/^pictures: /);
    return null;
  }
}

describe('parseFiles, for any FILES', () => {
  it('refuses only with its own error, and never returns a path out of the folder', () => {
    const root = path.resolve('/artifact');
    fc.assert(
      fc.property(text, (value) => {
        const files = ownRefusal(() => parseFiles(value));
        if (!files) return;
        expect(files.length).toBeGreaterThan(0);
        for (const { path: file, caption } of files) {
          expect(path.isAbsolute(file)).toBe(false);
          expect(file).not.toContain('..');
          expect(file).not.toContain('\0');
          expect(file).not.toContain('\\');
          expect(path.resolve(root, file).startsWith(root + path.sep)).toBe(true);
          expect(caption).not.toBe('');
          expect(caption).not.toMatch(/[\r\n]/);
        }
      }),
    );
  });
});

describe('parseBlock, for any BLOCK', () => {
  it('refuses only with its own error, and never returns a name that could end a marker', () => {
    fc.assert(
      fc.property(text, (value) => {
        const block = ownRefusal(() => parseBlock(value));
        if (block === null) return;
        expect(block).not.toContain('--');
        expect(block).not.toMatch(/[\s<>]/);
        expect(block).not.toBe('');
      }),
    );
  });
});
