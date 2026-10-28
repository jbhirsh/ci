import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  RECORD_VERSION,
  changedFiles,
  contextHash,
  currentContext,
  main,
  nextRecord,
  parseRecord,
  patchId,
  plan,
  readPlan,
  summaryNote,
} from './carry.mjs';
import { testApp, writeFiles } from './testApp.mjs';

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const CONTEXT = 'c'.repeat(64);
const lines = (/** @type {number} */ n, /** @type {Record<number, string>} */ changes = {}) =>
  Array.from({ length: n }, (_, i) => changes[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

/**
 * Runs git in a test app, as a fixed author.
 *
 * @param {string} root
 * @param {string[]} args
 * @returns {string}
 */
function git(root, ...args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

/**
 * Commits files on the current branch.
 *
 * @param {string} root
 * @param {Record<string, string>} files
 */
function commit(root, files) {
  writeFiles(root, files);
  git(root, 'add', '--', ...Object.keys(files));
  git(root, 'commit', '-q', '--no-gpg-sign', '-m', 'c');
}

/**
 * An app whose origin/main holds a.ts and b.ts (30 lines each), and a PR
 * branch, checked out, changing line 25 of both.
 *
 * @returns {string}
 */
function prApp() {
  const root = testApp({ 'a.ts': lines(30), 'b.ts': lines(30), 'c.ts': lines(3) });
  git(root, 'checkout', '-q', '-b', 'pr');
  commit(root, { 'a.ts': lines(30, { 25: 'a changed' }) });
  commit(root, { 'b.ts': lines(30, { 25: 'b changed' }) });
  return root;
}

/** @param {string} root */
const ids = (root) =>
  Object.fromEntries(
    changedFiles({ root, base: 'main' }).map((f) => [f, patchId(f, { root, base: 'main' })]),
  );

/**
 * Moves origin/main on by one commit, from main.
 *
 * @param {string} root
 * @param {Record<string, string>} files
 */
function moveBase(root, files) {
  git(root, 'checkout', '-q', 'main');
  commit(root, files);
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'checkout', '-q', 'pr');
}

/**
 * The files a run after `before` carries over.
 *
 * @param {Record<string, string | null>} before
 * @param {Record<string, string | null>} after
 * @returns {string[]}
 */
function carriedAfter(before, after) {
  const record = nextRecord(plan(before, null, CONTEXT), SHA1);
  return Object.keys(plan(after, parseRecord(JSON.stringify(record)), CONTEXT).carried);
}

describe('patch-ids across pushes', () => {
  it("lists the PR's changed files and gives each a patch-id", () => {
    const root = prApp();
    const before = ids(root);
    expect(Object.keys(before)).toEqual(['a.ts', 'b.ts']);
    expect(before['a.ts']).toMatch(/^[0-9a-f]{40}$/);
    expect(before['a.ts']).not.toBe(before['b.ts']);
  });

  it('carries every file over a rebase that keeps the change, squashed and force-pushed', () => {
    const root = prApp();
    const before = ids(root);
    moveBase(root, { 'c.ts': lines(3, { 1: 'main moved' }) });
    // A new branch from the moved base, both changes in one commit: the old
    // head is not its ancestor.
    git(root, 'checkout', '-q', '-B', 'pr', 'origin/main');
    commit(root, {
      'a.ts': lines(30, { 25: 'a changed' }),
      'b.ts': lines(30, { 25: 'b changed' }),
    });
    expect(carriedAfter(before, ids(root))).toEqual(['a.ts', 'b.ts']);
  });

  it('re-reads a file whose hunk changed, and only that one', () => {
    const root = prApp();
    const before = ids(root);
    commit(root, { 'a.ts': lines(30, { 25: 'a changed again' }) });
    expect(carriedAfter(before, ids(root))).toEqual(['b.ts']);
  });

  it("carries a file over when the base moves without touching its diff's lines", () => {
    const root = prApp();
    const before = ids(root);
    // Main edits a.ts far from the PR's hunk; the PR is rebased onto it.
    moveBase(root, { 'a.ts': lines(30, { 1: 'main edit' }) });
    git(root, 'rebase', '-q', 'origin/main');
    expect(git(root, 'show', 'HEAD:a.ts')).toContain('main edit');
    expect(carriedAfter(before, ids(root))).toEqual(['a.ts', 'b.ts']);
  });

  it("re-reads a file when the base changes the lines around the PR's hunk", () => {
    const root = prApp();
    const before = ids(root);
    moveBase(root, { 'a.ts': lines(30, { 23: 'main edit' }) });
    git(root, 'rebase', '-q', 'origin/main');
    expect(carriedAfter(before, ids(root))).toEqual(['b.ts']);
  });

  it('gives no patch-id to a file with no diff, which is never carried', () => {
    const root = prApp();
    expect(patchId('c.ts', { root, base: 'main' })).toBeNull();
    expect(carriedAfter({ 'c.ts': null }, { 'c.ts': null })).toEqual([]);
  });

  it('re-reads a file whose change differs only in whitespace', () => {
    const root = testApp({ 'ci.yml': 'a:\n  b: 1\n', 'b.ts': lines(30) });
    git(root, 'checkout', '-q', '-b', 'pr');
    commit(root, { 'ci.yml': 'a:\n  b: 2\n', 'b.ts': lines(30, { 25: 'b changed' }) });
    const before = ids(root);
    commit(root, { 'ci.yml': 'a:\n    b: 2\n', 'b.ts': lines(30, { 25: 'b changed' }) });
    expect(carriedAfter(before, ids(root))).toEqual(['b.ts']);
  });

  it('takes a path literally, not as a glob', () => {
    const root = prApp();
    commit(root, { 'x[1].ts': 'one\n' });
    expect(patchId('x[1].ts', { root, base: 'main' })).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('the record', () => {
  const record = {
    version: RECORD_VERSION,
    context: CONTEXT,
    files: { 'a.ts': { patchId: SHA1, sha: SHA2 } },
  };

  it('round-trips', () => {
    expect(parseRecord(JSON.stringify(record))).toEqual(record);
  });

  it.each([
    ['missing', null],
    ['not JSON', '{"version": 1,'],
    ['an array', '[]'],
    ['another version', JSON.stringify({ ...record, version: 2 })],
    ['a short context', JSON.stringify({ ...record, context: 'abc' })],
    ['files not an object', JSON.stringify({ ...record, files: [] })],
    ['an entry not an object', JSON.stringify({ ...record, files: { 'a.ts': 'x' } })],
    [
      'a patch-id that is not hex',
      JSON.stringify({
        ...record,
        files: { 'a.ts': { patchId: `$(rm -rf /)${SHA1}`, sha: SHA2 } },
      }),
    ],
    ['a sha missing', JSON.stringify({ ...record, files: { 'a.ts': { patchId: SHA1 } } })],
    ['an empty path', JSON.stringify({ ...record, files: { '': { patchId: SHA1, sha: SHA2 } } })],
  ])('is thrown away whole when %s, so everything is read', (_, text) => {
    expect(parseRecord(text)).toBeNull();
    expect(plan({ 'a.ts': SHA1 }, parseRecord(text), CONTEXT).carried).toEqual({});
  });

  it('is thrown away when it has more entries than any PR', () => {
    const files = Object.fromEntries(
      Array.from({ length: 20001 }, (_, i) => [`f${i}`, { patchId: SHA1, sha: SHA2 }]),
    );
    expect(parseRecord(JSON.stringify({ ...record, files }))).toBeNull();
  });

  it('never throws on any input, and keeps only well-formed records', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
        const parsed = parseRecord(text);
        if (parsed) expect(parsed.version).toBe(RECORD_VERSION);
      }),
    );
  });

  it("doesn't let a prototype key stand in for a file", () => {
    const parsed = parseRecord(JSON.stringify(record));
    expect(plan({ toString: SHA1 }, parsed, CONTEXT).carried).toEqual({});
  });
});

describe('plan and nextRecord', () => {
  it('carries a file read under the same context with the same patch-id, keeping when it was read', () => {
    const first = nextRecord(plan({ 'a.ts': SHA1, 'b.ts': SHA2 }, null, CONTEXT), SHA1);
    expect(first.files['a.ts']).toEqual({ patchId: SHA1, sha: SHA1 });
    const second = plan({ 'a.ts': SHA1, 'b.ts': SHA1 }, first, CONTEXT);
    expect(second.carried).toEqual({ 'a.ts': { patchId: SHA1, sha: SHA1 } });
    // The next review reads b.ts at SHA2; a.ts keeps SHA1, when it was read.
    expect(nextRecord(second, SHA2).files).toEqual({
      'a.ts': { patchId: SHA1, sha: SHA1 },
      'b.ts': { patchId: SHA1, sha: SHA2 },
    });
  });

  it('carries nothing under another context', () => {
    const record = nextRecord(plan({ 'a.ts': SHA1 }, null, CONTEXT), SHA1);
    expect(plan({ 'a.ts': SHA1 }, record, 'd'.repeat(64)).carried).toEqual({});
  });

  it('drops a file the PR no longer changes, and one with no patch-id', () => {
    const record = nextRecord(plan({ 'a.ts': SHA1, 'gone.ts': SHA2 }, null, CONTEXT), SHA1);
    const next = nextRecord(plan({ 'a.ts': SHA1, 'mode.sh': null }, record, CONTEXT), SHA2);
    expect(Object.keys(next.files)).toEqual(['a.ts']);
  });
});

describe('the context', () => {
  const parts = {
    prompt: 'p',
    followup: 'f',
    settings: { instructions: 'g.md', guide: 'G', skip: [] },
    claudeMd: '# app',
    base: 'main',
  };

  it.each([
    ['the prompt', { prompt: 'p2' }],
    ['the follow-up prompt', { followup: 'f2' }],
    ["the app's instructions", { settings: { ...parts.settings, guide: 'G2' } }],
    ["the app's CLAUDE.md", { claudeMd: '# app, edited' }],
    ['the base branch', { base: 'develop' }],
  ])('changes with %s, voiding every carry-over', (_, change) => {
    const before = contextHash(parts);
    const after = contextHash({ ...parts, ...change });
    expect(after).not.toBe(before);
    const record = nextRecord(plan({ 'a.ts': SHA1 }, null, before), SHA1);
    expect(plan({ 'a.ts': SHA1 }, record, after).carried).toEqual({});
  });

  it("reads the app's guide and CLAUDE.md from the base branch", () => {
    const root = testApp({
      '.github/ci.json': '{"review": {"instructions": "g.md"}}',
      'g.md': '## Auth',
      'CLAUDE.md': '# App',
    });
    const where = { root, ref: 'origin/main', base: 'main' };
    const before = currentContext(where);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    // The working tree (a PR's own edit) doesn't count; the base does.
    writeFiles(root, { 'g.md': '## Auth, edited' });
    expect(currentContext(where)).toBe(before);
    commit(root, { 'g.md': '## Auth, edited' });
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const afterGuide = currentContext(where);
    expect(afterGuide).not.toBe(before);
    commit(root, { 'CLAUDE.md': '# App, edited' });
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(currentContext(where)).not.toBe(afterGuide);
    expect(currentContext({ ...where, base: 'develop' })).not.toBe(currentContext(where));
  });
});

describe('readPlan', () => {
  it('reads back a plan, and nothing from a missing or malformed one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'plan-'));
    const file = path.join(dir, 'plan.json');
    const p = plan({ 'a.ts': SHA1, 'b.ts': null }, null, CONTEXT);
    writeFileSync(file, JSON.stringify(p));
    expect(readPlan(file)).toEqual(p);
    expect(readPlan(undefined)).toBeNull();
    expect(readPlan(path.join(dir, 'none.json'))).toBeNull();
    writeFileSync(file, JSON.stringify({ ...p, patchIds: { 'a.ts': 'not hex' } }));
    expect(readPlan(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ ...p, carried: [] }));
    expect(readPlan(file)).toBeNull();
    writeFileSync(file, '[]');
    expect(readPlan(file)).toBeNull();
  });
});

describe('summaryNote', () => {
  it('names each carried file and the commit it was read at', () => {
    const p = plan({ 'a.ts': SHA1, 'b.ts': SHA2 }, null, CONTEXT);
    expect(summaryNote(p)).toBe('Claude Review: all 2 changed file(s) to be read.');
    const carried = { ...p, carried: { 'a.ts': { patchId: SHA1, sha: SHA2 } } };
    expect(summaryNote(carried)).toContain('1 of 2 changed file(s) carried over');
    expect(summaryNote(carried)).toContain('- `a.ts`, read at bbbbbbb');
  });
});

describe('main', () => {
  it('plans, saves, and on the next push carries over what was read', () => {
    const root = prApp();
    const dir = mkdtempSync(path.join(tmpdir(), 'carry-'));
    const env = {
      RECORD: path.join(dir, 'r', 'record.json'),
      PLAN: path.join(dir, 'p', 'plan.json'),
      BASE_REF: 'main',
      CONFIG_REF: 'origin/main',
      HEAD_SHA: git(root, 'rev-parse', 'HEAD').trim(),
    };
    expect(main('plan', env, root)).toEqual({
      note: 'Claude Review: all 2 changed file(s) to be read.',
      carried: [],
    });
    main('save', env, root);
    const saved = parseRecord(readFileSync(env.RECORD, 'utf8'));
    expect(Object.keys(saved?.files ?? {})).toEqual(['a.ts', 'b.ts']);

    commit(root, { 'b.ts': lines(30, { 25: 'b changed again' }), 'package-lock.json': '{}' });
    const second = main('plan', env, root);
    expect(second.carried).toEqual(['a.ts']);
    expect(second.note).toContain(`- \`a.ts\`, read at ${env.HEAD_SHA.slice(0, 7)}`);
  });

  it('reads everything when the record is corrupt', () => {
    const root = prApp();
    const dir = mkdtempSync(path.join(tmpdir(), 'carry-'));
    const env = { RECORD: path.join(dir, 'record.json'), PLAN: path.join(dir, 'plan.json') };
    writeFileSync(env.RECORD, '{"version": 1, "context": "x", "files": {}}garbage');
    expect(main('plan', env, root).carried).toEqual([]);
  });

  it("leaves out the app's skip globs", () => {
    const root = prApp();
    commit(root, { '.github/ci.json': '{"review": {"skip": ["b.ts"]}}' });
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(root, 'checkout', '-q', '-b', 'pr2');
    commit(root, { 'a.ts': lines(30, { 2: 'x' }), 'b.ts': lines(30, { 2: 'x' }) });
    const dir = mkdtempSync(path.join(tmpdir(), 'carry-'));
    const env = {
      RECORD: path.join(dir, 'record.json'),
      PLAN: path.join(dir, 'plan.json'),
      CONFIG_REF: 'origin/main',
    };
    main('plan', env, root);
    expect(Object.keys(readPlan(env.PLAN)?.patchIds ?? {})).toEqual(['a.ts']);
  });

  it('refuses to save without a plan or a head commit, and an unknown command', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'carry-'));
    const env = { RECORD: path.join(dir, 'record.json'), PLAN: path.join(dir, 'plan.json') };
    expect(() => main('save', { ...env, HEAD_SHA: SHA1 }, dir)).toThrow('no plan to save');
    writeFileSync(env.PLAN, JSON.stringify(plan({}, null, CONTEXT)));
    expect(() => main('save', { ...env, HEAD_SHA: 'HEAD' }, dir)).toThrow('no plan to save');
    expect(() => main('push', env, dir)).toThrow('usage');
    expect(() => main('plan', {}, dir)).toThrow('RECORD and PLAN must be set');
  });
});
