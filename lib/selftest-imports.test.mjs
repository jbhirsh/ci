// The "Against <app>" jobs run every tool's self-test (lib/selftests.mjs
// lists them, `selftest.mjs` or `selftest.ts`) after installing only this
// repo's runtime dependencies (`npm ci --omit=dev`), so a module a self-test
// loads, however indirectly, may import only node's built-ins, this repo's
// own modules and its `dependencies`. A devDependency passes this repo's own
// tests and fails every Against job (ci#141's first push reached yaml). The
// sync's own entry point is held to less still: its jobs install nothing, so
// it may reach no package at all.
//
// It follows `import … from`, `export … from` and `import('…')` with a
// literal specifier, in `.mjs` and `.ts` alike, comments aside (a JSDoc
// `import('x')` type is no import). What Node erases before it runs a `.ts`
// file loads nothing, so it is skipped: `import type` and `export type`, and
// in a `.ts` file `typeof import('x')` and `import('x').T`, which are types
// there (a call such as `import('x').then(…)` is still an import). An
// import whose names are all marked `type` (`import { type X } from 'x'`)
// still loads x: Node leaves `import {} from 'x'`, as TypeScript's
// `verbatimModuleSyntax` does. It can't see a
// specifier built at run time, `createRequire`, or lib/app.mjs's
// importFromApp, which loads from the app on purpose.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CI_ROOT } from '../sync/manifest.mjs';
import { findSelftests } from './selftests.mjs';

/** A static import or re-export, with what it imports (its clause). */
const STATIC = /^\s*(?:import|export)\s(?:([^'";]*?)\sfrom\s)?\s*['"]([^'"]+)['"]/gm;

/** A dynamic import of a literal, with `typeof` before it and a member after. */
const DYNAMIC =
  /(\btypeof\s+)?\bimport\(\s*['"]([^'"]+)['"]\s*\)((?:\s*\.\s*[A-Za-z_$][\w$]*)+\s*(?:<[^()]*>\s*)?\(?)?/g;

/**
 * A module's text without its comments, so a JSDoc type isn't read as an
 * import. Naive about a comment marker inside a string, which only hides an
 * import that sits on the same line.
 *
 * @param {string} text
 */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/**
 * Whether a static import's clause is erased whole: `type X`, `type { X }`,
 * `type * as X`. Braces whose every name is marked `type` are not: the
 * import stays, with no names.
 *
 * @param {string} clause
 */
const typeOnly = (clause) => /^type\s+[\w${*]/.test(clause.trim());

/**
 * The specifiers a module loads at run time.
 *
 * @param {string} text the module's source
 * @param {boolean} ts whether it is TypeScript, where `import('x').T` is a type
 * @returns {string[]}
 */
function specifiers(text, ts) {
  const source = code(text);
  /** @type {string[]} */
  const found = [];
  for (const [, clause, specifier] of source.matchAll(STATIC)) {
    if (clause === undefined || !typeOnly(clause)) found.push(specifier);
  }
  for (const [, typeOf, specifier, member] of source.matchAll(DYNAMIC)) {
    const asType = typeOf !== undefined || (member !== undefined && !member.endsWith('('));
    if (!(ts && asType)) found.push(specifier);
  }
  return found;
}

/**
 * The packages a module and everything it imports import.
 *
 * @param {string} file an absolute path to a module of this repo
 * @param {Set<string>} [seen]
 * @returns {Map<string, string>} each package, with the module that imports it
 */
function packagesOf(file, seen = new Set()) {
  /** @type {Map<string, string>} */
  const found = new Map();
  if (seen.has(file)) return found;
  seen.add(file);
  for (const specifier of specifiers(readFileSync(file, 'utf8'), file.endsWith('.ts'))) {
    if (specifier.startsWith('.')) {
      for (const [name, from] of packagesOf(path.resolve(path.dirname(file), specifier), seen)) {
        if (!found.has(name)) found.set(name, from);
      }
    } else if (!specifier.startsWith('node:')) {
      const parts = specifier.split('/');
      const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      if (!found.has(name)) found.set(name, path.relative(CI_ROOT, file));
    }
  }
  return found;
}

const runtime = Object.keys(
  JSON.parse(readFileSync(path.join(CI_ROOT, 'package.json'), 'utf8')).dependencies,
);
const selftests = findSelftests(CI_ROOT).files.map((file) => path.join(CI_ROOT, file));

describe('what the self-tests import', () => {
  it('lets the sync reach no package: its jobs install none', () => {
    expect([...packagesOf(path.join(CI_ROOT, 'sync/sync.mjs'))]).toEqual([]);
  });

  it('reads every import form, and no comment', () => {
    expect(selftests.map((file) => path.relative(CI_ROOT, file))).toContain('sync/selftest.mjs');
    expect(packagesOf(path.join(CI_ROOT, 'sync/content.test.mjs')).get('yaml')).toBe(
      'sync/content.test.mjs',
    );
    // gif/cli.ts names playwright only in types (`import type`, `typeof import`).
    expect(packagesOf(path.join(CI_ROOT, 'gif/cli.ts')).has('playwright')).toBe(false);
    expect(code("a(); // import 'x'\n/* import('y') */ import('z');")).toBe("a(); \n import('z');");
    expect(specifiers("import('p');\nexport { q } from 'q';\nimport 'r';\n", false)).toEqual([
      'q',
      'r',
      'p',
    ]);
  });

  it('skips what Node erases from a .ts file, and keeps what it runs', () => {
    const ts = [
      "import type { A } from 'erased-a';",
      "import type B from 'erased-b';",
      "export type { C } from 'erased-c';",
      "export type * from 'erased-d';",
      "import { type E, type F } from 'kept-e';",
      "export { type E2 } from 'kept-e2';",
      "import { type G, h } from 'kept-g';",
      "import I, { type J } from 'kept-i';",
      "import type from 'kept-type';",
      "import { typeName } from 'kept-typename';",
      "import * as K from './kept-k.ts';",
      "export { L } from '../kept-l.mjs';",
      "let m: typeof import('erased-m');",
      "let n: import('erased-n').N;",
      "let o: import('erased-o').P.Q<string>;",
      "const r = await import('kept-r');",
      "import('kept-s').then((s) => s);",
      "import('kept-t').default.u();",
      "import('kept-v').then<number>((v) => 1);",
    ].join('\n');
    const kept = [
      'kept-e',
      'kept-e2',
      'kept-g',
      'kept-i',
      'kept-type',
      'kept-typename',
      './kept-k.ts',
      '../kept-l.mjs',
      'kept-r',
      'kept-s',
      'kept-t',
      'kept-v',
    ];
    expect(specifiers(ts, true)).toEqual(kept);
    // Outside comments, in a .mjs file, `import('x').T` is a property read
    // of a promise, and still loads x.
    expect(specifiers("const n = import('loaded-n').N;", false)).toEqual(['loaded-n']);
    expect(specifiers("const n = import('loaded-n').N;", true)).toEqual([]);
  });

  it('reads an import clause as erased only when it is marked type whole', () => {
    expect(typeOnly('type { A }')).toBe(true);
    expect(typeOnly(' type * as A ')).toBe(true);
    expect(typeOnly('{ type A, type B as C }')).toBe(false);
    expect(typeOnly('{ type A, b }')).toBe(false);
    expect(typeOnly('{}')).toBe(false);
    expect(typeOnly('type')).toBe(false);
    expect(typeOnly('types')).toBe(false);
    expect(typeOnly('* as type')).toBe(false);
  });

  it.each(selftests.map((file) => [path.relative(CI_ROOT, file), file]))(
    '%s reaches only node, this repo and its runtime dependencies',
    (_name, file) => {
      const outside = [...packagesOf(file)]
        .filter(([name]) => !runtime.includes(name))
        .map(([name, from]) => `${name} (imported by ${from})`);
      expect(
        outside,
        'the Against jobs install only runtime dependencies: move the import out of what the self-test loads',
      ).toEqual([]);
    },
  );
});
