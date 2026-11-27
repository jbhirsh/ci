// Local production builds of a web app for a recording: "before" from a ref
// (origin/main) in a temporary git worktree that borrows the checkout's
// node_modules, "after" from the checkout itself, uncommitted changes
// included. Each is built with the app's own Vite and served by
// `vite preview` on a free port: a production build, never the dev server,
// which renders everything twice and runs unbundled code.
//
// A repo that builds its page itself (the `gif.page` setting) has its builder
// run instead, `node <page> <outDir>` with no shell, in each side's root, and
// isn't served here at all: cli.ts routes the page's origin to outDir
// (route.ts).

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, statSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { BuildSettings } from './settings.ts';
import type { ChildProcess } from 'node:child_process';

/**
 * Git in `cwd`, returning what it printed, trimmed.
 */
export function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * The branch to fetch for a remote-tracking ref (origin/main → origin, main),
 * or null for a ref that isn't one (a SHA, a local branch).
 */
export function remoteBranch(ref: string): { remote: string; branch: string } | null {
  const match = /^(origin|upstream)\/(.+)$/.exec(ref);
  return match ? { remote: match[1], branch: match[2] } : null;
}

/**
 * Checks `ref` out in a new worktree at `tree`, fetching it first if it's a
 * remote's (a fetch that fails falls back to the copy here, with a warning),
 * and links the checkout's node_modules into it.
 */
export function addBaseTree(root: string, ref: string, tree: string) {
  const remote = remoteBranch(ref);
  if (remote) {
    try {
      git(root, 'fetch', '--quiet', remote.remote, remote.branch);
    } catch {
      console.warn(`pr-gif: couldn't fetch ${ref}; using the copy here`);
    }
  }
  git(root, 'worktree', 'add', '--detach', '--quiet', tree, ref);
  symlinkSync(path.join(root, 'node_modules'), path.join(tree, 'node_modules'), 'dir');
}

/**
 * The environment a build runs in: the shell's, with the settings' `env`
 * set and its `unsetEnv` dropped.
 */
export function buildEnv(shell: Record<string, string | undefined>, settings: BuildSettings) {
  const env = { ...shell, ...settings.env };
  for (const name of settings.unsetEnv) delete env[name];
  return env;
}

/**
 * The arguments to the app's Vite for a production build of `cwd` into
 * `outDir`.
 */
export function buildArgs(vite: string, outDir: string, mode: string | undefined) {
  return [
    vite,
    'build',
    ...(mode ? ['--mode', mode] : []),
    '--outDir',
    outDir,
    '--emptyOutDir',
    '--logLevel',
    'error',
  ];
}

const viteBin = (root: string) => path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

/**
 * Builds the app at `cwd` into `outDir`: with `root`'s Vite, or, given
 * `page` (the `gif.page` setting, from the repo's root), by running that
 * module of `cwd`'s with Node, handing it `outDir`. A base without the
 * module (a builder main doesn't have yet) is a build that fails, saying so,
 * as is a builder still running after `timeoutMs`: a limit on a hang, never
 * the way it succeeds.
 */
export function build({
  root,
  cwd,
  outDir,
  mode,
  settings,
  page,
  timeoutMs = 10 * 60_000,
}: {
  root: string;
  cwd: string;
  outDir: string;
  mode: string | undefined;
  settings: BuildSettings;
  page?: string;
  timeoutMs?: number;
}) {
  const which = cwd === root ? 'this working tree' : 'the base';
  console.log(`pr-gif: building ${which}${page ? ` with ${page}` : ''}`);
  const env = buildEnv(process.env, settings);
  const stdio: ['ignore', 'ignore', 'inherit'] = ['ignore', 'ignore', 'inherit'];
  if (!page) {
    execFileSync(process.execPath, buildArgs(viteBin(root), outDir, mode), { cwd, env, stdio });
    return;
  }
  // Absolute, so a name starting with `-` can't be read as Node's option.
  const module = path.resolve(cwd, page);
  if (!statSync(module, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`no ${page} in ${which}`);
  }
  mkdirSync(outDir, { recursive: true });
  try {
    execFileSync(process.execPath, [module, outDir], { cwd, env, stdio, timeout: timeoutMs });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`${page} didn't finish building within ${timeoutMs / 1000} s`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * A port nothing is listening on, from the OS.
 */
export function freePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((done, failed) => {
    const server = createServer();
    server.once('error', failed);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

/**
 * Whether what `vite preview` has printed so far names an address on `port`:
 * its Local or Network line, once its colour codes are stripped (in CI they
 * split the port from the host). Matched on the port, not the host, since
 * Vite may name the host otherwise than it was given (0.0.0.0 as localhost,
 * localhost as 127.0.0.1 under another DNS order).
 */
export function namesPort(printed: string, port: number) {
  return new RegExp(`\\bhttps?://[^\\s/]+:${port}/`).test(stripVTControlCharacters(printed));
}

/**
 * Serves `outDir` with `vite preview` on a free port of `host` (the process
 * goes in `servers`, for stopServers), and resolves with its origin once Vite
 * prints the line naming its address, which it does only once it is
 * listening, and the page there answers. Rejects at once if the process
 * exits or fails first, and after `timeoutMs` if Vite never says so: a limit
 * on a hang, never the way it succeeds. Its output goes on being read after
 * that line, so a full pipe never stalls the server.
 */
export async function serve({
  root,
  outDir,
  host,
  servers,
  timeoutMs = 30_000,
}: {
  root: string;
  outDir: string;
  host: string;
  servers: ChildProcess[];
  timeoutMs?: number;
}) {
  const port = await freePort(host);
  const server = spawn(
    process.execPath,
    [
      viteBin(root),
      'preview',
      '--outDir',
      outDir,
      '--port',
      String(port),
      '--strictPort',
      '--host',
      host,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  servers.push(server);
  const origin = `http://${host}:${port}`;
  await new Promise<void>((done, failed) => {
    let printed = '';
    const settle = (error?: Error) => {
      clearTimeout(hung);
      server.stdout.off('data', read);
      server.stdout.resume();
      server.off('exit', exited);
      server.off('error', settle);
      if (error) failed(error);
      else done();
    };
    const read = (chunk: string) => {
      printed += chunk;
      if (namesPort(printed, port)) settle();
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) =>
      settle(new Error(`vite preview exited with ${code ?? signal}`));
    const hung = setTimeout(
      () =>
        settle(
          new Error(
            `vite preview didn't say it was listening on ${origin} within ${timeoutMs / 1000} s`,
          ),
        ),
      timeoutMs,
    );
    server.stdout.setEncoding('utf8');
    server.stdout.on('data', read);
    server.once('exit', exited);
    server.once('error', settle);
  });
  const page = await fetch(origin);
  await page.body?.cancel();
  if (!page.ok) throw new Error(`vite preview answered ${page.status} on ${origin}`);
  return origin;
}

/**
 * Stops the servers serve started, and waits for them to go.
 */
export async function stopServers(servers: ChildProcess[]) {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((done) => {
          if (server.exitCode !== null || server.signalCode !== null) return done();
          server.once('exit', () => done());
          server.kill('SIGTERM');
        }) as Promise<void>,
    ),
  );
}
