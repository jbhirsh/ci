import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTACH_MAX_BYTES } from '../lib/attach.mjs';
import {
  ARTIFACT,
  deleteBranch,
  main,
  parseBranch,
  parseNamedFiles,
  parseRouteInputs,
  readBranch,
} from './branch.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const REPO = 'jbhirsh/ci';
const BRANCH = 'pictures/ci-132-revisions';

/**
 * @typedef {object} Entry A file on the fake branch.
 * @property {Buffer} [bytes]
 * @property {string} [mode]
 * @property {string} [type]
 * @property {number} [size] what the tree says, when not the bytes' length
 */

/**
 * A fake REST API over one branch's tree and blobs, recording each call.
 *
 * @param {Record<string, Entry>} files
 * @param {{ branch?: string; truncated?: boolean; ref?: unknown; blob?: (sha: string) => unknown; del?: () => unknown }} [options]
 */
function fakeApi(files, options = {}) {
  const { branch = BRANCH, truncated = false } = options;
  /** @type {string[]} */
  const calls = [];
  const entries = Object.entries(files).map(([p, e], i) => ({
    path: p,
    mode: e.mode ?? '100644',
    type: e.type ?? 'blob',
    sha: `sha${i}`,
    size: e.size ?? e.bytes?.length,
  }));
  /** @type {import('../lib/comment.mjs').Api} */
  const api = (method, route) => {
    calls.push(`${method} ${route}`);
    if (method === 'DELETE') return options.del ? options.del() : null;
    if (route === `repos/${REPO}/git/ref/heads/${branch}`) {
      return options.ref ?? { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: 'c1' } };
    }
    if (route.startsWith(`repos/${REPO}/git/ref/heads/`)) {
      throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { status: 404 });
    }
    if (route === `repos/${REPO}/git/commits/c1`) return { tree: { sha: 't1' } };
    if (route === `repos/${REPO}/git/trees/t1?recursive=1`) return { tree: entries, truncated };
    const blob = /^repos\/jbhirsh\/ci\/git\/blobs\/sha(\d+)$/.exec(route);
    if (blob) {
      if (options.blob) return options.blob(`sha${blob[1]}`);
      const bytes = /** @type {Buffer} */ (Object.values(files)[Number(blob[1])].bytes);
      return { content: bytes.toString('base64'), encoding: 'base64' };
    }
    throw new Error(`unexpected ${method} ${route}`);
  };
  return { api, calls };
}

/** A path for a folder that doesn't exist yet. */
const freshDir = () => path.join(mkdtempSync(path.join(tmpdir(), 'pictures-branch-')), 'out');

/** @param {string} p */
const named = (p) => ({ path: p, caption: p });

describe('parseBranch', () => {
  it('takes pictures/<name> exactly as given', () => {
    for (const b of ['pictures/a', BRANCH, 'pictures/sift_249.v2', `pictures/${'a'.repeat(91)}`]) {
      expect(parseBranch(b)).toBe(b);
    }
  });

  it.each([
    ['main'],
    ['pictures/'],
    ['pictures'],
    ['refs/heads/pictures/a'],
    ['pictures/a/../b'],
    ['pictures/a/b'],
    ['pictures/-x'],
    ['pictures/.x'],
    ['pictures/a..b'],
    ['pictures/a--b'],
    ['pictures/a.'],
    ['pictures/a.lock'],
    ['pictures/a b'],
    [' pictures/a'],
    ['pictures/a\n'],
    ['pictures/*'],
    ['pictures/a?'],
    ['pictures/a@{1}'],
    ['pictures/a~1'],
    ['pictures/a:b'],
    ['pictures/é'],
    ['Pictures/a'],
    ['/pictures/a'],
    [`pictures/${'a'.repeat(92)}`],
    [''],
  ])('refuses %j', (b) => {
    expect(() => parseBranch(b)).toThrow(/^pictures: BRANCH is pictures\/<name>/);
  });

  it('refuses no branch at all', () => {
    expect(() => parseBranch(undefined)).toThrow('not ""');
  });
});

describe('parseNamedFiles', () => {
  it('takes what parseFiles takes', () => {
    expect(parseNamedFiles('a.png | A\nshots/b.png')).toEqual([
      { path: 'a.png', caption: 'A' },
      { path: 'shots/b.png', caption: 'b.png' },
    ]);
  });

  it.each([['-a.png'], ['shots/-a.png'], ['.a.png'], ['.shots/a.png']])('refuses %j', (f) => {
    expect(() => parseNamedFiles(f)).toThrow('starting with - or .');
  });

  it('refuses what parseFiles refuses (.., an absolute path, a space, a glob)', () => {
    for (const f of ['../a.png', '/a.png', 'a b.png', '*.png', 'a/./b.png']) {
      expect(() => parseNamedFiles(f)).toThrow(/^pictures: /);
    }
  });
});

describe('parseRouteInputs', () => {
  const env = {
    REPO,
    FILES: 'a.png',
    TARGET: '132',
    HOST_PR: '7',
    BLOCK: 'revisions',
    GITHUB_RUN_ID: '99',
  };

  it("checks the inputs as pictures/attach will, with this run's artifact", () => {
    expect(parseRouteInputs(env)).toMatchObject({
      repo: REPO,
      target: '132',
      hostPr: '7',
      runId: '99',
      artifact: ARTIFACT,
      block: 'revisions',
      files: [{ path: 'a.png', caption: 'a.png' }],
      columns: 2,
      width: 300,
    });
  });

  it('says to set PICTURES_HOST_PR when no host is given', () => {
    expect(() => parseRouteInputs({ ...env, HOST_PR: ' ' })).toThrow(
      'pictures: no host PR: pass host-pr, or set the repository variable PICTURES_HOST_PR',
    );
  });

  it.each([
    ['HOST_PR', ' 7'],
    ['HOST_PR', '7 '],
    ['HOST_PR', '07'],
    ['HOST_PR', '#7'],
    ['TARGET', ' 132'],
    ['TARGET', '132\n'],
    ['TARGET', '0'],
    ['TARGET', ''],
  ])('refuses %s %j, as the group names the host as given', (name, value) => {
    expect(() => parseRouteInputs({ ...env, [name]: value })).toThrow(
      `pictures: ${name} is a number with nothing around it, not ${JSON.stringify(value)}`,
    );
  });

  it('refuses a bad target, block or file before anything is read', () => {
    expect(() => parseRouteInputs({ ...env, TARGET: '#1' })).toThrow(
      'pictures: TARGET is a number',
    );
    expect(() => parseRouteInputs({ ...env, BLOCK: 'a--b' })).toThrow('pictures: BLOCK');
    expect(() => parseRouteInputs({ ...env, FILES: '-a.png' })).toThrow('starting with -');
  });
});

describe('readBranch', () => {
  it('writes only the named files, byte for byte, and checks them', () => {
    const other = Buffer.concat([PNG, Buffer.from('other')]);
    const { api, calls } = fakeApi({
      'a.png': { bytes: PNG },
      'shots/b.png': { bytes: other },
      'secret.txt': { bytes: Buffer.from('not named') },
      'link.png': { bytes: Buffer.from('/etc/passwd'), mode: '120000' },
    });
    const dir = freshDir();
    readBranch({
      api,
      repo: REPO,
      branch: BRANCH,
      files: ['a.png', 'shots/b.png'].map(named),
      dir,
    });
    expect(readdirSync(dir, { recursive: true }).sort()).toEqual(['a.png', 'shots', 'shots/b.png']);
    expect(readFileSync(path.join(dir, 'a.png'))).toEqual(PNG);
    expect(readFileSync(path.join(dir, 'shots/b.png'))).toEqual(other);
    expect(calls).toEqual([
      `GET repos/${REPO}/git/ref/heads/${BRANCH}`,
      `GET repos/${REPO}/git/commits/c1`,
      `GET repos/${REPO}/git/trees/t1?recursive=1`,
      `GET repos/${REPO}/git/blobs/sha0`,
      `GET repos/${REPO}/git/blobs/sha1`,
    ]);
  });

  /**
   * Runs readBranch on one named file; returns its error and whether any blob was read.
   *
   * @param {Record<string, Entry>} files
   * @param {string} name
   * @param {Parameters<typeof fakeApi>[1]} [options]
   */
  function refusal(files, name, options) {
    const { api, calls } = fakeApi(files, options);
    const dir = freshDir();
    /** @type {unknown} */
    let error;
    try {
      readBranch({ api, repo: REPO, branch: BRANCH, files: [named(name)], dir });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const message = /** @type {Error} */ (error).message;
    expect(message).toMatch(/^pictures: /);
    return { message, blobs: calls.some((c) => c.includes('/git/blobs/')), dir };
  }

  it('refuses a link, never reading what it points at', () => {
    const r = refusal({ 'a.png': { bytes: Buffer.from('/etc/passwd'), mode: '120000' } }, 'a.png');
    expect(r.message).toBe(`pictures: a.png on ${BRANCH} isn't a plain file (mode 120000: a link)`);
    expect(r.blobs).toBe(false);
    expect(existsSync(r.dir)).toBe(false);
  });

  it('refuses a submodule, a folder and an executable', () => {
    expect(refusal({ m: { mode: '160000', type: 'commit' } }, 'm').message).toContain(
      'mode 160000: a submodule',
    );
    expect(refusal({ d: { mode: '040000', type: 'tree' } }, 'd').message).toContain(
      'mode 040000: tree',
    );
    expect(refusal({ 'x.png': { bytes: PNG, mode: '100755' } }, 'x.png').message).toContain(
      'mode 100755: blob',
    );
  });

  it('refuses a file over 10 MB before reading it', () => {
    const r = refusal({ 'big.png': { bytes: PNG, size: ATTACH_MAX_BYTES + 1 } }, 'big.png');
    expect(r.message).toBe(`pictures: big.png on ${BRANCH} is over the 10 MB GitHub attaches`);
    expect(r.blobs).toBe(false);
  });

  it('takes a file of exactly 10 MB', () => {
    const bytes = Buffer.concat([PNG, Buffer.alloc(ATTACH_MAX_BYTES - PNG.length)]);
    const { api } = fakeApi({ 'big.png': { bytes } });
    const dir = freshDir();
    readBranch({ api, repo: REPO, branch: BRANCH, files: [named('big.png')], dir });
    expect(readFileSync(path.join(dir, 'big.png')).length).toBe(ATTACH_MAX_BYTES);
  });

  it('refuses a missing path', () => {
    expect(refusal({ 'a.png': { bytes: PNG } }, 'b.png').message).toBe(
      `pictures: ${BRANCH} has no b.png`,
    );
  });

  it('refuses a file that is not the picture its name says', () => {
    expect(refusal({ 'a.png': { bytes: Buffer.from('<html>') } }, 'a.png').message).toBe(
      "pictures: a.png isn't a PNG, whatever its name says",
    );
  });

  it('refuses a blob that comes back short or not in base64', () => {
    const files = { 'a.png': { bytes: PNG } };
    const short = () => ({ content: PNG.subarray(1).toString('base64'), encoding: 'base64' });
    expect(refusal(files, 'a.png', { blob: short }).message).toBe(
      "pictures: a.png's blob didn't come back whole",
    );
    const utf8 = () => ({ content: PNG.toString('base64'), encoding: 'utf-8' });
    expect(refusal(files, 'a.png', { blob: utf8 }).message).toContain("didn't come back whole");
  });

  it('refuses a branch that is not there, saying to push it', () => {
    expect(refusal({}, 'a.png', { branch: 'pictures/other' }).message).toBe(
      `pictures: ${REPO} has no branch ${BRANCH}: push it before dispatching`,
    );
  });

  it("refuses a ref that isn't the branch's commit", () => {
    const tag = { ref: `refs/heads/${BRANCH}`, object: { type: 'tag', sha: 'c1' } };
    expect(refusal({}, 'a.png', { ref: tag }).message).toBe(
      `pictures: refs/heads/${BRANCH} isn't a branch's commit`,
    );
    const prefix = [{ ref: `refs/heads/${BRANCH}-2`, object: { type: 'commit', sha: 'c1' } }];
    expect(refusal({}, 'a.png', { ref: prefix }).message).toContain("isn't a branch's commit");
    const other = { ref: `refs/heads/${BRANCH}-2`, object: { type: 'commit', sha: 'c1' } };
    expect(refusal({}, 'a.png', { ref: other }).message).toContain("isn't a branch's commit");
  });

  it('refuses a tree too big to read whole', () => {
    expect(refusal({ 'a.png': { bytes: PNG } }, 'a.png', { truncated: true }).message).toBe(
      `pictures: ${BRANCH} holds too many files to read: push only the pictures`,
    );
  });

  it('passes on an API failure other than a missing branch', () => {
    /** @type {import('../lib/comment.mjs').Api} */
    const api = () => {
      throw Object.assign(new Error('gh: Server Error (HTTP 500)'), { status: 500 });
    };
    expect(() =>
      readBranch({ api, repo: REPO, branch: BRANCH, files: [named('a.png')], dir: freshDir() }),
    ).toThrow('HTTP 500');
  });

  it('never writes into a folder that already exists', () => {
    const { api } = fakeApi({ 'a.png': { bytes: PNG } });
    const dir = mkdtempSync(path.join(tmpdir(), 'pictures-branch-'));
    expect(() =>
      readBranch({ api, repo: REPO, branch: BRANCH, files: [named('a.png')], dir }),
    ).toThrow('EEXIST');
  });
});

describe('deleteBranch', () => {
  it('deletes refs/heads/<branch>', () => {
    const { api, calls } = fakeApi({});
    /** @type {string[]} */
    const lines = [];
    deleteBranch({ api, repo: REPO, branch: BRANCH, log: (l) => lines.push(l) });
    expect(calls).toEqual([`DELETE repos/${REPO}/git/refs/heads/${BRANCH}`]);
    expect(lines).toEqual([`pictures: deleted ${BRANCH}`]);
  });

  it.each([[404], [422]])('takes a branch already gone (HTTP %i)', (status) => {
    const del = () => {
      throw Object.assign(new Error(`gh: Reference does not exist (HTTP ${status})`), { status });
    };
    /** @type {string[]} */
    const lines = [];
    deleteBranch({
      api: fakeApi({}, { del }).api,
      repo: REPO,
      branch: BRANCH,
      log: (l) => lines.push(l),
    });
    expect(lines).toEqual([`pictures: ${BRANCH} was already gone`]);
  });

  it('fails on a 422 that refuses a branch still there (a ruleset)', () => {
    const del = () => {
      throw Object.assign(new Error('gh: Cannot delete this branch (HTTP 422)'), { status: 422 });
    };
    expect(() =>
      deleteBranch({ api: fakeApi({}, { del }).api, repo: REPO, branch: BRANCH, log: () => {} }),
    ).toThrow('Cannot delete');
  });

  it('fails on any other error', () => {
    const del = () => {
      throw Object.assign(new Error('gh: Forbidden (HTTP 403)'), { status: 403 });
    };
    expect(() =>
      deleteBranch({ api: fakeApi({}, { del }).api, repo: REPO, branch: BRANCH, log: () => {} }),
    ).toThrow('HTTP 403');
  });
});

describe('main', () => {
  const env = {
    REPO,
    BRANCH,
    FILES: 'a.png | A',
    TARGET: '132',
    HOST_PR: '7',
    BLOCK: 'revisions',
    GITHUB_RUN_ID: '99',
  };

  /**
   * @param {string[]} argv
   * @param {Record<string, string | undefined>} [over]
   * @param {Parameters<typeof fakeApi>[1]} [options]
   */
  function run(argv, over = {}, options) {
    const { api, calls } = fakeApi({ 'a.png': { bytes: PNG } }, options);
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const errors = [];
    const code = main(argv, {
      env: { ...env, ...over },
      api,
      output: (n, v) => out.push(`${n}=${v}`),
      log: (l) => out.push(l),
      error: (l) => errors.push(l),
    });
    return { code, out, errors, calls };
  }

  it('name: sets the branch output, calling nothing', () => {
    expect(run(['name'])).toEqual({ code: 0, out: [`branch=${BRANCH}`], errors: [], calls: [] });
  });

  it('name: refuses a bad branch with no output', () => {
    const r = run(['name'], { BRANCH: 'main' });
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.errors[0]).toMatch(/^pictures: BRANCH is pictures\/<name>/);
  });

  it('fetch: writes the files', () => {
    const dir = freshDir();
    const r = run(['fetch', dir]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([`pictures: 1 picture(s) from ${BRANCH}`]);
    expect(readFileSync(path.join(dir, 'a.png'))).toEqual(PNG);
  });

  it('fetch: refuses bad inputs before calling the API', () => {
    const r = run(['fetch', freshDir()], { HOST_PR: '' });
    expect(r.code).toBe(1);
    expect(r.errors[0]).toContain('PICTURES_HOST_PR');
    expect(r.calls).toEqual([]);
  });

  it('delete: deletes the branch', () => {
    const r = run(['delete']);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([`DELETE repos/${REPO}/git/refs/heads/${BRANCH}`]);
  });

  it('delete: never deletes a branch it would refuse, or in a bad repo', () => {
    expect(run(['delete'], { BRANCH: 'main' }).calls).toEqual([]);
    const r = run(['delete'], { REPO: 'x' });
    expect(r.code).toBe(1);
    expect(r.errors).toEqual(['pictures: REPO is owner/name, not "x"']);
    expect(r.calls).toEqual([]);
  });

  it('reports a non-Error throw as text', () => {
    const del = () => {
      throw 'boom';
    };
    expect(run(['delete'], {}, { del }).errors).toEqual(['boom']);
  });

  it.each([
    [[]],
    [['name', 'x']],
    [['fetch']],
    [['delete', 'x']],
    [['other']],
    [['fetch', 'a', 'b']],
  ])('prints usage for %j', (argv) => {
    const r = run(argv);
    expect(r.code).toBe(2);
    expect(r.errors).toEqual(['usage: node pictures/branch.ts name | fetch <dir> | delete']);
  });
});
