import { spawnSync } from 'node:child_process';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_BRANCH, PREFIX, parseBranch, parseNamedFiles } from './branch.mjs';

// BRANCH and FILES are whatever the dispatcher typed: any text, and text
// built from the pieces another ref, an option, a glob or a way out of the
// folder is made of.
const piece = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.constantFrom(
    'pictures/',
    'pictures',
    'refs/heads/',
    'main',
    '/',
    '..',
    '.',
    '-',
    '--',
    '_',
    'a',
    'Z9',
    '.lock',
    ' ',
    '\n',
    '\t',
    '\0',
    '*',
    '?',
    '[',
    '~',
    '^',
    ':',
    '@{',
    '\\',
    '|',
    'é',
    'a.png',
  ),
);
const text = fc.oneof(
  fc.string(),
  fc.array(piece, { maxLength: 12 }).map((parts) => parts.join('')),
  fc.array(piece, { maxLength: 12 }).map((parts) => `pictures/${parts.join('')}`),
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

/** git's own reading of a branch name, with none of the hooks' GIT_* variables. */
function gitTakes(/** @type {string} */ branch) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  return spawnSync('git', ['check-ref-format', `refs/heads/${branch}`], { env }).status === 0;
}

describe('parseBranch, for any BRANCH', () => {
  it('refuses with its own error, or returns one pictures/<name> that names no other ref', () => {
    /** @type {string[]} */
    const taken = [];
    fc.assert(
      fc.property(text, (value) => {
        const branch = ownRefusal(() => parseBranch(value));
        if (branch === null) return;
        expect(branch).toBe(value);
        expect(branch.startsWith(PREFIX)).toBe(true);
        expect(branch.length).toBeLessThanOrEqual(MAX_BRANCH);
        const name = branch.slice(PREFIX.length);
        // One segment of plain characters: no /, space, glob, option or ref syntax.
        expect(name).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
        expect(name).not.toMatch(/\.\.|--|\.$|\.lock$/);
        taken.push(branch);
      }),
      { numRuns: 2000 },
    );
    // A few of those taken, checked with git too: one process each, so a
    // handful, never one per run (the fixed table below covers the rest).
    for (const branch of [...new Set(taken)].slice(0, 5)) {
      expect(gitTakes(branch), branch).toBe(true);
    }
  });

  it.each([
    'pictures/a',
    'pictures/Z9',
    'pictures/_x',
    'pictures/0',
    'pictures/sift_249.v2',
    'pictures/a.b-c_d',
    'pictures/ci-132-revisions',
    'pictures/a.lockx',
  ])('takes %s, which git takes too', (branch) => {
    expect(parseBranch(branch)).toBe(branch);
    expect(gitTakes(branch)).toBe(true);
  });

  it('takes exactly the names of word characters, . and - that start with one and have no -- or ..', () => {
    const name = fc
      .array(fc.constantFrom('a', 'Z', '0', '_', '.', '-'), { minLength: 1, maxLength: 20 })
      .map((c) => c.join(''));
    fc.assert(
      fc.property(name, (n) => {
        const branch = `${PREFIX}${n}`;
        const plain = /^\w/.test(n) && !/\.\.|--|\.$|\.lock$/.test(n);
        expect(ownRefusal(() => parseBranch(branch)) !== null).toBe(plain);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('parseNamedFiles, for any FILES', () => {
  it('refuses with its own error, or returns plain relative paths with no segment an option or hidden', () => {
    fc.assert(
      fc.property(text, (value) => {
        const files = ownRefusal(() => parseNamedFiles(value));
        if (files === null) return;
        for (const { path } of files) {
          expect(path).not.toMatch(/^\//);
          expect(path).toMatch(/^[\w.-]+(\/[\w.-]+)*$/);
          for (const segment of path.split('/')) {
            expect(segment).not.toMatch(/^[-.]/);
          }
        }
      }),
      { numRuns: 2000 },
    );
  });
});
