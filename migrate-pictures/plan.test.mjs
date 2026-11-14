import { describe, expect, it } from 'vitest';
import { ATTACH_MAX_BYTES, attachable, extOf, makePlan, planReport, postLabel } from './plan.mjs';

/**
 * @param {string} key
 * @param {Partial<import('./plan.mjs').LinkedPost>} fields
 * @returns {import('./plan.mjs').LinkedPost}
 */
const post = (key, fields) => ({
  key,
  repo: 'jbhirsh/app',
  kind: 'issue',
  id: 1,
  number: null,
  html: `https://github.com/jbhirsh/app/pull/1`,
  author: 'jbhirsh',
  updatedAt: '',
  body: '',
  links: [],
  ...fields,
});

/**
 * @param {string} blob
 * @param {string} file
 * @param {number} [size]
 * @returns {import('./plan.mjs').FoundLink}
 */
const pic = (blob, file, size = 100) => ({
  url: `https://raw.githubusercontent.com/jbhirsh/app/abc1234/${file}`,
  form: 'raw',
  ref: 'abc1234',
  path: file,
  status: 'migrate',
  blob,
  size,
  at: `abc1234:${file}`,
});

/** @type {import('./plan.mjs').Inventory} */
const inventory = {
  repo: 'jbhirsh/app',
  branch: 'screenshots',
  legacy: 'pr-screenshots',
  tip: 'f'.repeat(40),
  legacyBranches: [],
  repos: ['jbhirsh/app'],
  scanned: { 'jbhirsh/app': 4 },
  kept: { abc0000: 2 },
  files: [
    { path: '1/before.png', blob: 'a'.repeat(40), size: 100 },
    { path: 'unlinked.png', blob: 'e'.repeat(40), size: 5 },
  ],
  posts: [
    // Two PR folders' before.png: different files, so two pictures. The
    // same file at two commits is one.
    post('p1', {
      links: [
        pic('a'.repeat(40), '1/before.png'),
        pic('b'.repeat(40), '2/before.png'),
        { ...pic('a'.repeat(40), '1/before.png'), at: 'def5678:1/before.png' },
      ],
    }),
    post('p2', {
      kind: 'issue-comment',
      id: 9,
      number: null,
      author: 'someone',
      links: [pic('a'.repeat(40), '1/before.png')],
    }),
    post('p3', {
      kind: 'review',
      id: 5,
      number: 3,
      links: [
        pic('c'.repeat(40), 'huge.gif', ATTACH_MAX_BYTES + 1),
        pic('d'.repeat(40), 'notes.md'),
      ],
    }),
    post('p4', {
      links: [
        {
          url: 'https://github.com/jbhirsh/app/tree/abc1234/x',
          form: 'tree',
          ref: 'abc1234',
          path: 'x',
          status: 'listed',
        },
        { url: 'u', form: 'raw', ref: 'screenshots', path: 'gone.png', status: 'unresolved' },
      ],
    }),
  ],
};

describe('makePlan', () => {
  it("uploads each blob once, and rewrites only own and bots' posts with an attachable picture", () => {
    const plan = makePlan(inventory, { host: 7 });
    expect(plan.pictures.map((p) => [p.blob[0], p.attach, p.at.length, p.posts])).toEqual([
      ['a', 'ok', 2, ['p1', 'p2']],
      ['b', 'ok', 1, ['p1']],
      ['c', 'too-big', 1, ['p3']],
      ['d', 'not-a-picture', 1, ['p3']],
    ]);
    expect(plan.rewrite).toEqual(['p1']);
    expect(plan.others).toEqual(['p2']);
    expect(makePlan(inventory, { includeOthers: true }).rewrite).toEqual(['p1', 'p2']);
  });
});

describe('planReport', () => {
  it('counts, then lists what needs the owner', () => {
    const report = planReport(inventory, makePlan(inventory, { host: 7 }), { batch: 1 });
    expect(report).toContain(
      '| Distinct pictures to upload | 2 (1 KB), in 2 attach command(s) of up to 1 |',
    );
    expect(report).toContain('| Pictures not uploaded (too big, or not a picture) | 2 |');
    expect(report).toContain('| Branch files no post links (kept only in the bundle) | 1 |');
    expect(report).toContain("over GitHub's 10 MB");
    expect(report).toContain(".md isn't a picture GitHub attaches");
    expect(report).toContain('`https://github.com/jbhirsh/app/tree/abc1234/x`');
    expect(report).toContain("Others' posts, left alone");
    expect(report).toContain('by `someone`: 1 link(s)');
    expect(report).toContain('- `abc0000`: 2');
    expect(report).toContain("#7's description");
    expect(report).toContain('→ batch 2 →');
    expect(planReport(inventory, makePlan(inventory), { batch: 50 })).toContain('`host-pr`');
  });
});

describe('helpers', () => {
  it('reads extensions, attachability and labels', () => {
    expect(extOf('a/b.PNG')).toBe('png');
    expect(extOf('noext')).toBe('');
    expect(attachable(ATTACH_MAX_BYTES, 'gif')).toBe('ok');
    expect(attachable(1, 'json')).toBe('not-a-picture');
    expect(postLabel(inventory.posts[2])).toBe(
      '[app#3 review](https://github.com/jbhirsh/app/pull/1)',
    );
    expect(postLabel(inventory.posts[1])).toBe(
      '[app comment](https://github.com/jbhirsh/app/pull/1)',
    );
    expect(postLabel(inventory.posts[0])).toBe(
      '[app#1 body](https://github.com/jbhirsh/app/pull/1)',
    );
  });
});
