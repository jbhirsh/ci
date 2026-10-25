import { describe, expect, it } from 'vitest';
import { jscpdFindings, knipFindings, lycheeFindings } from './report.mjs';

/**
 * @param {string} file
 * @param {Record<string, unknown>} fields
 */
const knipIssue = (file, fields) => ({
  file,
  owners: [],
  dependencies: [],
  exports: [],
  files: [],
  types: [],
  ...fields,
});

describe('knipFindings', () => {
  it('is empty when knip found nothing', () => {
    expect(knipFindings({ issues: [] }, 'knip.json')).toEqual({ count: 0, markdown: '' });
    expect(knipFindings({}, 'knip.json').count).toBe(0);
    expect(knipFindings(null, 'knip.json').count).toBe(0);
    expect(knipFindings({ issues: [knipIssue('src/a.ts', {})] }, 'knip.json').count).toBe(0);
  });

  it('groups findings by type, naming each with its file and line', () => {
    const { count, markdown } = knipFindings(
      {
        issues: [
          knipIssue('package.json', { dependencies: [{ name: 'left-pad', line: 22, col: 6 }] }),
          knipIssue('src/utils/chorus.ts', {
            exports: [
              { name: 'WINDOW_START', line: 3 },
              { name: 'WINDOW_END', line: 4 },
            ],
            types: [{ name: 'ChorusMethod', line: 9 }],
          }),
          knipIssue('scripts/old.mjs', { files: [{ name: 'scripts/old.mjs' }] }),
          knipIssue('app.json', { unlisted: [{ name: 'expo-system-ui' }] }),
        ],
      },
      'knip.jsonc',
    );
    expect(count).toBe(6);
    expect(markdown).toContain('### Unused dependencies (1)\n\n- `left-pad` in `package.json:22`');
    expect(markdown).toContain(
      '### Unused exports (2)\n\n- `WINDOW_START` in `src/utils/chorus.ts:3`\n- `WINDOW_END` in `src/utils/chorus.ts:4`',
    );
    expect(markdown).toContain(
      '### Unused exported types (1)\n\n- `ChorusMethod` in `src/utils/chorus.ts:9`',
    );
    // An unused file is the finding itself, with no name beside it.
    expect(markdown).toContain('### Unused files (1)\n\n- `scripts/old.mjs`');
    // Without a line, just the file.
    expect(markdown).toContain('### Unlisted dependencies (1)\n\n- `expo-system-ui` in `app.json`');
    expect(markdown.startsWith('[knip](https://knip.dev) found')).toBe(true);
    expect(markdown).toContain('say so in `knip.jsonc`');
  });

  it('reports a duplicate export or a cycle, a list of items, as one finding', () => {
    const { markdown } = knipFindings(
      {
        issues: [
          knipIssue('src/utils/a.ts', {
            duplicates: [
              [
                { name: 'foo', line: 3 },
                { name: 'default', line: 9 },
              ],
            ],
          }),
          knipIssue('src/b.ts', { cycles: [[{ name: 'src/b.ts' }, { name: 'src/c.ts' }]] }),
        ],
      },
      'knip.json',
    );
    expect(markdown).toContain(
      '### Duplicate exports (1)\n\n- `foo`, `default` in `src/utils/a.ts:3`',
    );
    expect(markdown).toContain(
      '### Circular dependencies (1)\n\n- `src/b.ts`, `src/c.ts` in `src/b.ts`',
    );
  });

  it("reads older knip's shapes: top-level files, file flags, members by parent", () => {
    const report = {
      files: ['src/dead.ts', 'src/gone.ts'],
      issues: [
        {
          file: 'package.json',
          owners: ['@me'],
          dependencies: [{ name: 'left-pad' }],
          devDependencies: [{ name: 'a' }, { name: 'b' }],
          exports: [],
        },
        {
          file: 'src/lib/geo.ts',
          owners: [],
          exports: [{ name: 'x' }],
          types: [{ name: 'T' }],
          enumMembers: { Colour: [{ name: 'Red' }, { name: 'Blue' }] },
          duplicates: [[{ name: 'a' }, { name: 'b' }]],
        },
        { file: 'src/flagged.ts', files: true, exports: [] },
      ],
    };
    const { count, markdown } = knipFindings(report, 'knip.json');
    expect(count).toBe(2 + 3 + 5 + 1);
    expect(markdown).toContain('- `Red` in `src/lib/geo.ts`');
    expect(markdown).toContain('- `src/flagged.ts`');
  });

  it('labels a type it has no name for by its key, and skips what is not a finding', () => {
    expect(
      knipFindings({ issues: [knipIssue('a.ts', { futureKind: [{ name: 'x' }] })] }, 'k').markdown,
    ).toContain('### futureKind (1)');
    expect(
      knipFindings(
        {
          issues: [
            knipIssue('a.ts', {
              count: 3,
              misc: ['plain'],
              other: [null],
              odd: [{ line: 1 }],
              files: false,
            }),
            { exports: [{ name: 'y' }] },
          ],
        },
        'k',
      ).markdown,
    ).toBe(
      '[knip](https://knip.dev) found code and dependencies nothing uses. Delete them, or, if something does use them in a way knip can’t see, say so in `k`.\n\n### Unused exports (1)\n\n- `y` in `?`',
    );
  });
});

/**
 * @param {string} name
 * @param {number} start
 * @param {number} end
 */
const loc = (name, start, end) => ({ name, start, end });

describe('jscpdFindings', () => {
  it('is empty when jscpd found no clones', () => {
    expect(jscpdFindings({ duplicates: [] }, '/repo')).toEqual({ count: 0, markdown: '' });
    expect(jscpdFindings({}, '/repo').count).toBe(0);
  });

  it('lists clones largest first, with paths relative to the repository', () => {
    const { count, markdown } = jscpdFindings(
      {
        duplicates: [
          {
            format: 'tsx',
            lines: 10,
            firstFile: loc('/repo/src/screens/DoneScreen.tsx', 73, 82),
            secondFile: loc('/repo/src/screens/SiftScreen.tsx', 94, 103),
          },
          {
            format: 'typescript',
            lines: 18,
            firstFile: loc('/repo/src/utils/validators.ts', 170, 187),
            secondFile: loc('/elsewhere/x.ts', 1, 18),
          },
        ],
        statistics: { total: { percentage: 0.7395, clones: 2 } },
      },
      '/repo/',
    );
    expect(count).toBe(2);
    expect(markdown).toContain('found 2 duplicated blocks (0.74% of the lines it read');
    expect(markdown).toContain(
      '| 18 | `src/utils/validators.ts:170-187` | `/elsewhere/x.ts:1-18` |\n| 10 | `src/screens/DoneScreen.tsx:73-82` | `src/screens/SiftScreen.tsx:94-103` |',
    );
  });

  it('says block for one clone, 0% without statistics, and copes with relative paths', () => {
    const { markdown } = jscpdFindings(
      { duplicates: [{ lines: 9, firstFile: loc('a.swift', 1, 9), secondFile: {} }] },
      '/r',
    );
    expect(markdown).toContain('found 1 duplicated block (0.00% of');
    expect(markdown).toContain('| 9 | `a.swift:1-9` | `?:undefined-undefined` |');
    expect(jscpdFindings({ duplicates: [{}] }, '/r').markdown).toContain('| 0 |');
  });
});

describe('lycheeFindings', () => {
  const report = {
    fail_map: {
      'README.md': [
        { url: 'https://gone.example/', status: { text: 'Network error', code: 404 } },
        { url: 'file:///repo/docs/missing.png', status: 'Cannot find file' },
      ],
      'CLAUDE.md': [{ url: 'https://x.example/#nope', status: { text: 'Fragment not found' } }],
      'PLAN.md': [],
    },
  };

  it('counts every broken link and lists them by doc, docs in order', () => {
    const { count, markdown } = lycheeFindings(report);
    expect(count).toBe(3);
    expect(markdown).toContain('- https://gone.example/ — 404 Network error');
    expect(markdown).toContain('- file:///repo/docs/missing.png — Cannot find file');
    expect(markdown).toContain('- https://x.example/#nope — Fragment not found');
    expect(markdown.indexOf('**CLAUDE.md**')).toBeLessThan(markdown.indexOf('**README.md**'));
    expect(markdown).not.toContain('PLAN.md');
  });

  it("reads lychee's current error_map as well as the older fail_map", () => {
    const failures = [{ url: 'https://gone.example/', status: { text: 'Gone', code: 410 } }];
    expect(lycheeFindings({ error_map: { 'README.md': failures } })).toEqual(
      lycheeFindings({ fail_map: { 'README.md': failures } }),
    );
    expect(lycheeFindings({ error_map: { 'README.md': failures } }).count).toBe(1);
  });

  it('shows a status it does not know as JSON, and a bare code', () => {
    const { markdown } = lycheeFindings({
      fail_map: {
        'a.md': [
          { url: 'u', status: { odd: 1 } },
          { url: 'v', status: { code: 500 } },
        ],
      },
    });
    expect(markdown).toContain('- u — {"odd":1}');
    expect(markdown).toContain('- v — 500');
  });

  it('is empty without failures', () => {
    expect(lycheeFindings({})).toEqual({ count: 0, markdown: '' });
    expect(lycheeFindings({ fail_map: { 'a.md': 'oops' } }).count).toBe(0);
  });
});
