import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseLink } from './links.mjs';
import {
  branchFiles,
  bundle,
  fetchPictures,
  git,
  openBundle,
  readBlob,
  resolver,
  tryGit,
} from './pictures.mjs';
import { PNG, git as fakeGit, pictureRepo } from './test-fakes.mjs';

const names = { branch: 'screenshots', legacy: 'pr-screenshots' };
const raw = 'https://raw.githubusercontent.com/o/app';

/** @type {ReturnType<typeof pictureRepo>} */
let origin;
/** @type {string} */
let clone;

beforeEach(() => {
  origin = pictureRepo();
  // A legacy branch still on GitHub, and one commit only it holds.
  fakeGit(origin.dir, ['branch', 'pr-screenshots/kept', origin.first]);
  clone = mkdtempSync(path.join(tmpdir(), 'migrate-pictures-clone-'));
});

afterEach(() => {
  rmSync(clone, { recursive: true, force: true });
  rmSync(origin.dir, { recursive: true, force: true });
});

/** @param {string} url */
const link = (url) => /** @type {import('./links.mjs').Link} */ (parseLink(url, names));

describe('fetchPictures', () => {
  it('fetches only the picture branches, and names the legacy ones', () => {
    const got = fetchPictures({
      dir: clone,
      repo: 'o/app',
      ...names,
      remote: origin.dir,
      token: 'secret',
    });
    expect(got).toEqual({ tip: origin.tip, legacyBranches: ['pr-screenshots/kept'] });
    expect(
      tryGit(clone, ['rev-parse', '--verify', '--quiet', `${origin.main}^{commit}`]),
    ).toBeNull();
    // The token went in a header for that fetch, never into the config.
    expect(readFileSync(path.join(clone, 'config'), 'utf8')).not.toContain('secret');
  });

  it('names the git command, not a token, when it fails', () => {
    expect(() =>
      git(clone, ['-c', 'http.extraHeader=Authorization: Basic c2VjcmV0', 'fetch', '/nowhere']),
    ).toThrow(/^git fetch: /);
  });
});

describe('resolver', () => {
  beforeEach(() => {
    fetchPictures({ dir: clone, repo: 'o/app', ...names, remote: origin.dir });
  });

  it('resolves picture refs to blobs, and leaves every other ref alone', () => {
    const { resolve } = resolver(clone, names);
    const a = resolve(link(`${raw}/${origin.tip}/carousel/a.png`));
    expect(a).toMatchObject({
      status: 'migrate',
      size: PNG.length + 1,
      at: `${origin.tip.slice(0, 12)}:carousel/a.png`,
    });
    expect(resolve(link(`${raw}/screenshots/carousel/a.png`)).blob).toBe(a.blob);
    expect(resolve(link(`${raw}/${origin.first.slice(0, 7)}/carousel/a.png`)).blob).toBe(a.blob);
    expect(resolve(link(`${raw}/pr-screenshots/kept/199/old.png`))).toMatchObject({
      status: 'migrate',
    });
    expect(resolve(link(`${raw}/${origin.main}/README.md`))).toEqual({ status: 'keep' });
    expect(resolve(link(`${raw}/main/README.md`))).toEqual({ status: 'keep' });
    expect(resolve(link(`${raw}/${origin.tip}/carousel/none.png`))).toEqual({
      status: 'unresolved',
    });
    expect(resolve(link(`https://github.com/o/app/tree/${origin.tip}/carousel`))).toEqual({
      status: 'listed',
    });
    expect(resolve(link(`https://github.com/o/app/commit/${origin.first}`))).toEqual({
      status: 'listed',
    });
    expect(resolve(link(`https://github.com/o/app/commit/${origin.main}`))).toEqual({
      status: 'keep',
    });
  });

  it('repairs a gone legacy branch from the tip, then from history', () => {
    const { resolve } = resolver(clone, names);
    expect(resolve(link(`${raw}/pr-screenshots/199/before.png`))).toMatchObject({
      status: 'migrate',
      repaired: true,
      at: `${origin.tip.slice(0, 12)}:199/before.png`,
    });
    expect(resolve(link(`${raw}/pr-screenshots/199/old.png`))).toMatchObject({
      status: 'migrate',
      repaired: true,
      at: `${origin.first.slice(0, 12)}:199/old.png`,
    });
    expect(resolve(link(`${raw}/pr-screenshots/199/never.png`))).toEqual({
      status: 'unresolved',
      repaired: true,
    });
    expect(resolve(link(`https://github.com/o/app/tree/pr-screenshots/199`))).toEqual({
      status: 'listed',
    });
  });

  it('bundles the clone, and a bundle opens with the same refs and files', () => {
    const file = path.join(clone, '..', `${path.basename(clone)}.bundle`);
    bundle(clone, file);
    const opened = mkdtempSync(path.join(tmpdir(), 'migrate-pictures-open-'));
    try {
      openBundle(file, opened);
      expect(branchFiles(opened, 'screenshots').map((f) => f.path)).toEqual([
        '199/before.png',
        'carousel/a.png',
        'vercel.json',
      ]);
      const [, a] = branchFiles(opened, 'screenshots');
      expect(readBlob(opened, a.blob)).toEqual(Buffer.concat([PNG, Buffer.from('a')]));
      expect(() => readBlob(opened, '0'.repeat(40))).toThrow(/no blob/);
    } finally {
      rmSync(opened, { recursive: true, force: true });
      rmSync(file, { force: true });
    }
  });
});
