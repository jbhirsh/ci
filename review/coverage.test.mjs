import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  filesToRead,
  globToRegExp,
  main,
  plainWords,
  toolCalls,
  unreadFiles,
} from './coverage.mjs';

/** @typedef {import('./coverage.mjs').ToolCall} ToolCall */

const REPO = '/home/runner/work/sift/sift';
const RANGE = 'origin/main...HEAD';
/** @returns {ToolCall} */
const bash = (/** @type {string} */ command, result = 'diff --git a/x b/x') => ({
  name: 'Bash',
  input: { command },
  result,
});
/** @returns {ToolCall} */
const read = (
  /** @type {string} */ file_path,
  /** @type {Record<string, unknown>} */ extra = {},
) => ({
  name: 'Read',
  input: { file_path, ...extra },
  result: '1\tx',
});
const changed = ['src/a.ts', 'src/b.ts', '__tests__/unit/a.test.ts'];
/** What each call alone counts as read. */
const readBy = (/** @type {ToolCall[]} */ ...calls) => {
  const unread = new Set(unreadFiles(changed, calls, { repoDir: REPO }));
  return changed.filter((f) => !unread.has(f));
};

describe('filesToRead', () => {
  it('drops lockfiles and binaries in any folder and case, keeps code, tests, fixtures and flows', () => {
    expect(
      filesToRead([
        'package-lock.json',
        'yarn.lock',
        'ios/Podfile.lock',
        'assets/icon.png',
        'assets/Splash.JPG',
        'a.jpeg',
        'assets/icon-source/front.svg',
        'src/utils/sorting.ts',
        '__tests__/unit/sorting.test.ts',
        '__tests__/fixtures/sessions/v8.json',
        '.maestro/10_sort_picker.yaml',
        'docs/package-lock.json.md',
        'src/not-package-lock.json',
        '',
      ]),
    ).toEqual([
      'src/utils/sorting.ts',
      '__tests__/unit/sorting.test.ts',
      '__tests__/fixtures/sessions/v8.json',
      '.maestro/10_sort_picker.yaml',
      'docs/package-lock.json.md',
      'src/not-package-lock.json',
    ]);
  });
});

describe('plainWords', () => {
  it('splits a plain command, honouring quotes, and drops a leading cd', () => {
    expect(plainWords(`cd ${REPO} && git diff -M ${RANGE} -- "docs/my file.md" 'b c'`)).toEqual([
      'git',
      'diff',
      '-M',
      RANGE,
      '--',
      'docs/my file.md',
      'b c',
    ]);
    expect(plainWords('  git   diff\t-- a  ')).toEqual(['git', 'diff', '--', 'a']);
    expect(plainWords('cd "/a b" && git diff')).toEqual(['git', 'diff']);
    expect(plainWords("git diff -- ''")).toEqual(['git', 'diff', '--', '']);
  });

  it('turns away anything more than one plain command', () => {
    for (const command of [
      'git diff -- a | head',
      'git diff -- a > /tmp/x',
      'git diff -- a; ls',
      'git diff -- a && git diff -- b',
      'git diff -- a || true',
      'git diff -- a &',
      'git diff -- $f',
      'git diff -- "$f"',
      'git diff -- `echo a`',
      'git diff -- "`echo a`"',
      'git diff $(git merge-base origin/main HEAD) -- a',
      'gh api x -F body=@- <<EOF\ngit diff\nEOF',
      'git diff -- "unclosed',
      'ls && cd x && git diff',
    ]) {
      expect(plainWords(command)).toBeNull();
    }
  });

  it('keeps $ inside single quotes, which the shell leaves alone', () => {
    expect(plainWords("git log --format='%h $x'")).toEqual(['git', 'log', '--format=%h $x']);
  });
});

describe('unreadFiles', () => {
  it('counts a git diff of the PR for the files it names', () => {
    expect(readBy(bash(`git diff -M ${RANGE} -- src/a.ts`))).toEqual(['src/a.ts']);
    expect(readBy(bash(`git diff ${RANGE} -- src/a.ts src/b.ts`))).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
    expect(readBy(bash('git diff origin/main..HEAD -- src/b.ts'))).toEqual(['src/b.ts']);
    expect(readBy(bash('git diff origin/main HEAD -- ./src/b.ts'))).toEqual(['src/b.ts']);
    expect(readBy(bash(`cd ${REPO} && git diff ${RANGE} -- src/a.ts`))).toEqual(['src/a.ts']);
  });

  it('counts a folder for the files under it, not for a file that only starts the same', () => {
    expect(
      unreadFiles(
        ['src/a.ts', 'src2/c.ts', '__tests__/unit/a.test.ts'],
        [bash(`git diff ${RANGE} -- src/ ./__tests__`)],
        { repoDir: REPO },
      ),
    ).toEqual(['src2/c.ts']);
    expect(readBy(bash(`git diff ${RANGE} -- .`))).toEqual(changed);
    expect(readBy(bash(`git diff ${RANGE} -- ./`))).toEqual(changed);
  });

  it('counts the whole PR diff, and gh pr diff, for every file', () => {
    expect(readBy(bash(`git diff -M ${RANGE}`))).toEqual(changed);
    expect(readBy(bash('git diff origin/main HEAD'))).toEqual(changed);
    expect(readBy(bash('gh pr diff 188'))).toEqual(changed);
  });

  it("counts a diff that is not the PR's for nothing", () => {
    expect(readBy(bash('git diff -- src/a.ts'))).toEqual([]);
    expect(readBy(bash('git diff HEAD~1 HEAD -- src/a.ts'))).toEqual([]);
    expect(readBy(bash('git diff origin/main -- src/a.ts'))).toEqual([]);
    expect(readBy(bash(`git diff ${RANGE} HEAD~1 -- src/a.ts`))).toEqual([]);
  });

  it('counts git show of a file as the PR leaves it, and nothing else git show prints', () => {
    expect(readBy(bash('git show HEAD:src/b.ts'))).toEqual(['src/b.ts']);
    // The base version isn't the change.
    expect(readBy(bash('git show origin/main:src/b.ts'))).toEqual([]);
    // On a pull request, HEAD is a merge commit: no diff at all.
    expect(readBy(bash('git show HEAD'))).toEqual([]);
    expect(readBy(bash('git show aec1321'))).toEqual([]);
    expect(readBy(bash('git show -s --format=%B HEAD'))).toEqual([]);
  });

  it('reads nothing from the forms that show no diff', () => {
    for (const flags of [
      '--stat',
      '--stat=200',
      '--numstat',
      '--shortstat',
      '--name-only',
      '--name-status',
      '--summary',
      '--raw',
      '--check',
      '--dirstat',
      '--dirstat=files',
      '--compact-summary',
      '--exit-code',
      '--quiet',
      '-s',
      '--no-patch',
      '--output=/tmp/x',
      '-U0',
    ]) {
      expect(readBy(bash(`git diff ${flags} ${RANGE}`))).toEqual([]);
    }
    expect(readBy(bash('gh pr diff 188 --name-only'))).toEqual([]);
    expect(readBy(bash('git log -p origin/main..HEAD'))).toEqual([]);
  });

  it('reads nothing from an exclude pathspec, which names no file', () => {
    expect(readBy(bash(`git diff ${RANGE} -- ':!package-lock.json'`))).toEqual([]);
  });

  it('reads nothing from text that only mentions git diff: a grep, a heredoc, a pipe', () => {
    expect(readBy(bash('grep -rn "git diff" .github scripts'))).toEqual([]);
    expect(
      readBy(bash("gh api x -F body=@- <<'EOF'\n**Read in full** (via git diff): all\nEOF")),
    ).toEqual([]);
    expect(readBy(bash(`git diff ${RANGE} -- src/a.ts | wc -l`))).toEqual([]);
    expect(readBy(bash(`git diff ${RANGE} -- src/a.ts | head -50`))).toEqual([]);
    expect(readBy(bash(`echo git diff ${RANGE}`))).toEqual([]);
  });

  it('reads nothing from a call that failed or never ran', () => {
    expect(readBy({ ...bash(`git diff ${RANGE} -- src/a.ts`), failed: true })).toEqual([]);
    expect(readBy({ ...read(`${REPO}/src/a.ts`), failed: true })).toEqual([]);
  });

  it('counts output cut to a preview only once its saved full output was opened', () => {
    const cut =
      'Output too large (80KB). Full output saved to: /tmp/out-1.txt\n\nPreview: diff --git ...';
    const diff = bash(`git diff ${RANGE} -- src/a.ts`, cut);
    expect(readBy(diff)).toEqual([]);
    expect(readBy(diff, read('/tmp/out-2.txt'))).toEqual([]);
    // Too long for one Read: read in parts.
    expect(readBy(diff, read('/tmp/out-1.txt', { offset: 1, limit: 100 }))).toEqual(['src/a.ts']);
    expect(readBy(diff, { ...read('/tmp/out-1.txt'), failed: true })).toEqual([]);
    expect(readBy(diff, read('/tmp/out-1.txt'))).toEqual(['src/a.ts']);
    expect(readBy(bash(`git diff ${RANGE} -- src/a.ts`, '<persisted-output>\nno path'))).toEqual(
      [],
    );
    // The path comes from the header, not from a diff line that quotes one.
    const quoted = `<persisted-output>\nPreview:\n${'+x\n'.repeat(200)}+// saved to: /tmp/out-1.txt`;
    expect(readBy(bash(`git diff ${RANGE} -- src/a.ts`, quoted), read('/tmp/out-1.txt'))).toEqual(
      [],
    );
  });

  it('judges a whole diff that merely contains the cut-off words as whole', () => {
    // The checker's own diff quotes them; it must still count as read.
    const diff =
      'diff --git a/scripts/reviewCoverage.ts\n+const CUT_OFF = /^(<persisted-output>|Output too large)/i;\n+const SAVED_TO = /saved to:?\\s*(\\S+)/i;';
    expect(readBy(bash(`git diff ${RANGE} -- src/a.ts`, diff))).toEqual(['src/a.ts']);
  });

  it('counts a whole Read of the file, by absolute or relative path, but not a part of it', () => {
    expect(readBy(read(`${REPO}/src/a.ts`), read('./src/b.ts'))).toEqual(['src/a.ts', 'src/b.ts']);
    expect(unreadFiles(changed, [read(`${REPO}/src/a.ts`)], { repoDir: `${REPO}/` })).toEqual([
      'src/b.ts',
      '__tests__/unit/a.test.ts',
    ]);
    expect(readBy(read(`${REPO}/src/a.ts`, { offset: 10 }))).toEqual([]);
    expect(readBy(read(`${REPO}/src/a.ts`, { limit: 10 }))).toEqual([]);
  });

  it('ignores other tools and calls without a command or path', () => {
    expect(
      readBy(
        { name: 'Grep', input: { pattern: 'x', path: 'src/a.ts' } },
        { name: 'Glob', input: { command: `git diff ${RANGE}`, file_path: 'src/a.ts' } },
        { name: 'Bash', input: {} },
        { name: 'Read', input: {} },
      ),
    ).toEqual([]);
  });

  it("runs the tests of #188's review: source read, tests and fixtures skipped", () => {
    const files = [
      'src/utils/sorting.ts',
      '__tests__/unit/sorting.test.ts',
      '__tests__/fixtures/sessions/v8.json',
    ];
    const calls = [
      bash(`git diff --stat -M ${RANGE}`),
      bash(`git diff -M ${RANGE} -- src/utils/sorting.ts src/types/index.ts`),
    ];
    expect(unreadFiles(files, calls, { repoDir: REPO })).toEqual([
      '__tests__/unit/sorting.test.ts',
      '__tests__/fixtures/sessions/v8.json',
    ]);
  });
});

describe('toolCalls', () => {
  it('finds each tool use in the SDK messages and pairs it with its result', () => {
    const execution = [
      { type: 'system', subtype: 'init' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Reading.' },
            {
              type: 'tool_use',
              id: 't1',
              name: 'Bash',
              input: { command: 'git diff -- src/a.ts' },
            },
            { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/r/src/b.ts' } },
            { type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'git diff $(x)' } },
            { type: 'tool_use', id: 't5', name: 'Bash', input: { command: 'cancelled' } },
          ],
        },
        // The action's copy of the input, with the cd prefix: not a tool use.
        wire_tool_inputs: { t1: { command: 'cd /r && git diff -- src/a.ts' } },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'text', text: 'diff --git a' }, { type: 'image' }],
            },
            { type: 'tool_result', tool_use_id: 't2', content: 'line 1' },
            { type: 'tool_result', tool_use_id: 't4', content: "can't be checked", is_error: true },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'ls' } }],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: { odd: true } }] },
      },
      { type: 'tool_use', name: 'Bash' },
      null,
      'text',
    ];
    expect(toolCalls(execution)).toEqual([
      {
        name: 'Bash',
        input: { command: 'git diff -- src/a.ts' },
        result: 'diff --git a\n',
        failed: false,
      },
      { name: 'Read', input: { file_path: '/r/src/b.ts' }, result: 'line 1', failed: false },
      {
        name: 'Bash',
        input: { command: 'git diff $(x)' },
        result: "can't be checked",
        failed: true,
      },
      { name: 'Bash', input: { command: 'cancelled' }, failed: true },
      { name: 'Bash', input: { command: 'ls' }, result: '', failed: false },
    ]);
  });

  it('gives no calls for something that is not an execution file', () => {
    expect(toolCalls(undefined)).toEqual([]);
    expect(toolCalls('text')).toEqual([]);
    expect(toolCalls({})).toEqual([]);
  });
});

describe('the base branch', () => {
  it("counts only a diff from the PR's own base", () => {
    const calls = [bash('git diff origin/develop...HEAD -- src/a.ts')];
    expect(unreadFiles(['src/a.ts'], calls, { repoDir: REPO, base: 'develop' })).toEqual([]);
    expect(unreadFiles(['src/a.ts'], calls, { repoDir: REPO })).toEqual(['src/a.ts']);
    // A base with regex characters is matched literally.
    const dotted = [bash('git diff origin/release.1...HEAD')];
    expect(unreadFiles(['a'], dotted, { repoDir: REPO, base: 'release.1' })).toEqual([]);
    expect(unreadFiles(['a'], dotted, { repoDir: REPO, base: 'release-1' })).toEqual(['a']);
    expect(
      unreadFiles(['a'], [bash('git diff origin/releaseX1...HEAD')], {
        repoDir: REPO,
        base: 'release.1',
      }),
    ).toEqual(['a']);
  });
});

describe('skip globs', () => {
  it("leaves out the app's generated files, by glob", () => {
    expect(
      filesToRead(
        ['src/gql/graphql.ts', 'src/gql/deep/x.ts', 'src/gqlx.ts', 'rules-text/a.txt', 'b.ts'],
        ['src/gql/**', 'rules-text/*.txt'],
      ),
    ).toEqual(['src/gqlx.ts', 'b.ts']);
    expect(
      unreadFiles(['src/gql/a.ts', 'b.ts'], [], { repoDir: REPO, skip: ['src/gql/**'] }),
    ).toEqual(['b.ts']);
  });

  it('turns globs into whole-path patterns', () => {
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('**/x.ts').test('x.ts')).toBe(true);
    expect(globToRegExp('**/x.ts').test('a/b/x.ts')).toBe(true);
    expect(globToRegExp('a/**').test('a/b/c')).toBe(true);
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
    expect(globToRegExp('a?.ts').test('a/.ts')).toBe(false);
    expect(globToRegExp('a.(b)+.ts').test('a.(b)+.ts')).toBe(true);
    expect(globToRegExp('a.ts').test('axts')).toBe(false);
  });
});

describe('carried-over files', () => {
  it('need no reading, while every other file still does', () => {
    const calls = [bash(`git diff -M ${RANGE} -- src/a.ts`)];
    expect(unreadFiles(changed, calls, { repoDir: REPO, carried: ['src/b.ts'] })).toEqual([
      '__tests__/unit/a.test.ts',
    ]);
    expect(unreadFiles(changed, [], { repoDir: REPO, carried: ['src/b.ts', 'gone.ts'] })).toEqual([
      'src/a.ts',
      '__tests__/unit/a.test.ts',
    ]);
    expect(unreadFiles(changed, [], { repoDir: REPO, carried: changed })).toEqual([]);
  });
});

describe('deleted files', () => {
  const files = ['src/a.ts', 'src/gone.ts', 'src/old.test.ts'];
  const removed = ['src/gone.ts', 'src/old.test.ts'];
  /** What the calls count as read, with gone.ts and old.test.ts deleted. */
  const covered = (/** @type {ToolCall[]} */ ...calls) => {
    const unread = new Set(unreadFiles(files, calls, { repoDir: REPO, removed }));
    return files.filter((f) => !unread.has(f));
  };

  it('are covered by a listing of the PR that shows they went', () => {
    for (const flags of [
      '--name-status',
      '--name-status -M',
      '--summary -M50%',
      '--name-status --find-renames=40% -z --no-color',
      '--name-status --no-renames',
      '--name-status --diff-filter=D',
      '--name-status --diff-filter=AMD',
    ]) {
      expect(covered(bash(`git diff ${flags} ${RANGE}`)), flags).toEqual(removed);
    }
    expect(covered(bash(`cd ${REPO} && git diff --name-status origin/main HEAD`))).toEqual(removed);
    expect(covered(bash(`cd "${REPO}/" && git diff --name-status ${RANGE}`))).toEqual(removed);
    expect(covered(bash(`git diff --name-status ${RANGE} -- src/old.test.ts`))).toEqual([
      'src/old.test.ts',
    ]);
    expect(covered(bash(`git diff --summary ${RANGE} -- src/`))).toEqual(removed);
  });

  it('are still covered by a full read of their diff', () => {
    expect(covered(bash(`git diff -M ${RANGE} -- src/gone.ts`))).toEqual(['src/gone.ts']);
  });

  it("aren't covered by a listing that may leave them out, shorten or flip them, or isn't the PR's", () => {
    for (const command of [
      `git diff --name-only ${RANGE}`,
      `git diff --stat ${RANGE}`,
      `git diff --numstat ${RANGE}`,
      `git diff --compact-summary ${RANGE}`,
      `git diff --dirstat ${RANGE}`,
      `git diff --shortstat ${RANGE}`,
      `git diff --name-status --stat ${RANGE}`,
      `git diff --name-status --diff-filter=M ${RANGE}`,
      `git diff --name-status --diff-filter=d ${RANGE}`,
      `git diff --name-status --diff-filter=Dd ${RANGE}`,
      `git diff --name-status --diff-filter ${RANGE}`,
      `git diff --name-status -Sfoo ${RANGE}`,
      `git diff --name-status -Gfoo ${RANGE}`,
      `git diff --name-status --relative=src ${RANGE}`,
      `git diff --name-status --relative ${RANGE}`,
      `git diff -R --name-status --diff-filter=D ${RANGE}`,
      `git diff --name-status --skip-to=src/z ${RANGE}`,
      `git diff --name-status --quiet ${RANGE}`,
      `git diff --name-status --exit-code ${RANGE}`,
      `git diff --name-status -s ${RANGE}`,
      `git diff --name-status --output=/tmp/x ${RANGE}`,
      'git diff --name-status',
      'git diff --name-status HEAD~1 HEAD',
      `git diff --name-status ${RANGE} -- src/a.ts`,
      `git diff --name-status ${RANGE} -- ':!src/a.ts'`,
      `git diff --name-status ${RANGE} | grep D`,
      `cd api && git diff --name-status ${RANGE} -- .`,
      `cd /home/runner/work/_actions/jbhirsh/ci/main && git diff --name-status ${RANGE}`,
      'gh pr diff 307 --name-only',
      `git log --name-status ${RANGE}`,
      `git show --name-status HEAD`,
    ]) {
      expect(covered(bash(command)), command).toEqual([]);
    }
    expect(covered({ ...bash(`git diff --name-status ${RANGE}`), failed: true })).toEqual([]);
  });

  it('count a cut-off listing only once its saved output was opened', () => {
    const cut = 'Output too large (80KB). Full output saved to: /tmp/out-9.txt\n\nPreview: D\tx';
    const listing = bash(`git diff --name-status ${RANGE}`, cut);
    expect(covered(listing)).toEqual([]);
    expect(covered(listing, read('/tmp/out-9.txt'))).toEqual(removed);
  });

  it('are covered only when deleted: a listing reads no kept file', () => {
    expect(
      unreadFiles(files, [bash(`git diff --name-status ${RANGE}`)], { repoDir: REPO }),
    ).toEqual(files);
  });

  it("run as BoardGames #307's did: the deleted files listed, the rest read", () => {
    const pr = [
      'src/data/wishlist.ts',
      'src/__tests__/useSuggestions.test.tsx',
      'src/__tests__/useLinkToken.test.tsx',
      'src/__tests__/mergeWishlist.test.ts',
      'src/context/GamesContext.tsx',
    ];
    const calls = [
      bash(`git diff --stat -M ${RANGE}`),
      bash(`git diff --name-status -M ${RANGE}`),
      bash(`git diff -M ${RANGE} -- src/context/GamesContext.tsx`),
    ];
    expect(unreadFiles(pr, calls, { repoDir: REPO })).toEqual(pr.slice(0, 4));
    expect(unreadFiles(pr, calls, { repoDir: REPO, removed: pr.slice(0, 4) })).toEqual([]);
  });
});

describe('main', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'coverage-'));
  const file = (/** @type {string} */ name, /** @type {unknown} */ value) => {
    const full = path.join(dir, name);
    writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value));
    return full;
  };
  const pass = file('pass.json', [
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'a',
            name: 'Bash',
            input: { command: `git diff ${RANGE} -- a.ts` },
          },
        ],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'diff' }] },
    },
  ]);

  it('reads the changed files from stdin and the passes from their files', () => {
    const warn = /** @type {string[]} */ ([]);
    const env = { REPO_DIR: REPO, SKIP: 'gen/**\n\n' };
    expect(main([pass], 'a.ts\n b.ts \n\ngen/x.ts\n', env, (m) => warn.push(m))).toEqual(['b.ts']);
    expect(warn).toEqual([]);
  });

  it('counts an unreadable execution file as a pass that read nothing', () => {
    const warn = /** @type {string[]} */ ([]);
    const broken = file('broken.json', '{');
    expect(
      main([broken, path.join(dir, 'missing.json')], 'a.ts\n', {}, (m) => warn.push(m)),
    ).toEqual(['a.ts']);
    expect(warn).toHaveLength(2);
  });

  it('takes the carried-over files from CARRIED', () => {
    expect(main([], 'a.ts\nb.ts\n', { CARRIED: 'b.ts\n\n' }, () => {})).toEqual(['a.ts']);
  });

  it('takes the deleted files from REMOVED', () => {
    const listing = file('listing.json', [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'l',
              name: 'Bash',
              input: { command: `git diff --name-status ${RANGE}` },
            },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'l', content: 'D\tb.ts' }] },
      },
    ]);
    expect(main([listing], 'a.ts\nb.ts\n', { REMOVED: 'b.ts\n\n' }, () => {})).toEqual(['a.ts']);
    expect(main([listing], 'a.ts\nb.ts\n', {}, () => {})).toEqual(['a.ts', 'b.ts']);
  });

  it('takes the base branch from BASE_REF', () => {
    expect(main([pass], 'a.ts\n', { BASE_REF: 'develop' }, () => {})).toEqual(['a.ts']);
  });
});
