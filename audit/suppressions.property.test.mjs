import ts from '@typescript/typescript6';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { knipSuppressions, suppressionTags } from './suppressions.mjs';

// A knip config is whatever the app wrote: any JSON, weighted towards the
// options the scan reads.
const key = fc.oneof(
  fc.constantFrom('ignore', 'ignoreDependencies', 'rules', 'cycles', 'project', 'workspaces'),
  fc.constantFrom('include', 'tags', 'entry', 'expo', 'allow', 'config'),
  fc.string(),
);
const config = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.jsonValue({ maxDepth: 1 }),
    fc.array(tie('value'), { maxLength: 3 }),
    fc.dictionary(key, tie('value'), { maxKeys: 4 }),
  ),
})).value;

describe('knipSuppressions, for any config', () => {
  it('never throws, and reports only paths the config has', () => {
    fc.assert(
      fc.property(config, fc.array(fc.string(), { maxLength: 3 }), (value, tracked) => {
        for (const { path } of knipSuppressions(value, tracked)) {
          /** @type {unknown} */
          let at = value;
          for (const step of path) {
            expect(typeof at === 'object' && at !== null && Object.hasOwn(at, step)).toBe(true);
            at = /** @type {Record<string, unknown>} */ (at)[step];
          }
        }
      }),
    );
  });
});

describe('suppressionTags, for any source', () => {
  const source = fc
    .array(
      fc.oneof(
        fc.string(),
        fc.constantFrom('/*', '*/', '//', '\n', '"', "'", '`', '\\', '@public', '@beta'),
      ),
    )
    .map((parts) => parts.join(''));

  it('never throws, and every line it reports is in the file', () => {
    fc.assert(
      fc.property(source, (text) => {
        const lines = text.split('\n').length;
        for (const { tag, line } of suppressionTags(text, ts)) {
          expect(['@public', '@beta', '@alias']).toContain(tag);
          expect(line >= 1 && line <= lines).toBe(true);
        }
      }),
    );
  });
});
