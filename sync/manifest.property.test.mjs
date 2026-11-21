import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  APPS,
  companionProblem,
  manifestProblems,
  parseManifest,
  pathProblem,
} from './manifest.mjs';

// A path is whatever a manifest's author typed: build it from the pieces the
// rules treat specially.
const piece = fc.constantFrom(
  'a',
  'b.yml',
  '.github',
  '.GIT',
  '..',
  '.',
  '',
  '/',
  '\\',
  'C:',
  '\0',
  ' ',
  '\u202E',
  '\u200B',
);
const text = fc.array(piece, { maxLength: 8 }).map((parts) => parts.join('/'));

describe('pathProblem, for any input', () => {
  it('never throws, and answers with a message or null', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const problem = pathProblem(value);
        expect(problem === null || typeof problem === 'string').toBe(true);
      }),
    );
  });

  it('accepts only paths that stay inside the checkout', () => {
    fc.assert(
      fc.property(fc.oneof(text, fc.string()), (value) => {
        if (pathProblem(value) !== null) return;
        const segments = value.split('/');
        expect(segments.every((s) => s !== '' && s !== '.' && s !== '..')).toBe(true);
        expect(value.startsWith('/') || value.includes('\\')).toBe(false);
        expect(/[\p{Cc}\p{Cf}]/u.test(value)).toBe(false);
        expect(segments[0].toLowerCase()).not.toBe('.git');
      }),
    );
  });
});

describe('manifestProblems, for any JSON', () => {
  it('never throws, and lists problems as strings', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const problems = manifestProblems(value);
        expect(problems.every((p) => typeof p === 'string' && p !== '')).toBe(true);
      }),
    );
  });

  it('answers the same for a value and for its text', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const problems = manifestProblems(value);
        if (problems.length === 0) {
          expect(() => parseManifest(JSON.stringify(value))).not.toThrow();
        } else {
          expect(() => parseManifest(JSON.stringify(value))).toThrow();
        }
      }),
    );
  });
});

// Entries built to be valid: whatever the paths and reasons, they pass, and
// listing one twice never does.
const name = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/);
const file = fc.record({
  path: fc.array(name, { minLength: 1, maxLength: 3 }).map((s) => s.join('/')),
  source: fc.array(name, { minLength: 1, maxLength: 3 }).map((s) => `sync/${s.join('/')}`),
  apps: fc.subarray(APPS, { minLength: 1 }),
});

describe('manifestProblems, for entries built to be valid', () => {
  it('accepts them when their paths differ', () => {
    fc.assert(
      fc.property(fc.uniqueArray(file, { selector: (f) => f.path, maxLength: 5 }), (files) => {
        expect(manifestProblems({ files, unsynced: [] })).toEqual([]);
      }),
    );
  });

  it('refuses the same entry listed twice', () => {
    fc.assert(
      fc.property(file, (f) => {
        expect(manifestProblems({ files: [f, f], unsynced: [] })).toHaveLength(1);
      }),
    );
  });
});

// An app's settings are whatever its owner wrote: any JSON object.
const settings = fc.dictionary(fc.string(), fc.jsonValue());
const key = fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 4 });

describe('companionProblem, for any settings and key', () => {
  it('never throws, and answers with a message or null', () => {
    fc.assert(
      fc.property(settings, key, (config, path) => {
        const problem = companionProblem(config, path);
        expect(problem === null || typeof problem === 'string').toBe(true);
      }),
    );
  });

  it('says nothing is in the way when every folder on the way is an object or missing', () => {
    fc.assert(
      fc.property(key, fc.jsonValue(), (path, leaf) => {
        // Nest the path's folders as objects, and put anything where the key goes.
        /** @type {Record<string, unknown>} */
        const config = {};
        let at = config;
        for (const segment of path.slice(0, -1)) {
          /** @type {Record<string, unknown>} */
          const next = {};
          Object.defineProperty(at, segment, { value: next, enumerable: true });
          at = next;
        }
        Object.defineProperty(at, path[path.length - 1], { value: leaf, enumerable: true });
        expect(companionProblem(config, path)).toBeNull();
      }),
    );
  });

  it('names the first folder on the way that is not an object', () => {
    fc.assert(
      fc.property(
        key,
        fc.oneof(fc.constant(null), fc.string(), fc.integer(), fc.array(fc.string())),
        (path, blocker) => {
          fc.pre(path.length > 1);
          const config = { [path[0]]: blocker };
          expect(companionProblem(config, path)).toContain(`"${path[0]}" is not an object`);
        },
      ),
    );
  });
});
