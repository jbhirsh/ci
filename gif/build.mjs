// Local production builds of a web app for a recording: "before" from a ref
// (origin/main) in a temporary git worktree that borrows the checkout's
// node_modules, "after" from the checkout itself, uncommitted changes
// included. Each is built with the app's own Vite and served by
// `vite preview` on a free port: a production build, never the dev server,
// which renders everything twice and runs unbundled code.

import { execFileSync, spawn } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

/** @typedef {import('./settings.mjs').BuildSettings} BuildSettings */
/** @typedef {import('node:child_process').ChildProcess} ChildProcess */

/**
 * Git in `cwd`, returning what it printed, trimmed.
 *
 * @param {string} cwd
 * @param {...string} args
 */
export function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * The branch to fetch for a remote-tracking ref (origin/main → origin, main),
 * or null for a ref that isn't one (a SHA, a local branch).
 *
 * @param {string} ref
 * @returns {{ remote: string; branch: string } | null}
 */
export function remoteBranch(ref) {
  const match = /^(origin|upstream)\/(.+)$/.exec(ref);
  return match ? { remote: match[1], branch: match[2] } : null;
}

/**
 * Checks `ref` out in a new worktree at `tree`, fetching it first if it's a
 * remote's (a fetch that fails falls back to the copy here, with a warning),
 * and links the checkout's node_modules into it.
 *
 * @param {string} root
 * @param {string} ref
 * @param {string} tree
 */
export function addBaseTree(root, ref, tree) {
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
 *
 * @param {Record<string, string | undefined>} shell
 * @param {BuildSettings} settings
 */
export function buildEnv(shell, settings) {
  const env = { ...shell, ...settings.env };
  for (const name of settings.unsetEnv) delete env[name];
  return env;
}

/**
 * The arguments to the app's Vite for a production build of `cwd` into
 * `outDir`.
 *
 * @param {string} vite
 * @param {string} outDir
 * @param {string | undefined} mode
 */
export function buildArgs(vite, outDir, mode) {
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

/** @param {string} root */
const viteBin = (root) => path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

/**
 * Builds the app at `cwd` into `outDir` with `root`'s Vite.
 *
 * @param {{ root: string; cwd: string; outDir: string; mode: string | undefined; settings: BuildSettings }} options
 */
export function build({ root, cwd, outDir, mode, settings }) {
  console.log(`pr-gif: building ${cwd === root ? 'this working tree' : 'the base'}`);
  execFileSync(process.execPath, buildArgs(viteBin(root), outDir, mode), {
    cwd,
    env: buildEnv(process.env, settings),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

/**
 * A port nothing is listening on, from the OS.
 *
 * @param {string} [host]
 * @returns {Promise<number>}
 */
export function freePort(host = '127.0.0.1') {
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
 * Serves `outDir` with `vite preview` on a free port of `host` (the process
 * goes in `servers`, for stopServers), and resolves with its origin once it
 * answers.
 *
 * @param {{ root: string; outDir: string; host: string; servers: ChildProcess[]; timeoutMs?: number }} options
 */
export async function serve({ root, outDir, host, servers, timeoutMs = 30_000 }) {
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
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  servers.push(server);
  const origin = `http://${host}:${port}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`vite preview exited with ${server.exitCode}`);
    try {
      if ((await fetch(origin)).ok) return origin;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`vite preview didn't answer on ${origin}`);
    await new Promise((wait) => setTimeout(wait, 200));
  }
}

/**
 * Stops the servers serve started, and waits for them to go.
 *
 * @param {ChildProcess[]} servers
 */
export async function stopServers(servers) {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        /** @type {Promise<void>} */ (
          new Promise((done) => {
            if (server.exitCode !== null || server.signalCode !== null) return done();
            server.once('exit', () => done());
            server.kill('SIGTERM');
          })
        ),
    ),
  );
}
