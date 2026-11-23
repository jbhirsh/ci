// The "Against <app>" jobs run every `<tool>/selftest.mjs` after installing
// only this repo's runtime dependencies (`npm ci --omit=dev`), so a module a
// self-test loads, however indirectly, may import only node's built-ins, this
// repo's own modules and its `dependencies`. A devDependency passes this
// repo's own tests and fails every Against job (ci#141's first push reached
// yaml). The sync's own entry point is held to less still: its jobs install
// nothing, so it may reach no package at all.
//
// It follows `import … from`, `export … from` and `import('…')` with a
// literal specifier, comments aside (a JSDoc `import('x')` type is no import).
// It can't see a specifier built at run time, `createRequire`, or
// lib/app.mjs's importFromApp, which loads from the app on purpose.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CI_ROOT } from '../sync/manifest.mjs';

/** A static import or re-export, or a dynamic import of a literal. */
const IMPORT =
  /^\s*(?:import|export)\s(?:[^'";]*?\sfrom\s)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;

/**
 * A module's text without its comments, so a JSDoc type isn't read as an
 * import. Naive about a comment marker inside a string, which only hides an
 * import that sits on the same line.
 *
 * @param {string} text
 */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

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
  for (const match of code(readFileSync(file, 'utf8')).matchAll(IMPORT)) {
    const specifier = match[1] ?? match[2];
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
const selftests = readdirSync(CI_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
  .map((entry) => path.join(CI_ROOT, entry.name, 'selftest.mjs'))
  .filter((file) => existsSync(file));

describe('what the self-tests import', () => {
  it('lets the sync reach no package: its jobs install none', () => {
    expect([...packagesOf(path.join(CI_ROOT, 'sync/sync.mjs'))]).toEqual([]);
  });

  it('reads every import form, and no comment', () => {
    expect(selftests.map((file) => path.relative(CI_ROOT, file))).toContain('sync/selftest.mjs');
    expect(packagesOf(path.join(CI_ROOT, 'sync/content.test.mjs')).get('yaml')).toBe(
      'sync/content.test.mjs',
    );
    // gif/cli.mjs names playwright only in JSDoc types.
    expect(packagesOf(path.join(CI_ROOT, 'gif/cli.mjs')).has('playwright')).toBe(false);
    expect(code("a(); // import 'x'\n/* import('y') */ import('z');")).toBe("a(); \n import('z');");
    expect(
      [...code("import('p');\nexport { q } from 'q';\n").matchAll(IMPORT)].map((m) => m[1] ?? m[2]),
    ).toEqual(['p', 'q']);
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
