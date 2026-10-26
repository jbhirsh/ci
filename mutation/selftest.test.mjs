import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { main, selftest } from './selftest.mjs';
import { cleanRepos, isolateGit, repo } from './test-repo.mjs';

/** @type {() => void} */
let restore;
beforeAll(() => {
  restore = isolateGit();
});
afterAll(() => restore());
afterEach(() => {
  cleanRepos();
  vi.restoreAllMocks();
});

/**
 * An app with these settings and Stryker config, two commits deep.
 *
 * @param {unknown} mutation
 * @param {unknown} [stryker]
 */
function app(mutation, stryker = { mutate: ['src/**/*.ts'], reporters: ['json'] }) {
  const made = repo({
    '.github/ci.json': JSON.stringify({ mutation }),
    'stryker.config.json': JSON.stringify(stryker),
    'package.json': '{}',
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 1;\n',
  });
  made.commit({ 'src/a.ts': 'export const a = 2;\n' });
  return made;
}

/** @param {string} root */
async function run(root) {
  /** @type {string[]} */
  const lines = [];
  const failed = await selftest(root, (line) => lines.push(line));
  return { failed, lines };
}

describe('selftest', () => {
  it('passes an app whose settings, scope and sweep all work', async () => {
    const { failed, lines } = await run(
      app({ smoke: ['src/b.ts'], perFileThreshold: 80, sweep: { shards: 4 } }).root,
    );
    expect(failed).toBe(0);
    expect(lines).toContain('ok    settings parse: 1 mutate glob(s), 4 shard(s)');
    expect(lines).toContain('ok    smoke scope: src/b.ts');
    expect(lines).toContain('ok    per-file gate: 80%');
    expect(lines).toContain('ok    scope on the last commit: changed (1 entry)');
    expect(lines).toContain('ok    sweep plan: 2 file(s) in 2 shard(s)');
    expect(lines).toContain('warn  wiring glob patches/** matches no tracked file');
  });

  it('passes on the defaults, and a first commit with no parent', async () => {
    const { root } = repo({ 'stryker.config.json': '{"mutate":["src/**/*.ts"]}', 'src/a.ts': 'a' });
    const { failed, lines } = await run(root);
    expect(failed).toBe(0);
    expect(lines).toContain('ok    smoke scope: none (a setup-only PR skips Stryker)');
    expect(lines).toContain('ok    per-file gate: off');
    expect(lines).toContain('ok    scope on the last commit: skipped: HEAD has no parent');
  });

  it('stops at settings that do not parse', async () => {
    const { failed, lines } = await run(app({ smok: [] }).root);
    expect(failed).toBe(1);
    expect(lines).toEqual(['FAIL  settings parse: mutation: unknown setting "smok"']);
  });

  it('fails a smoke file that is missing or out of scope, and a gate without its reporter', async () => {
    const missing = await run(app({ smoke: ['src/gone.ts'] }).root);
    expect(missing.lines).toContain("FAIL  smoke scope: src/gone.ts isn't a tracked file");
    const outside = await run(app({ smoke: ['package.json'] }).root);
    expect(outside.lines).toContain("FAIL  smoke scope: the mutate globs don't take package.json");
    const gate = await run(app({ perFileThreshold: 80 }, { mutate: ['src/**/*.ts'] }).root);
    expect(gate.lines).toContain(
      'FAIL  per-file gate: perFileThreshold needs the json reporter in the Stryker config',
    );
  });

  it('fails a sweep with nothing in scope, and a scope that cannot run', async () => {
    const empty = await run(app({}, { mutate: ['lib/**/*.ts'] }).root);
    expect(empty.lines).toContain(
      'FAIL  sweep plan: no tracked file matches the mutate globs (lib/**/*.ts)',
    );
    // The parent commit's object gone: git can name it but not read it.
    const broken = app({});
    const parent = broken.git('rev-parse', 'HEAD^').trim();
    rmSync(path.join(broken.root, '.git', 'objects', parent.slice(0, 2), parent.slice(2)));
    const result = await run(broken.root);
    expect(result.failed).toBe(1);
    expect(result.lines.find((line) => line.startsWith('FAIL'))).toMatch(
      /^FAIL {2}scope on the last commit: /,
    );
  });
});

describe('main', () => {
  it('needs the app checkout', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main([])).toBe(2);
    expect(error).toHaveBeenCalledWith('Usage: selftest.mjs <app checkout>');
  });

  it('exits 0 for a passing app and 1 for a failing one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main([app({}).root])).toBe(0);
    expect(await main([app({ smok: [] }).root])).toBe(1);
  });
});
