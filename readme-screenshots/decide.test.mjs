import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { changedSince, decide, main, workflowFile } from './decide.mjs';
import { settings } from './settings.mjs';

// Outputs print instead of reaching the real job's, should these run in Actions.
beforeEach(() => {
  vi.stubEnv('GITHUB_OUTPUT', '');
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return () => vi.restoreAllMocks();
});

const FOG = settings({
  shows: ['src/**', 'index.html', 'public/**', 'scripts/readme-screenshots.ts'],
  ignore: ['**/*.test.{ts,tsx}', 'src/test/**'],
});
const SHA = 'abcdef1234567890';

describe('workflowFile', () => {
  it('reads the workflow file from GITHUB_WORKFLOW_REF', () => {
    expect(
      workflowFile('jbhirsh/sift/.github/workflows/readme-screenshots.yml@refs/heads/main'),
    ).toBe('readme-screenshots.yml');
    expect(() => workflowFile(undefined)).toThrow('names no workflow');
  });
});

describe('decide', () => {
  it('retakes them when run by hand, or with nothing to count from', () => {
    expect(decide({ event: 'workflow_dispatch', since: SHA, changed: [], settings: FOG })).toEqual({
      capture: true,
      reason: 'run by workflow_dispatch',
      shown: [],
    });
    expect(decide({ event: 'push', since: null, changed: [], settings: FOG }).reason).toBe(
      'no finished run to count from',
    );
    expect(decide({ event: 'push', since: SHA, changed: null, settings: FOG }).reason).toBe(
      "abcdef1 isn't in the history",
    );
  });

  it('retakes them when what they show changed, tests and test helpers aside', () => {
    const verdict = decide({
      event: 'push',
      since: SHA,
      changed: ['README.md', 'src/App.tsx', 'src/App.test.tsx', 'scripts/readme-screenshots.ts'],
      settings: FOG,
    });
    expect(verdict).toEqual({
      capture: true,
      reason: 'what they show changed since abcdef1',
      shown: ['src/App.tsx', 'scripts/readme-screenshots.ts'],
    });
  });

  it('keeps them when nothing they show changed', () => {
    expect(
      decide({
        event: 'push',
        since: SHA,
        changed: ['README.md', 'src/test/setup.ts', 'src/a.test.ts', 'api/x.ts'],
        settings: FOG,
      }).capture,
    ).toBe(false);
  });
});

describe('changedSince', () => {
  it('lists the files changed since the commit, or null when it is gone', () => {
    const run = vi.fn((/** @type {string} */ _, /** @type {string[]} */ args) =>
      args[0] === 'diff' ? 'a.ts\nsrc/b.tsx\n' : '',
    );
    expect(changedSince(SHA, run)).toEqual(['a.ts', 'src/b.tsx']);
    expect(run).toHaveBeenCalledWith('git', ['diff', '--name-only', SHA, 'HEAD']);
    expect(
      changedSince(SHA, () => {
        throw new Error('missing');
      }),
    ).toBeNull();
  });
});

describe('main', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'decide-'));
  const env = {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/readme-screenshots.yml@refs/heads/main',
  };

  it('finds the last finished run of this workflow on main, and diffs from it', () => {
    const calls = /** @type {string[][]} */ ([]);
    const lines = main(
      env,
      (command, args) => {
        calls.push([command, ...args]);
        if (command === 'gh') return `${SHA}\n`;
        return args[0] === 'diff' ? 'src/App.tsx\n' : '';
      },
      root,
    );
    expect(calls[0]).toEqual(
      expect.arrayContaining(['gh', 'run', 'list', '--workflow', 'readme-screenshots.yml']),
    );
    expect(calls[0]).toEqual(expect.arrayContaining(['--branch', 'main', '--status', 'success']));
    expect(lines).toEqual([
      'readme-screenshots: retake them: what they show changed since abcdef1.',
      '  src/App.tsx',
    ]);
  });

  it('retakes them with no finished run, and asks nothing when run by hand', () => {
    expect(main(env, () => '', root)[0]).toContain('no finished run to count from');
    const run = vi.fn(() => '');
    expect(main({ GITHUB_EVENT_NAME: 'workflow_dispatch' }, run, root)[0]).toContain(
      'run by workflow_dispatch',
    );
    expect(main({}, run, root)[0]).toContain('run by local');
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps them when nothing they show changed', () => {
    expect(main(env, (c) => (c === 'gh' ? SHA : ''), root)[0]).toBe(
      'readme-screenshots: keep them: nothing they show changed since abcdef1.',
    );
  });
});
