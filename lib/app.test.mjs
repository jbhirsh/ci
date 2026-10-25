import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appConfig, appRoot, importFromApp } from './app.mjs';

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
