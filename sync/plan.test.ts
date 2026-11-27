import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  blobSha,
  blockers,
  changesFor,
  commitMessage,
  decide,
  diffStat,
  holds,
  lineDiff,
  PR_TITLE,
  prBody,
  report,
  sameBytes,
} from './plan.ts';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

/** @type {import('./manifest.ts').Companion} */
const exempt = { key: ['autofix', 'exempt', 'Hello'], value: 'reads the PR as data' };

/**
 * @param {Partial<import('./plan.ts').Change>} [over]
 * @returns {import('./plan.ts').Change}
 */
const change = (over = {}) => ({
  path: '.github/workflows/hello.yml',
  source: 'sync/callers/hello.yml',
  why: undefined,
  status: 'updated',
  bytes: Buffer.from('name: hello\n'),
  stat: { added: 2, removed: 1 },
  companions: [],
  ...over,
});

describe('sameBytes and blobSha', () => {
  it('compares bytes, not text', () => {
    expect(sameBytes(Buffer.from('a\n'), Buffer.from('a\n'))).toBe(true);
    expect(sameBytes(Buffer.from('a\n'), Buffer.from('a\r\n'))).toBe(false);
  });

  it("names a file's content as git does", () => {
    const bytes = Buffer.from('name: hello\n');
    const git = execFileSync('git', ['hash-object', '--stdin'], { input: bytes, encoding: 'utf8' });
    expect(blobSha(bytes)).toBe(git.trim());
  });
});

describe('lineDiff and diffStat', () => {
  it('finds the lines a change loses and gains, keeping what both share', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nx\nc\n')).toEqual({ removed: ['b'], added: ['x'] });
    expect(lineDiff('a\nb\n', 'a\nb\nc\n')).toEqual({ removed: [], added: ['c'] });
    expect(lineDiff('a\nb\nc', 'c\na')).toEqual({ removed: ['a', 'b'], added: ['a'] });
    expect(diffStat('one\ntwo\n', 'one\n2\nthree\n')).toEqual({ added: 2, removed: 1 });
    expect(diffStat('same', 'same')).toEqual({ added: 0, removed: 0 });
  });

  it('counts every line between the shared ends as changed past its limit', () => {
    const before = Array.from({ length: 2500 }, (_, i) => `a${i}`).join('\n');
    const after = Array.from({ length: 2500 }, (_, i) => `b${i}`).join('\n');
    expect(diffStat(`top\n${before}\nend`, `top\n${after}\nend`)).toEqual({
      added: 2500,
      removed: 2500,
    });
  });
});

describe('holds', () => {
  it('finds a key path, own keys only', () => {
    expect(holds({ a: { b: 1 } }, ['a', 'b'])).toBe(true);
    expect(holds({ a: { b: 1 } }, ['a', 'c'])).toBe(false);
    expect(holds({ a: 'text' }, ['a', 'b'])).toBe(false);
    expect(holds({ a: null }, ['a', 'b'])).toBe(false);
    expect(holds({}, ['toString'])).toBe(false);
  });
});

describe('changesFor', () => {
  /** @type {import('./manifest.ts').Resolved[]} */
  const files = [
    { path: 'same.md', source: 's/same.md', why: undefined, companions: [] },
    { path: 'old.yml', source: 's/old.yml', why: 'its own build', companions: [exempt] },
    { path: 'new.yml', source: 's/new.yml', why: undefined, companions: [exempt] },
    { path: 'held.yml', source: 's/held.yml', why: undefined, companions: [exempt] },
  ];
  /** @type {Record<string, string>} */
  const sources = {
    's/same.md': 'same\n',
    's/old.yml': '# new comment\nname: x\n',
    's/new.yml': 'name: new\n',
    's/held.yml': 'name: held\n',
  };
  /** @type {Record<string, string>} */
  const app = { 'same.md': 'same\n', 'old.yml': '# old comment\nname: x\n' };
  const changes = changesFor(
    files,
    (source) => Buffer.from(sources[source]),
    (file) => (file in app ? Buffer.from(app[file]) : null),
    { autofix: { exempt: {} } },
  );

  it('lists only the files whose bytes differ, in order, with what each becomes', () => {
    expect(changes.map((c) => [c.path, c.status])).toEqual([
      ['old.yml', 'updated'],
      ['new.yml', 'added'],
      ['held.yml', 'added'],
    ]);
    expect(changes[0].bytes.toString()).toBe('# new comment\nname: x\n');
    expect(changes[0].stat).toEqual({ added: 1, removed: 1 });
    expect(changes[0].why).toBe('its own build');
  });

  it('brings companions only with a file it adds, and only keys the app lacks', () => {
    expect(changes[0].companions).toEqual([]);
    expect(changes[1].companions).toEqual([exempt]);
    const held = changesFor(
      [files[2]],
      (source) => Buffer.from(sources[source]),
      () => null,
      { autofix: { exempt: { Hello: 'the app’s own reason' } } },
    );
    expect(held[0].companions).toEqual([]);
  });
});

describe('commitMessage', () => {
  it('names the file and the source commit, and says why a variant differs', () => {
    const message = commitMessage(change({ why: 'sift records in CI' }), SHA);
    expect(message.subject).toBe('Sync .github/workflows/hello.yml with jbhirsh/ci');
    expect(message.body).toContain('sync/callers/hello.yml at abcdef0');
    expect(message.body).toContain("brings this repo's copy to it");
    expect(message.body).toContain("This repo's copy is a variant: sift records in CI");
  });

  it('says an added file adds it, with the companion keys it brings', () => {
    const { body } = commitMessage(change({ status: 'added', companions: [exempt] }), SHA);
    expect(body).toContain('this adds it');
    expect(body).toContain(
      '.github/ci.json gains what the file needs there: autofix.exempt.Hello.',
    );
  });

  it('keeps the subject within the commit check’s 72 characters', () => {
    const long = change({ path: `.github/workflows/${'a'.repeat(60)}/deep.yml` });
    expect(commitMessage(long, SHA).subject).toBe('Sync deep.yml with jbhirsh/ci');
    // 76 characters in full: one past the limit.
    const past = change({ path: `.github/workflows/${'c'.repeat(33)}.yml` });
    expect(commitMessage(past, SHA).subject).toBe(`Sync ${'c'.repeat(33)}.yml with jbhirsh/ci`);
    const at = change({ path: `.github/workflows/${'c'.repeat(29)}.yml` });
    expect(commitMessage(at, SHA).subject).toHaveLength(72);
    expect(commitMessage(at, SHA).subject).toContain('.github/workflows/');
    const longer = change({ path: 'b'.repeat(90) });
    expect(commitMessage(longer, SHA).subject.length).toBe(72);
  });
});

describe('prBody', () => {
  const body = prBody({
    ciSha: SHA,
    runUrl: 'https://github.com/jbhirsh/ci/actions/runs/1',
    changes: [
      change(),
      change({
        path: 'a\\|b<c>&.md',
        source: 'sync/variants/sift/a.md',
        status: 'added',
        why: 'sift | its CI records',
        companions: [exempt],
      }),
    ],
  });

  it('has the shared headings and links the source commit and the run', () => {
    expect([...body.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual([
      'Goal',
      'Changes',
      'Checklist',
    ]);
    expect(body).toContain(`[abcdef0](https://github.com/jbhirsh/ci/commit/${SHA})`);
    expect(body).toContain('([run](https://github.com/jbhirsh/ci/actions/runs/1))');
  });

  it('lists each file: added or updated, its source at the commit, its lines', () => {
    expect(body).toContain(
      `| <code>.github/workflows/hello.yml</code> | updated | [<code>sync/callers/hello.yml</code>](https://github.com/jbhirsh/ci/blob/${SHA}/sync/callers/hello.yml) | +2 −1 |`,
    );
    // A backslash before a pipe must not end the cell: both are entities.
    expect(body).toContain('| <code>a&#92;&#124;b&lt;c&gt;&amp;.md</code> | added |');
  });

  it("shows a variant's reason and a companion key", () => {
    expect(body).toContain("- `a\\|b<c>&.md` is this app's variant: sift | its CI records");
    expect(body).toContain(
      '- `.github/ci.json` gains `autofix.exempt.Hello`, which `a\\|b<c>&.md` needs',
    );
  });

  it('leaves out the variant and companion lists when there are none', () => {
    const plain = prBody({ ciSha: SHA, changes: [change()] });
    expect(plain).not.toContain('variant');
    expect(plain).not.toContain('gains');
    expect(plain).not.toContain('[run]');
  });
});

describe('report', () => {
  it('says there is no PR when nothing differs', () => {
    expect(report('sift', [], SHA)).toEqual(['sift: every synced file matches jbhirsh/ci; no PR.']);
  });

  it('lists the commits the PR would hold, with what each is', () => {
    expect(report('sift', [change({ why: 'x', companions: [exempt] })], SHA)).toEqual([
      `sift: would open or update one PR from bot/sync-files, "${PR_TITLE}", with 1 commit(s):`,
      '  - Sync .github/workflows/hello.yml with jbhirsh/ci (updated, +2 −1, variant, ci.json gains autofix.exempt.Hello)',
    ]);
  });
});

describe('decide', () => {
  it('does nothing, or closes the PR, when nothing differs', () => {
    expect(decide({ changes: 0, open: false, matches: false, mergeable: null })).toBe('none');
    expect(decide({ changes: 0, open: true, matches: false, mergeable: 'clean' })).toBe('close');
  });

  it('builds when there is no PR or its branch holds other bytes', () => {
    expect(decide({ changes: 2, open: false, matches: false, mergeable: null })).toBe('build');
    expect(decide({ changes: 2, open: true, matches: false, mergeable: 'clean' })).toBe('build');
  });

  it('keeps a branch that already holds the bytes, unless it is behind or conflicts', () => {
    for (const mergeable of ['clean', 'blocked', 'unstable', 'unknown', null]) {
      expect(decide({ changes: 1, open: true, matches: true, mergeable })).toBe('keep');
    }
    expect(decide({ changes: 1, open: true, matches: true, mergeable: 'behind' })).toBe('build');
    expect(decide({ changes: 1, open: true, matches: true, mergeable: 'dirty' })).toBe('build');
  });
});

describe('blockers', () => {
  const none = { threads: [], required: [], checkRuns: [], statuses: [] };

  it('names each unresolved review thread', () => {
    expect(
      blockers({
        ...none,
        threads: [
          { isResolved: true, path: 'a.yml', line: 1 },
          { isResolved: false, path: '.github/workflows/pr-description.yml', line: 7 },
          { isResolved: false, path: null, line: null, url: 'https://x/1' },
        ],
      }),
    ).toEqual([
      'unresolved review thread on .github/workflows/pr-description.yml:7',
      'unresolved review thread on the PR (https://x/1)',
    ]);
  });

  it('names a required check whose newest run failed, or whose status did', () => {
    expect(
      blockers({
        ...none,
        required: ['test', 'Vercel', 'lint', 'smoke'],
        checkRuns: [
          { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
          { id: 2, name: 'test', status: 'completed', conclusion: 'failure' },
          { id: 3, name: 'lint', status: 'completed', conclusion: 'failure' },
          { id: 4, name: 'lint', status: 'completed', conclusion: 'success' },
          { id: 5, name: 'other', status: 'completed', conclusion: 'failure' },
        ],
        statuses: [
          { context: 'Vercel', state: 'error' },
          { context: 'smoke', state: 'failure' },
        ],
      }),
    ).toEqual([
      'required check "test" failed',
      'required check "Vercel" failed',
      'required check "smoke" failed',
    ]);
  });

  it('names nothing still running, not yet started, or skipped', () => {
    expect(
      blockers({
        ...none,
        required: ['a', 'b', 'c', 'd'],
        checkRuns: [
          { id: 1, name: 'a', status: 'in_progress', conclusion: null },
          { id: 2, name: 'c', status: 'completed', conclusion: 'skipped' },
        ],
        statuses: [{ context: 'd', state: 'pending' }],
      }),
    ).toEqual([]);
  });
});
