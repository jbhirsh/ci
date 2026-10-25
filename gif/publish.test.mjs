import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  BRANCH_VERCEL_JSON,
  GIF_WARN_BYTES,
  gifNames,
  gitIn,
  markdownTable,
  publishFiles,
  rawUrl,
  repoFromRemote,
  sizeNote,
} from './publish.mjs';

describe('repoFromRemote', () => {
  it.each([
    'https://github.com/jbhirsh/BoardGames',
    'https://github.com/jbhirsh/BoardGames.git',
    'https://x-access-token:abc@github.com/jbhirsh/BoardGames.git',
    'https://github.com/jbhirsh/BoardGames/',
    'git@github.com:jbhirsh/BoardGames.git',
    'git@github.com-work:jbhirsh/BoardGames.git',
    'ssh://git@github.com/jbhirsh/BoardGames.git',
    'ssh://git@ssh.github.com:443/jbhirsh/BoardGames.git',
    'http://127.0.0.1:41799/git/jbhirsh/BoardGames',
    'http://localhost/git/jbhirsh/BoardGames.git',
    '  https://github.com/jbhirsh/BoardGames\n',
  ])('reads owner/name from %s', (url) => {
    expect(repoFromRemote(url)).toBe('jbhirsh/BoardGames');
  });

  it("refuses a remote that isn't GitHub, asking for --repo", () => {
    expect(() => repoFromRemote('https://gitlab.com/jbhirsh/BoardGames.git')).toThrow(
      "origin isn't a GitHub repository",
    );
    expect(() => repoFromRemote('not a url')).toThrow('pass --repo owner/name');
  });

  it('reads back any owner and name from a GitHub remote, or refuses, never anything else', () => {
    const part = fc
      .stringMatching(/^[\w-][\w.-]{0,20}$/)
      .filter((s) => !s.endsWith('.git') && !s.endsWith('.'));
    fc.assert(
      fc.property(part, part, (owner, name) => {
        expect(repoFromRemote(`https://github.com/${owner}/${name}.git`)).toBe(`${owner}/${name}`);
        expect(repoFromRemote(`git@github.com:${owner}/${name}`)).toBe(`${owner}/${name}`);
      }),
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (url) => {
        try {
          expect(repoFromRemote(url)).toMatch(/^[\w.-]+\/[\w.-]+$/);
        } catch (error) {
          expect(String(error)).toMatch(/isn't a GitHub repository/);
        }
      }),
    );
  });
});

describe('rawUrl and gifNames', () => {
  it('links a file at one commit, and names a scenario’s GIFs after it', () => {
    expect(rawUrl('o/r', 'abc123', '263/flow-after.gif')).toBe(
      'https://raw.githubusercontent.com/o/r/abc123/263/flow-after.gif',
    );
    expect(gifNames('open-activity')).toEqual({
      before: 'open-activity-before.gif',
      after: 'open-activity-after.gif',
      side: 'open-activity-side-by-side.gif',
    });
  });
});

describe('markdownTable', () => {
  const repo = 'o/r';
  const sha = 'abc123';

  it('a Before | After row per scenario, linked by the commit SHA', () => {
    const table = markdownTable(
      repo,
      sha,
      [
        {
          name: 'swipe',
          before: '1/swipe-before.gif',
          after: '1/swipe-after.gif',
          sideBySide: null,
        },
        { name: 'new-sheet', before: null, after: '1/new-sheet-after.gif', sideBySide: null },
      ],
      { width: 260 },
    );
    expect(table.split('\n')).toEqual([
      '| Scenario | Before (`main`) | After |',
      '|---|---|---|',
      `| swipe | <img src="${rawUrl(repo, sha, '1/swipe-before.gif')}" width="260"> | <img src="https://raw.githubusercontent.com/o/r/abc123/1/swipe-after.gif" width="260"> |`,
      `| new-sheet | (none) | <img src="${rawUrl(repo, sha, '1/new-sheet-after.gif')}" width="260"> |`,
    ]);
  });

  it('side-by-side GIFs get their own table, twice as wide, and "before" names its base', () => {
    const table = markdownTable(
      repo,
      sha,
      [
        { name: 'swipe', before: null, after: null, sideBySide: 's.gif' },
        { name: 'only-after', before: null, after: 'x.gif', sideBySide: null },
      ],
      { base: 'release' },
    );
    expect(table.split('\n')).toEqual([
      '| Scenario | Before / After |',
      '|---|---|',
      `| swipe | <img src="${rawUrl(repo, sha, 's.gif')}" width="800"> |`,
      '',
      '| Scenario | Before (`release`) | After |',
      '|---|---|---|',
      `| only-after | (none) | <img src="${rawUrl(repo, sha, 'x.gif')}" width="400"> |`,
    ]);
  });
});

describe('sizeNote', () => {
  it('says how big a GIF is', () => {
    expect(sizeNote('a.gif', 230_366)).toBe('pr-gif: a.gif is 225 KB');
    expect(sizeNote('a.gif', 1024 * 1024 * 1.5)).toBe('pr-gif: a.gif is 1.5 MB');
  });

  it('warns once it’s over 5 MB, which a PR may not show', () => {
    expect(GIF_WARN_BYTES).toBe(5 * 1024 * 1024);
    expect(sizeNote('a.gif', GIF_WARN_BYTES)).toBe('pr-gif: a.gif is 5.0 MB');
    expect(sizeNote('a.gif', GIF_WARN_BYTES + 1)).toMatch(
      /^pr-gif: a\.gif is 5\.0 MB, over 5 MB, which a PR may not show/,
    );
  });
});

// A repository with an origin (a bare repository beside it), and a picture.
function repos() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gif-publish-'));
  const origin = path.join(dir, 'origin.git');
  const app = path.join(dir, 'app');
  // Never the hooks' GIT_* variables: they'd point these at another repository.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  /** @param {string[]} args */
  const raw = (...args) => execFileSync('git', args, { encoding: 'utf8', env }).trim();
  raw('init', '-q', '--bare', origin);
  raw('init', '-q', app);
  for (const [k, v] of [
    ['user.name', 'Test'],
    ['user.email', 'test@example.com'],
    ['commit.gpgsign', 'false'],
  ]) {
    raw('-C', app, 'config', k, v);
  }
  raw('-C', app, 'remote', 'add', 'origin', origin);
  const gif = path.join(dir, 'a.gif');
  writeFileSync(gif, 'GIF89a');
  return { dir, origin, app, gif, raw };
}

describe('gitIn', () => {
  it('runs git in the checkout, and throws on a failure unless allowed to', () => {
    const { app } = repos();
    const git = gitIn(app);
    expect(git(['rev-parse', '--is-inside-work-tree']).stdout.trim()).toBe('true');
    expect(git(['rev-parse', 'nope'], { allowFail: true }).status).not.toBe(0);
    expect(() => git(['rev-parse', 'nope'])).toThrow('git rev-parse failed');
  });
});

describe('publishFiles', () => {
  it('starts a branch origin lacks, with deploys off, and pushes it', () => {
    const { app, origin, gif, raw } = repos();
    const log = vi.fn();
    const sha = publishFiles(gitIn(app), [['7/flow-after.gif', gif]], {
      message: 'Add GIFs',
      branch: 'screenshots',
      push: true,
      log,
    });
    expect(raw('-C', origin, 'rev-parse', 'refs/heads/screenshots')).toBe(sha);
    expect(raw('-C', origin, 'ls-tree', '-r', '--name-only', sha).split('\n')).toEqual([
      '7/flow-after.gif',
      'vercel.json',
    ]);
    expect(raw('-C', origin, 'show', `${sha}:vercel.json`)).toBe(BRANCH_VERCEL_JSON.trim());
    expect(raw('-C', origin, 'log', '--format=%s', sha)).toBe('Add GIFs');
    expect(log).toHaveBeenCalledWith(`pr-gif: pushed ${sha.slice(0, 7)} to screenshots`);
    // The checkout's own index and branch are never touched.
    expect(raw('-C', app, 'status', '--porcelain')).toBe('');
  });

  it('adds to the tip of a branch origin has, keeping what is there', () => {
    const { app, origin, gif, raw } = repos();
    const first = publishFiles(gitIn(app), [['7/a.gif', gif]], {
      message: 'one',
      branch: 'screenshots',
      push: true,
      log: () => {},
    });
    const second = publishFiles(gitIn(app), [['8/b.gif', gif]], {
      message: 'two',
      branch: 'screenshots',
      push: true,
      log: () => {},
    });
    expect(raw('-C', origin, 'rev-parse', `${second}^`)).toBe(first);
    expect(raw('-C', origin, 'ls-tree', '-r', '--name-only', second).split('\n')).toEqual([
      '7/a.gif',
      '8/b.gif',
      'vercel.json',
    ]);
  });

  it('commits without pushing when asked, saying how to push it', () => {
    const { app, origin, gif, raw } = repos();
    const log = vi.fn();
    const sha = publishFiles(gitIn(app), [['7/a.gif', gif]], {
      message: 'one',
      branch: 'screenshots',
      push: false,
      log,
    });
    expect(raw('-C', app, 'cat-file', '-t', sha)).toBe('commit');
    expect(() =>
      raw('-C', origin, 'rev-parse', '--verify', '-q', 'refs/heads/screenshots'),
    ).toThrow();
    expect(log).toHaveBeenCalledWith(
      `pr-gif: committed ${sha} but didn't push it: git push origin ${sha}:refs/heads/screenshots`,
    );
  });

  it('tries again on the new tip when the branch moved on, then gives up saying how to push', () => {
    const { app, gif } = repos();
    const real = gitIn(app);
    let refusals = 0;
    /** @type {import('./publish.mjs').Git} */
    const racing = (args, options) => {
      if (args[0] === 'push' && refusals < 1) {
        refusals += 1;
        // Someone else's push lands first.
        publishFiles(real, [['x/other.gif', gif]], {
          message: 'other',
          branch: 'pics',
          push: true,
          log: () => {},
        });
        return { status: 1, stdout: '', stderr: 'rejected (fetch first)' };
      }
      return real(args, options);
    };
    const log = vi.fn();
    const sha = publishFiles(racing, [['7/a.gif', gif]], {
      message: 'mine',
      branch: 'pics',
      push: true,
      log,
    });
    expect(log).toHaveBeenCalledWith('pr-gif: pics moved on; adding the GIFs to its new tip…');
    expect(real(['ls-tree', '-r', '--name-only', sha]).stdout.trim().split('\n')).toEqual([
      '7/a.gif',
      'vercel.json',
      'x/other.gif',
    ]);
    /** @type {import('./publish.mjs').Git} */
    const refusing = (args, options) =>
      args[0] === 'push' ? { status: 1, stdout: '', stderr: 'denied' } : real(args, options);
    expect(() =>
      publishFiles(refusing, [['7/b.gif', gif]], {
        message: 'x',
        branch: 'pics',
        push: true,
        log: () => {},
      }),
    ).toThrow(
      /pushing [0-9a-f]+ to pics failed \(denied\); push it with: git push origin [0-9a-f]+:refs\/heads\/pics/,
    );
  });
});
