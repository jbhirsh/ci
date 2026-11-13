import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runIn } from './baselines.mjs';
import { main, rewrite } from './rewrite.mjs';
import { settings } from './settings.mjs';
import { repo } from './test-repo.mjs';
import { VERIFY, apiRun, fake } from './test-github.mjs';

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

  it('keeps a baseline the command only wrote again, running it once more to judge', () => {
    const { root, git } = repo({
      'shots/a-snapshots/noise.png': 'noise',
      'shots/a-snapshots/moved.png': 'moved',
      'shots/a-snapshots/same.png': 'same',
      'shots/a-snapshots/gone.png': 'gone',
    });
    const file = (/** @type {string} */ name) => path.join(root, 'shots/a-snapshots', name);
    /** @type {Record<string, string>[]} */
    const seen = [];
    let runs = 0;
    const committed = rewrite({
      root,
      s: settings({ folders: ['shots/*-snapshots'], command: 'make shots' }),
      run: runIn(root),
      shell: () => {
        runs++;
        mkdirSync(path.join(root, 'shots/a-snapshots'), { recursive: true });
        if (runs === 1) {
          // Every screenshot afresh: noise differs by a pixel, one moved,
          // one is new, and nothing takes gone.png any more.
          writeFileSync(file('noise.png'), 'noise, a pixel off');
          writeFileSync(file('moved.png'), 'moved, for real');
          writeFileSync(file('same.png'), 'same');
          writeFileSync(file('new.png'), 'new');
          return;
        }
        // Playwright's "changed" mode: rewrites only what fails its
        // comparison, which the noise passes.
        seen.push(
          Object.fromEntries(
            ['noise.png', 'moved.png', 'same.png', 'new.png', 'gone.png'].map((n) => [
              n,
              existsSync(file(n)) ? readFileSync(file(n), 'utf8') : '(none)',
            ]),
          ),
        );
        writeFileSync(file('moved.png'), 'moved, for real');
      },
      branch: 'topic',
      by: 'a test',
    });
    expect(committed).toBe(true);
    expect(runs).toBe(2);
    // The second run compares with the committed versions of the two it
    // wrote again, and sees the new one and no gone one.
    expect(seen).toEqual([
      {
        'noise.png': 'noise',
        'moved.png': 'moved',
        'same.png': 'same',
        'new.png': 'new',
        'gone.png': '(none)',
      },
    ]);
    expect(git('show', '--name-status', '--format=', 'HEAD').trim().split('\n').sort()).toEqual([
      'A\tshots/a-snapshots/new.png',
      'D\tshots/a-snapshots/gone.png',
      'M\tshots/a-snapshots/moved.png',
    ]);
    expect(git('show', 'HEAD:shots/a-snapshots/noise.png')).toBe('noise');
  });

  it('runs the command once when it wrote nothing again differently', () => {
    const { root, git } = repo({ 'shots/a.png': 'a' });
    let runs = 0;
    const committed = rewrite({
      root,
      s: settings({ folders: ['shots'], command: 'make shots' }),
      run: runIn(root),
      shell: () => {
        runs++;
        mkdirSync(path.join(root, 'shots'), { recursive: true });
        writeFileSync(path.join(root, 'shots/a.png'), 'a');
      },
      branch: 'topic',
      by: 'a test',
    });
    expect(committed).toBe(false);
    expect(runs).toBe(1);
    expect(git('status', '--porcelain')).toBe('');
  });

  it('with verify, amends the head commit and carries its checks over, or pushes nothing', () => {
    for (const passes of [true, false]) {
      const { root, git, remote } = repo({ 'shots/a.png': 'old' });
      const a = git('rev-parse', 'HEAD').trim();
      const f = fake({
        results: (sha) =>
          sha === a ? { runs: [apiRun(1, 'Unit', 'success'), apiRun(2, 'Lint', 'success')] } : {},
      });
      /** @type {string[]} */
      const commands = [];
      const go = () =>
        rewrite({
          root,
          s: settings({ folders: ['shots'], command: 'make shots', verify: VERIFY }),
          run: runIn(root),
          shell: (command) => {
            commands.push(command);
            if (command === VERIFY.command && !passes) throw new Error('exit 1');
            mkdirSync(path.join(root, 'shots'), { recursive: true });
            writeFileSync(path.join(root, 'shots/a.png'), 'new');
          },
          branch: 'topic',
          by: 'a test',
          github: () => f.github,
        });
      const remoteHead = () =>
        execFileSync('git', ['--git-dir', remote, 'rev-parse', 'topic'], {
          encoding: 'utf8',
        }).trim();
      if (passes) {
        expect(go()).toBe(true);
        expect(remoteHead()).toBe(git('rev-parse', 'HEAD').trim());
        expect(git('rev-list', '--count', 'HEAD').trim()).toBe('1');
        expect(f.posted().map((c) => c.body?.name)).toEqual(['E2E', 'Unit', 'Lint']);
      } else {
        expect(go).toThrow(/E2E failed on \w{7} with the new baselines/);
        expect(remoteHead()).toBe(a);
        expect(f.posted()).toEqual([]);
      }
      // Written again differently, so the command runs twice (rewrite's
      // header), then the check once.
      expect(commands).toEqual(['make shots', 'make shots', VERIFY.command]);
    }
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
