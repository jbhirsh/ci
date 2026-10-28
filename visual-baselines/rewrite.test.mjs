import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runIn } from './baselines.mjs';
import { main, rewrite } from './rewrite.mjs';
import { settings } from './settings.mjs';
import { repo } from './test-repo.mjs';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('rewrite', () => {
  it('stops before touching anything when not on a branch', () => {
    const { root, git } = repo({
      '.github/ci.json': JSON.stringify({
        'visual-baselines': { folders: ['shots'], command: 'x' },
      }),
      'shots/a.png': 'a',
    });
    vi.stubEnv('GITHUB_REF_NAME', 'v1');
    vi.stubEnv('GITHUB_REF_TYPE', 'tag');
    expect(() => main(root)).toThrow(/runs on a branch/);
    expect(git('status', '--porcelain')).toBe('');
  });

  it('wipes the folders, runs the command, then commits', () => {
    const { root, git } = repo({ 'shots/a-snapshots/old.png': 'old' });
    /** @type {string[]} */
    const commands = [];
    const committed = rewrite({
      root,
      s: settings({ folders: ['shots/*-snapshots'], command: 'make shots' }),
      run: runIn(root),
      shell: (command) => {
        commands.push(command);
        mkdirSync(path.join(root, 'shots/a-snapshots'), { recursive: true });
        writeFileSync(path.join(root, 'shots/a-snapshots/new.png'), 'new');
      },
      branch: 'topic',
      by: 'a test',
    });
    expect(committed).toBe(true);
    expect(commands).toEqual(['make shots']);
    expect(git('ls-files').trim()).toBe('shots/a-snapshots/new.png');
  });

  it('needs a command', () => {
    expect(() =>
      rewrite({
        root: '/nowhere',
        s: settings({ folders: ['a'] }),
        run: () => '',
        shell: () => {},
        branch: 'topic',
        by: 'x',
      }),
    ).toThrow(/command is needed/);
  });

  it('reads its settings, branch and author from the app and the environment', () => {
    const { root, git } = repo({
      '.github/ci.json': JSON.stringify({
        'visual-baselines': {
          folders: ['shots'],
          command: 'mkdir -p shots && echo b > shots/a.png',
        },
      }),
      'shots/a.png': 'a',
    });
    vi.stubEnv('GITHUB_REF_NAME', 'topic');
    vi.stubEnv('GITHUB_REF_TYPE', 'branch');
    vi.stubEnv('REWRITTEN_BY', 'visual-baselines.yml (run 1)');
    expect(main(root)).toBe(true);
    expect(git('log', '-1', '--format=%b').trim()).toBe(
      'Rewritten on CI by visual-baselines.yml (run 1).',
    );
  });
});
