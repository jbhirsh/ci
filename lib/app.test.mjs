import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appConfig,
  appPackageVersion,
  appPlaywright,
  appRoot,
  appSettings,
  importFromApp,
  lockedVersion,
  requireFromApp,
} from './app.mjs';

const roots = /** @type {string[]} */ ([]);
function fakeApp(/** @type {string | undefined} */ ciJson) {
  const root = mkdtempSync(path.join(tmpdir(), 'app-'));
  roots.push(root);
  writeFileSync(path.join(root, 'package.json'), '{}');
  if (ciJson !== undefined) {
    mkdirSync(path.join(root, '.github'));
    writeFileSync(path.join(root, '.github', 'ci.json'), ciJson);
  }
  return root;
}

afterEach(() => {
  delete process.env.APP_ROOT;
});

describe('appRoot', () => {
  it('is APP_ROOT when set, else the working directory', () => {
    expect(appRoot()).toBe(process.cwd());
    process.env.APP_ROOT = '/tmp/some-app';
    expect(appRoot()).toBe('/tmp/some-app');
  });
});

describe('appConfig', () => {
  it("returns the tool's section", () => {
    const root = fakeApp('{"mutation": {"break": 80}}');
    expect(appConfig('mutation', root)).toEqual({ break: 80 });
  });
  it('is empty when the file or the key is missing', () => {
    expect(appConfig('mutation', fakeApp(undefined))).toEqual({});
    expect(appConfig('mutation', fakeApp('{"visuals": {}}'))).toEqual({});
  });
  it('refuses anything but objects', () => {
    expect(() => appConfig('mutation', fakeApp('[]'))).toThrow(/must hold an object/);
    expect(() => appConfig('mutation', fakeApp('{"mutation": 3}'))).toThrow(/must be an object/);
  });
});

describe('appSettings', () => {
  it('returns the whole file, or {} when there is none', () => {
    expect(appSettings(fakeApp('{"a": 1, "b": {"c": 2}}'))).toEqual({ a: 1, b: { c: 2 } });
    expect(appSettings(fakeApp(undefined))).toEqual({});
  });
  it('refuses anything but an object, and text that is not JSON', () => {
    expect(() => appSettings(fakeApp('3'))).toThrow(/\.github\/ci\.json must hold an object/);
    expect(() => appSettings(fakeApp('null'))).toThrow(/must hold an object/);
    expect(() => appSettings(fakeApp('{'))).toThrow(SyntaxError);
  });
});

describe('importFromApp', () => {
  it("resolves from the app's node_modules", async () => {
    const root = fakeApp(undefined);
    mkdirSync(path.join(root, 'node_modules', 'only-in-app'), { recursive: true });
    writeFileSync(
      path.join(root, 'node_modules', 'only-in-app', 'package.json'),
      '{"name":"only-in-app","main":"index.js"}',
    );
    writeFileSync(path.join(root, 'node_modules', 'only-in-app', 'index.js'), 'exports.hi = 1;');
    const mod = /** @type {{ hi: number }} */ (await importFromApp('only-in-app', root));
    expect(mod.hi).toBe(1);
  });
});

describe('requireFromApp', () => {
  it("requires from the app's node_modules", () => {
    const root = fakeApp(undefined);
    mkdirSync(path.join(root, 'node_modules', 'only-in-app'), { recursive: true });
    writeFileSync(
      path.join(root, 'node_modules', 'only-in-app', 'package.json'),
      '{"name":"only-in-app","main":"index.js"}',
    );
    writeFileSync(path.join(root, 'node_modules', 'only-in-app', 'index.js'), 'exports.hi = 1;');
    expect(/** @type {{ hi: number }} */ (requireFromApp('only-in-app', root)).hi).toBe(1);
  });
});

/**
 * Puts a CommonJS package in the app's node_modules.
 *
 * @param {string} root
 * @param {string} name
 * @param {string} code
 */
function addPackage(root, name, code) {
  const dir = path.join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.cjs' }));
  writeFileSync(path.join(dir, 'index.cjs'), code);
}

describe('appPlaywright', () => {
  it("takes Playwright Test's exports from its CommonJS default", async () => {
    const root = fakeApp(undefined);
    addPackage(
      root,
      '@playwright/test',
      'module.exports = Object.assign(() => {}, { webkit: { name: "test" } });',
    );
    addPackage(root, 'playwright', 'module.exports = { webkit: { name: "plain" } };');
    expect((await appPlaywright(root)).webkit).toEqual({ name: 'test' });
  });
  it("takes playwright's own when there's no Playwright Test", async () => {
    const root = fakeApp(undefined);
    addPackage(root, 'playwright', 'module.exports = { webkit: { name: "plain" } };');
    expect((await appPlaywright(root)).webkit).toEqual({ name: 'plain' });
  });
});

describe('appPackageVersion', () => {
  /** @param {unknown} lock */
  function withLock(lock) {
    const root = fakeApp(undefined);
    writeFileSync(
      path.join(root, 'package-lock.json'),
      typeof lock === 'string' ? lock : JSON.stringify(lock),
    );
    return root;
  }
  it('reads the version the lockfile pins at the top of node_modules', () => {
    const root = withLock({
      lockfileVersion: 3,
      packages: {
        '': { devDependencies: { '@playwright/test': '^1.65.0' } },
        'node_modules/playwright': { version: '1.65.0' },
        'node_modules/other/node_modules/playwright': { version: '1.2.3' },
      },
    });
    expect(appPackageVersion(root, 'playwright')).toBe('1.65.0');
  });
  it('names the file when the app has none, it is not JSON, or it pins nothing', () => {
    expect(() => appPackageVersion(fakeApp(undefined), 'playwright')).toThrow(
      /^no package-lock\.json/,
    );
    expect(() => appPackageVersion(withLock('{'), 'playwright')).toThrow(
      "package-lock.json isn't JSON",
    );
    expect(() => appPackageVersion(withLock({ packages: {} }), 'playwright')).toThrow(
      'package-lock.json pins no version of playwright',
    );
  });
  it('refuses a version that is not a plain release', () => {
    for (const version of ['^1.2.3', 'latest', 'file:../x', 'git+https://x', 3]) {
      expect(() =>
        lockedVersion({ packages: { 'node_modules/playwright': { version } } }, 'playwright'),
      ).toThrow("package-lock.json: playwright's version must be a release, such as 1.2.3");
    }
    expect(
      lockedVersion({ packages: { 'node_modules/p': { version: '1.0.0-beta.2' } } }, 'p'),
    ).toBe('1.0.0-beta.2');
  });
});
