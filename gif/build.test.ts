import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addBaseTree,
  build,
  buildArgs,
  buildEnv,
  freePort,
  git,
  namesPort,
  remoteBranch,
  serve,
  stopServers,
} from './build.ts';
import type { ChildProcess } from 'node:child_process';

const temp = () => mkdtempSync(path.join(tmpdir(), 'gif-build-'));

// An app whose Vite is a stand-in: `build` writes what it was asked into
// outDir, `preview` listens on its port and then prints the line naming its
// address, as Vite does. GIF_FAKE_PREVIEW picks another preview: `colour`
// prints the line as Vite does in CI, its port in its own colour, and in two
// writes; `chatty`, after the line, writes 1 MB to stdout, more than a pipe
// holds, and answers only once all of it has been read; `missing` answers
// 404; `exit` exits with 3; `silent` listens but never says so.
function fakeApp() {
  const root = temp();
  mkdirSync(path.join(root, 'node_modules', 'vite', 'bin'), { recursive: true });
  writeFileSync(
    path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
    `import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const [command, ...args] = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const mode = process.env.GIF_FAKE_PREVIEW;
if (command === 'build') {
  mkdirSync(value('--outDir'), { recursive: true });
  writeFileSync(value('--outDir') + '/built.json', JSON.stringify({ args, cwd: process.cwd(), env: process.env.GIF_TEST_ENV ?? null, gone: process.env.GIF_TEST_GONE ?? null }));
} else if (mode === 'exit') {
  process.exit(3);
} else {
  const host = value('--host');
  const port = value('--port');
  let flushed;
  const read = new Promise((done) => (flushed = done));
  createServer((_, res) => {
    if (mode === 'missing') res.statusCode = 404;
    read.then(() => res.end('ok'));
  }).listen(Number(port), host, () => {
    if (mode === 'silent') return;
    if (mode === 'colour') {
      process.stdout.write('  \\x1b[32m➜\\x1b[39m  \\x1b[1mLocal\\x1b[22m:   \\x1b[36mhttp://' + host + ':');
      setTimeout(() => process.stdout.write('\\x1b[1m' + port + '\\x1b[22m/\\x1b[39m\\n'), 0);
    } else {
      process.stdout.write('  ➜  Local:   http://' + host + ':' + port + '/\\n');
    }
    if (mode === 'chatty') process.stdout.write('x'.repeat(1024 * 1024) + '\\n', flushed);
    else flushed();
  });
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

describe('namesPort', () => {
  const line =
    '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://127.0.0.1:\x1b[1m4173\x1b[22m/\x1b[39m\n';

  it("finds Vite's line for the port, through its colour codes and whatever host it names", () => {
    expect(namesPort(line, 4173)).toBe(true);
    expect(namesPort('  ➜  Local:   http://localhost:4173/\n', 4173)).toBe(true);
    expect(namesPort('  ➜  Network: http://[::1]:4173/\n', 4173)).toBe(true);
    expect(namesPort('  ➜  Local:   https://localhost:4173/\n', 4173)).toBe(true);
  });

  it('waits for the whole line, and for its own port', () => {
    // Each prefix of the line, as the pipe may cut it, until the slash after the port.
    const end = line.indexOf('/\x1b[39m');
    for (let at = 0; at <= end; at++) expect(namesPort(line.slice(0, at), 4173)).toBe(false);
    expect(namesPort(line.slice(0, end + 1), 4173)).toBe(true);
    expect(namesPort(line, 417)).toBe(false);
    expect(namesPort(line, 41730)).toBe(false);
    expect(namesPort('port 4173 is in use, trying another one\n', 4173)).toBe(false);
  });
});

describe('serve and stopServers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves a build until stopped, resolving once Vite names its address', async () => {
    const root = fakeApp();
    const servers: ChildProcess[] = [];
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

  it("reads the line through Vite's colour codes, however it is split", async () => {
    const root = fakeApp();
    const servers: ChildProcess[] = [];
    process.env.GIF_FAKE_PREVIEW = 'colour';
    const origin = await serve({ root, outDir: 'dist', host: 'localhost', servers });
    expect(origin).toMatch(/^http:\/\/localhost:\d+$/);
    expect(await (await fetch(origin)).text()).toBe('ok');
    await stopServers(servers);
  });

  it('keeps reading what the server prints, so a full pipe never stalls it', async () => {
    const root = fakeApp();
    const servers: ChildProcess[] = [];
    process.env.GIF_FAKE_PREVIEW = 'chatty';
    const origin = await serve({ root, outDir: 'dist', host: '127.0.0.1', servers });
    expect(await (await fetch(origin)).text()).toBe('ok');
    await stopServers(servers);
  });

  it("fails when the page at Vite's address doesn't answer", async () => {
    const root = fakeApp();
    const servers: ChildProcess[] = [];
    process.env.GIF_FAKE_PREVIEW = 'missing';
    await expect(serve({ root, outDir: 'dist', host: '127.0.0.1', servers })).rejects.toThrow(
      /^vite preview answered 404 on http:\/\/127\.0\.0\.1:\d+$/,
    );
    await stopServers(servers);
  });

  it('fails at once when the server exits, with its exit code', async () => {
    const root = fakeApp();
    const servers: ChildProcess[] = [];
    process.env.GIF_FAKE_PREVIEW = 'exit';
    await expect(serve({ root, outDir: 'dist', host: '127.0.0.1', servers })).rejects.toThrow(
      'vite preview exited with 3',
    );
  });

  it('fails at the hang limit when the server never says it is listening', async () => {
    const root = fakeApp();
    const servers: ChildProcess[] = [];
    process.env.GIF_FAKE_PREVIEW = 'silent';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // serve sets its limit once it has a port: wait for that timer, not any.
    const before = vi.getTimerCount();
    const served = serve({ root, outDir: 'dist', host: '127.0.0.1', servers, timeoutMs: 30_000 });
    const failed = expect(served).rejects.toThrow(
      "vite preview didn't say it was listening on http://127.0.0.1:",
    );
    await vi.waitUntil(() => vi.getTimerCount() > before);
    vi.advanceTimersByTime(30_000);
    await failed;
    await stopServers(servers);
  });
});

// A repository with one commit on main, pushed to an origin beside it. Built
// once (about a dozen git processes, each ~250 ms on a loaded runner) and
// copied for each test: the tests below would otherwise start ~15 git
// processes each before their own, and ran into the test timeout on a slow
// runner.
function buildRepo() {
  const dir = temp();
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@example.com',
  };
  const raw = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: path.join(dir, 'app'),
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  execFileSync('git', ['init', '-q', '--bare', path.join(dir, 'origin.git')], { env });
  mkdirSync(path.join(dir, 'app', 'node_modules'), { recursive: true });
  raw('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'app', 'a.txt'), 'main');
  writeFileSync(path.join(dir, 'app', '.gitignore'), 'node_modules\n');
  raw('add', 'a.txt', '.gitignore');
  raw('commit', '-q', '--no-gpg-sign', '-m', 'one');
  raw('remote', 'add', 'origin', path.join(dir, 'origin.git'));
  raw('push', '-q', 'origin', 'main');
  return dir;
}

describe('git and addBaseTree', () => {
  let template: string;
  beforeAll(() => {
    template = buildRepo();
  });
  afterAll(() => {
    rmSync(template, { recursive: true, force: true });
  });

  /** The template's repository, copied, its origin pointing at the copy's own. */
  function repo() {
    const dir = temp();
    cpSync(template, dir, { recursive: true });
    const config = path.join(dir, 'app', '.git', 'config');
    writeFileSync(
      config,
      readFileSync(config, 'utf8').replaceAll(template, () => dir),
    );
    return { dir, root: path.join(dir, 'app') };
  }

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

describe('build, with gif.page', () => {
  // A builder that writes what it was handed into the folder it was given.
  const BUILDER = `import { writeFileSync } from 'node:fs';
const [outDir, ...rest] = process.argv.slice(2);
if (process.env.GIF_TEST_FAIL) process.exit(4);
writeFileSync(outDir + '/index.html', JSON.stringify({ outDir, rest, cwd: process.cwd(), env: process.env.GIF_TEST_ENV ?? null, gone: process.env.GIF_TEST_GONE ?? null }));
`;
  const settings = { mode: undefined, env: { GIF_TEST_ENV: 'set' }, unsetEnv: ['GIF_TEST_GONE'] };

  it("runs the side's own builder with Node, into a new outDir, never Vite", () => {
    const root = temp();
    const base = temp();
    for (const dir of [root, base]) {
      mkdirSync(path.join(dir, 'tools'));
      writeFileSync(path.join(dir, 'tools', 'page.mjs'), BUILDER);
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.GIF_TEST_GONE = 'here';
    try {
      const outDir = path.join(temp(), 'work', 'dist-after');
      build({ root, cwd: root, outDir, mode: 'test', settings, page: 'tools/page.mjs' });
      expect(JSON.parse(readFileSync(path.join(outDir, 'index.html'), 'utf8'))).toEqual({
        outDir,
        rest: [],
        cwd: realpathSync(root),
        env: 'set',
        gone: null,
      });
      expect(log).toHaveBeenCalledWith('pr-gif: building this working tree with tools/page.mjs');
      expect(existsSync(path.join(root, 'node_modules'))).toBe(false);

      const before = path.join(temp(), 'dist-before');
      build({ root, cwd: base, outDir: before, mode: undefined, settings, page: 'tools/page.mjs' });
      expect(JSON.parse(readFileSync(path.join(before, 'index.html'), 'utf8')).cwd).toBe(
        realpathSync(base),
      );
      expect(log).toHaveBeenLastCalledWith('pr-gif: building the base with tools/page.mjs');
    } finally {
      log.mockRestore();
      delete process.env.GIF_TEST_GONE;
    }
  });

  it('fails on a base without the builder, and on a builder that fails', () => {
    const root = temp();
    writeFileSync(path.join(root, 'page.mjs'), BUILDER);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const outDir = path.join(temp(), 'dist-before');
      expect(() =>
        build({ root, cwd: temp(), outDir, mode: undefined, settings, page: 'page.mjs' }),
      ).toThrow('no page.mjs in the base');
      expect(existsSync(outDir)).toBe(false);
      mkdirSync(path.join(root, 'folder.mjs'));
      expect(() =>
        build({ root, cwd: root, outDir, mode: undefined, settings, page: 'folder.mjs' }),
      ).toThrow('no folder.mjs in this working tree');
      process.env.GIF_TEST_FAIL = '1';
      expect(() =>
        build({ root, cwd: root, outDir, mode: undefined, settings, page: 'page.mjs' }),
      ).toThrow(/Command failed/);
    } finally {
      log.mockRestore();
      delete process.env.GIF_TEST_FAIL;
    }
  });

  it("hands Node the builder's absolute path, so a name like an option is still a module", () => {
    const root = temp();
    writeFileSync(path.join(root, '--help'), BUILDER);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const outDir = path.join(temp(), 'dist');
      build({ root, cwd: root, outDir, mode: undefined, settings, page: '--help' });
      expect(existsSync(path.join(outDir, 'index.html'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("stops a builder that hangs at the limit, saying it didn't finish", () => {
    const root = temp();
    // Never finishes: a limit of 1 ms ends it, before Node has even started.
    writeFileSync(path.join(root, 'page.mjs'), 'setInterval(() => {}, 1 << 30);');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(() =>
        build({
          root,
          cwd: root,
          outDir: path.join(temp(), 'dist'),
          mode: undefined,
          settings,
          page: 'page.mjs',
          timeoutMs: 1,
        }),
      ).toThrow("page.mjs didn't finish building within 0.001 s");
    } finally {
      log.mockRestore();
    }
  });
});
