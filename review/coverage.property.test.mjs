import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { commandLine, filesToRead, globToRegExp, unreadFiles } from './coverage.mjs';

// Commands, paths and globs come from a model's tool calls, a PR's file
// list and an app's settings: anything at all.
const safeWord = fc.stringMatching(/^[A-Za-z0-9/._=:-]{1,12}$/);
const path = fc.stringMatching(/^[A-Za-z0-9_.-]{1,8}(\/[A-Za-z0-9_.-]{1,8}){0,3}$/);

describe('commandLine', () => {
  it('reads back plain words joined by spaces', () => {
    fc.assert(
      fc.property(fc.array(safeWord, { minLength: 1, maxLength: 8 }), (words) => {
        fc.pre(words[0] !== 'cd');
        expect(commandLine(words.join(' '))).toEqual({ cd: null, commands: [words], alone: true });
      }),
    );
  });

  it('turns away any command holding a chain or substitution outside quotes', () => {
    fc.assert(
      fc.property(
        safeWord,
        fc.constantFrom('||', ';', '&', '>', '<', '`', '$', '\n', '(', '#'),
        safeWord,
        (a, op, b) => {
          expect(commandLine(`git diff ${a} ${op} ${b}`)).toBeNull();
        },
      ),
    );
  });

  it('never throws, and gives null or a cd and lists of words', () => {
    fc.assert(
      fc.property(fc.string(), (command) => {
        const line = commandLine(command);
        expect(
          line === null ||
            line.commands.every((words) => words.every((w) => typeof w === 'string')),
        ).toBe(true);
      }),
    );
  });

  it('reads back read-only commands joined by &&, leaving out the piped ones', () => {
    const command = fc.tuple(
      fc.constantFrom('git diff', 'git log', 'cat', 'tail'),
      fc.array(safeWord, { maxLength: 4 }),
      fc.boolean(),
    );
    fc.assert(
      fc.property(fc.array(command, { minLength: 1, maxLength: 5 }), (commands) => {
        // `--output=<file>` writes a file: a line holding it reads nothing.
        fc.pre(commands.every(([, args]) => !args.some((w) => w.startsWith('--output'))));
        const text = commands
          .map(([tool, args, piped]) => [tool, ...args].join(' ') + (piped ? ' | tail -60' : ''))
          .join(' && ');
        const kept = commands
          .filter(([, , piped]) => !piped)
          .map(([tool, args]) => [...tool.split(' '), ...args]);
        const alone = commands.length === 1 && !commands[0][2];
        expect(commandLine(text)).toEqual({ cd: null, commands: kept, alone });
      }),
    );
  });
});

describe('globToRegExp', () => {
  it('never throws, and a glob with no wildcard matches only itself', () => {
    fc.assert(
      fc.property(fc.string(), (glob) => {
        const re = globToRegExp(glob);
        if (!/[*?]/.test(glob)) {
          expect(re.test(glob)).toBe(true);
          expect(re.test(`${glob}x`)).toBe(false);
        }
      }),
    );
  });

  it('`dir/**` matches every path under the folder', () => {
    fc.assert(
      fc.property(path, path, (dir, rest) => {
        expect(globToRegExp(`${dir}/**`).test(`${dir}/${rest}`)).toBe(true);
      }),
    );
  });
});

describe('filesToRead and unreadFiles', () => {
  it('keep a subset of the changed files, in order, and never a lockfile', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(path, fc.constant('package-lock.json'))), (files) => {
        const kept = filesToRead(files);
        expect(kept.every((f) => files.includes(f) && f !== 'package-lock.json')).toBe(true);
        expect(kept).toEqual(files.filter((f) => kept.includes(f)));
      }),
    );
  });

  it('a whole PR diff reads every file; no calls read none', () => {
    fc.assert(
      fc.property(fc.uniqueArray(path), (files) => {
        const all = [
          { name: 'Bash', input: { command: 'git diff origin/main...HEAD' }, result: '' },
        ];
        expect(unreadFiles(files, all, { repoDir: '/r' })).toEqual([]);
        expect(unreadFiles(files, [], { repoDir: '/r' })).toEqual(filesToRead(files));
      }),
    );
  });

  it('a listing of the PR covers exactly the deleted files, never a kept one', () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(path)
          .chain((files) =>
            fc.tuple(
              fc.constant(files),
              fc.subarray(files),
              fc.constantFrom('--name-status', '--summary'),
            ),
          ),
        ([files, removed, flag]) => {
          const listing = [
            {
              name: 'Bash',
              input: { command: `git diff ${flag} -M origin/main...HEAD` },
              result: '',
            },
          ];
          const unread = unreadFiles(files, listing, { repoDir: '/r', removed });
          expect(unread).toEqual(filesToRead(files).filter((f) => !removed.includes(f)));
        },
      ),
    );
  });

  it('a listing covers the deleted files alone or in an && chain, a stat only alone, a piped one none', () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(path)
          .chain((files) =>
            fc.tuple(
              fc.constant(files),
              fc.subarray(files),
              fc.constantFrom('--name-status', '--summary', '--stat', '--numstat'),
              fc.constantFrom(
                '',
                'git log -1 && ',
                `git diff --stat origin/main...HEAD | tail -60 && `,
              ),
              fc.boolean(),
            ),
          ),
        ([files, removed, flag, before, piped]) => {
          // The listing's whole output, as git prints it, or cut to nothing.
          const lines = files.map((f) =>
            flag === '--stat' ? ` ${f} | 3 ---` : flag === '--numstat' ? `0\t3\t${f}` : `D\t${f}`,
          );
          const listing = `git diff ${flag} -M origin/main...HEAD`;
          const command = `${before}${listing}${piped ? ' | tail -60' : ''}`;
          const result = piped ? '' : lines.join('\n');
          const calls = [{ name: 'Bash', input: { command }, result }];
          const unread = unreadFiles(files, calls, { repoDir: '/r', removed });
          const kept = filesToRead(files).filter((f) => !removed.includes(f));
          // A stat line counts only from a line that is the stat alone.
          const counts = !piped && (!['--stat', '--numstat'].includes(flag) || before === '');
          expect(unread).toEqual(counts ? kept : filesToRead(files));
        },
      ),
    );
  });

  it('a stat covers a deleted file only where its output shows the whole path', () => {
    fc.assert(
      fc.property(fc.uniqueArray(path, { minLength: 1 }), path, (files, other) => {
        fc.pre(!files.includes(other) && !files.includes(`.../${other}`));
        // A stat line for a path that isn't any of them: `.../x` or another file.
        const result = ` .../${other} | 3 ---\n ${other} | 3 ---\n0\t3\t${other}`;
        const calls = ['--stat', '--numstat'].map((flag) => ({
          name: 'Bash',
          input: { command: `git diff ${flag} origin/main...HEAD` },
          result,
        }));
        const unread = unreadFiles(files, calls, { repoDir: '/r', removed: files });
        expect(unread).toEqual(filesToRead(files));
      }),
    );
  });
});
