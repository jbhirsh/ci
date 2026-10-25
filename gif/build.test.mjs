import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addBaseTree,
  build,
  buildArgs,
  buildEnv,
  freePort,
  git,
  remoteBranch,
  serve,
  stopServers,
} from './build.mjs';

const temp = () => mkdtempSync(path.join(tmpdir(), 'gif-build-'));

// An app whose Vite is a stand-in: `build` writes what it was asked into
// outDir, `preview` answers on its port (or, with GIF_FAKE_PREVIEW set,
// exits, or never listens).
function fakeApp() {
  const root = temp();
  mkdirSync(path.join(root, 'node_modules', 'vite', 'bin'), { recursive: true });
  writeFileSync(
    path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
    `import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const [command, ...args] = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (command === 'build') {
  mkdirSync(value('--outDir'), { recursive: true });
  writeFileSync(value('--outDir') + '/built.json', JSON.stringify({ args, cwd: process.cwd(), env: process.env.GIF_TEST_ENV ?? null, gone: process.env.GIF_TEST_GONE ?? null }));
} else if (process.env.GIF_FAKE_PREVIEW === 'exit') {
  process.exit(3);
} else if (process.env.GIF_FAKE_PREVIEW === 'silent') {
  setTimeout(() => {}, 60_000);
} else {
  createServer((_, res) => res.end('ok')).listen(Number(value('--port')), value('--host'));
}
`,
  );
  return root;
}

afterEach(() => {
  delete process.env.GIF_FAKE_PREVIEW;
  delete process.env.GIF_TEST_GONE;
});

describe('remoteBranch', () => {
  it("names a remote's branch to fetch, and nothing for any other ref", () => {
    expect(remoteBranch('origin/main')).toEqual({ remote: 'origin', branch: 'main' });
    expect(remoteBranch('upstream/feature/x')).toEqual({ remote: 'upstream', branch: 'feature/x' });
    expect(remoteBranch('main')).toBeNull();
    expect(remoteBranch('abc123')).toBeNull();
  });
});

describe('buildEnv and buildArgs', () => {
  it("sets the settings' variables over the shell's, and drops the ones it names", () => {
    expect(
      buildEnv(
        { PATH: '/bin', SENTRY_AUTH_TOKEN: 'secret', VERCEL_ENV: 'preview' },
        { mode: undefined, env: { VERCEL_ENV: 'production' }, unsetEnv: ['SENTRY_AUTH_TOKEN'] },
      ),
    ).toEqual({ PATH: '/bin', VERCEL_ENV: 'production' });
  });

  it('builds into outDir, in the mode asked if any', () => {
    expect(buildArgs('vite.js', 'dist', 'test')).toEqual([
      'vite.js',
      'build',
      '--mode',
      'test',
      '--outDir',
      'dist',
      '--emptyOutDir',
      '--logLevel',
      'error',
    ]);
    expect(buildArgs('vite.js', 'dist', undefined)).not.toContain('--mode');
  });
});

describe('build', () => {
  it("runs the app's Vite in the tree asked, with the settings' environment", () => {
    const root = fakeApp();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.GIF_TEST_GONE = 'here';
    try {
      const outDir = path.join(root, 'out');
      build({
        root,
        cwd: root,
        outDir,
        mode: 'test',
        settings: { mode: undefined, env: { GIF_TEST_ENV: 'set' }, unsetEnv: ['GIF_TEST_GONE'] },
      });
      const built = JSON.parse(readFileSync(path.join(outDir, 'built.json'), 'utf8'));
      expect(built.args).toEqual([
        '--mode',
        'test',
        '--outDir',
        outDir,
        '--emptyOutDir',
        '--logLevel',
        'error',
      ]);
      expect(built).toMatchObject({ env: 'set', gone: null });
      expect(log).toHaveBeenCalledWith('pr-gif: building this working tree');
      build({
        root,
        cwd: outDir,
        outDir: path.join(root, 'out2'),
        mode: undefined,
        settings: { mode: undefined, env: {}, unsetEnv: [] },
      });
      expect(log).toHaveBeenLastCalledWith('pr-gif: building the base');
    } finally {
      log.mockRestore();
    }
  });
});

describe('freePort', () => {
  it('finds a port that can be listened on', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    await new Promise((done, failed) => {
      const server = createServer();
      server.once('error', failed);
      server.listen(port, '127.0.0.1', () => server.close(() => done(undefined)));
    });
  });
});

describe('serve and stopServers', () => {
  it('serves a build until stopped, resolving once it answers', async () => {
    const root = fakeApp();
    /** @type {import('node:child_process').ChildProcess[]} */
    const servers = [];
    const origin = await serve({ root, outDir: 'dist', host: '127.0.0.1', servers });
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(origin)).text()).toBe('ok');
    const [server] = servers;
    await stopServers(servers);
    expect(servers).toEqual([]);
    expect(server.signalCode ?? server.exitCode).not.toBeNull();
    // Stopping what has stopped is nothing.
    await stopServers([server]);
  });

  it('says so when the server exits, or never answers', async () => {
    const root = fakeApp();
    /** @type {import('node:child_process').ChildProcess[]} */
    const servers = [];
    process.env.GIF_FAKE_PREVIEW = 'exit';
    await expect(serve({ root, outDir: 'dist', host: '127.0.0.1', servers })).rejects.toThrow(
      'vite preview exited with 3',
    );
    process.env.GIF_FAKE_PREVIEW = 'silent';
    await expect(
      serve({ root, outDir: 'dist', host: '127.0.0.1', servers, timeoutMs: 300 }),
    ).rejects.toThrow("vite preview didn't answer on http://127.0.0.1:");
    await stopServers(servers);
  }, 15_000);
});

// A repository with one commit on main, pushed to an origin beside it.
function repo() {
  const dir = temp();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  /** @param {string[]} args */
  const raw = (...args) =>
    execFileSync('git', args, {
      cwd: path.join(dir, 'app'),
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  execFileSync('git', ['init', '-q', '--bare', path.join(dir, 'origin.git')], { env });
  mkdirSync(path.join(dir, 'app', 'node_modules'), { recursive: true });
  raw('init', '-q', '-b', 'main');
  raw('config', 'user.email', 't@example.com');
  raw('config', 'user.name', 'T');
  raw('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'app', 'a.txt'), 'main');
  writeFileSync(path.join(dir, 'app', '.gitignore'), 'node_modules\n');
  raw('add', 'a.txt', '.gitignore');
  raw('commit', '-q', '-m', 'one');
  raw('remote', 'add', 'origin', path.join(dir, 'origin.git'));
  raw('push', '-q', 'origin', 'main');
  return { dir, root: path.join(dir, 'app') };
}

describe('git and addBaseTree', () => {
  it("checks a remote's ref out, fetched first, borrowing the checkout's node_modules", () => {
    const { dir, root } = repo();
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    const tree = path.join(dir, 'base');
    addBaseTree(root, 'origin/main', tree);
    expect(readFileSync(path.join(tree, 'a.txt'), 'utf8')).toBe('main');
    expect(lstatSync(path.join(tree, 'node_modules')).isSymbolicLink()).toBe(true);
    git(root, 'worktree', 'remove', '--force', tree);
    expect(existsSync(tree)).toBe(false);
  });

  it("uses the copy here when the remote can't be reached, saying so", () => {
    const { dir, root } = repo();
    git(root, 'fetch', '-q', 'origin');
    git(root, 'remote', 'set-url', 'origin', path.join(dir, 'gone.git'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      addBaseTree(root, 'origin/main', path.join(dir, 'base'));
      expect(warn).toHaveBeenCalledWith("pr-gif: couldn't fetch origin/main; using the copy here");
      addBaseTree(root, 'main', path.join(dir, 'base2'));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
