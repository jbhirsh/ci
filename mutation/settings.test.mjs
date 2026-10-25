import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  breakThreshold,
  defaults,
  main,
  parseSettings,
  parseStrykerConfig,
  readSettings,
  readStrykerConfig,
  wiringGlobs,
} from './settings.mjs';

/**
 * An app with `.github/ci.json` holding `ci` and the Stryker config `stryker`.
 *
 * @param {unknown} ci
 * @param {string} [stryker]
 */
function app(ci, stryker = '{"mutate":["src/**/*.ts"]}') {
  const root = mkdtempSync(path.join(tmpdir(), 'settings-'));
  mkdirSync(path.join(root, '.github'));
  writeFileSync(path.join(root, '.github', 'ci.json'), JSON.stringify(ci));
  writeFileSync(path.join(root, 'stryker.config.json'), stryker);
  return root;
}

afterEach(() => {
  delete process.env.GITHUB_OUTPUT;
  vi.restoreAllMocks();
});

describe('parseSettings', () => {
  it('is the defaults with nothing set', () => {
    expect(parseSettings({})).toEqual(defaults());
  });

  it('takes each setting over its default, nested ones key by key', () => {
    const s = parseSettings({
      smoke: ['src/a.ts'],
      perFileThreshold: 80,
      testSubjects: false,
      cache: { restoreMain: false },
      sweep: { shards: 4 },
    });
    expect(s.smoke).toEqual(['src/a.ts']);
    expect(s.perFileThreshold).toBe(80);
    expect(s.testSubjects).toBe(false);
    expect(s.cache).toEqual({ prefix: 'stryker-incremental', restoreMain: false, restartOn: [] });
    expect(s.sweep).toEqual({ shards: 4, timeoutMinutes: 180 });
    expect(parseSettings({ perFileThreshold: null }).perFileThreshold).toBeNull();
  });

  it('refuses an unknown or mistyped setting, naming it', () => {
    expect(() => parseSettings({ smok: [] })).toThrow('unknown setting "smok"');
    expect(() => parseSettings({ cache: { prefx: 'x' } })).toThrow('unknown setting "cache.prefx"');
    expect(() => parseSettings({ smoke: 'src/a.ts' })).toThrow('"smoke" must be a list of strings');
    expect(() => parseSettings({ smoke: [1] })).toThrow('list of strings');
    expect(() => parseSettings({ sweep: { shards: 0 } })).toThrow(
      '"sweep.shards" must be a positive',
    );
    expect(() => parseSettings({ sweep: { shards: 1.5 } })).toThrow('positive integer');
    expect(() => parseSettings({ cache: [] })).toThrow('"cache" must be an object');
    expect(() => parseSettings({ install: 3 })).toThrow('"install" must be a string');
    expect(() => parseSettings({ formatCheck: 'yes' })).toThrow('must be a boolean');
    expect(() => parseSettings({ perFileThreshold: 101 })).toThrow('from 0 to 100');
    expect(() => parseSettings({ perFileThreshold: '80' })).toThrow('from 0 to 100');
  });
});

describe('readSettings', () => {
  it("reads the app's mutation key", () => {
    expect(readSettings(app({ mutation: { smoke: ['a.ts'] } })).smoke).toEqual(['a.ts']);
    expect(readSettings(app({ visuals: {} }))).toEqual(defaults());
  });
});

describe('wiringGlobs', () => {
  it('always counts the Stryker config and ci.json', () => {
    const s = parseSettings({ strykerConfig: 'stryker.conf.json', wiring: ['jest.config.js'] });
    expect(wiringGlobs(s)).toEqual(['stryker.conf.json', '.github/ci.json', 'jest.config.js']);
  });
});

describe('parseStrykerConfig', () => {
  it('reads the mutate list, thresholds and reporters', () => {
    const c = parseStrykerConfig(
      '{"mutate":["a"],"thresholds":{"break":68},"reporters":["json"],"testRunner":"jest"}',
    );
    expect(c.mutate).toEqual(['a']);
    expect(c.thresholds).toEqual({ break: 68 });
    expect(c.reporters).toEqual(['json']);
    expect(c.raw.testRunner).toBe('jest');
    expect(breakThreshold(c)).toBe(68);
  });

  it('defaults the thresholds and reporters', () => {
    const c = parseStrykerConfig('{"mutate":[]}');
    expect(c.thresholds).toEqual({});
    expect(c.reporters).toEqual([]);
    expect(breakThreshold(c)).toBeNull();
    expect(
      breakThreshold(parseStrykerConfig('{"mutate":[],"thresholds":{"break":null}}')),
    ).toBeNull();
  });

  it('refuses a missing, unparsable or listless config', () => {
    expect(() => parseStrykerConfig(null)).toThrow('stryker.config.json not found');
    expect(() => parseStrykerConfig('{', 'x.json')).toThrow('x.json is not JSON');
    expect(() => parseStrykerConfig('[]')).toThrow('must hold an object');
    expect(() => parseStrykerConfig('{}')).toThrow('has no mutate list');
  });
});

describe('readStrykerConfig', () => {
  it("reads the config the settings name from the app's checkout", () => {
    const root = app({});
    expect(readStrykerConfig(defaults(), root).mutate).toEqual(['src/**/*.ts']);
    expect(() => readStrykerConfig({ ...defaults(), strykerConfig: 'none.json' }, root)).toThrow(
      'none.json not found',
    );
  });
});

describe('main', () => {
  it('writes the settings the actions read as outputs', () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'settings-out-')), 'out');
    writeFileSync(out, '');
    process.env.GITHUB_OUTPUT = out;
    const root = app({ mutation: { perFileThreshold: 80, nodeOptions: '--x' } });
    expect(main(root)).toBe(0);
    const text = readFileSync(out, 'utf8');
    for (const value of ['per-file-threshold<<', '\n80\n', '\n--x\n', 'cache-prefix<<']) {
      expect(text).toContain(value);
    }
    writeFileSync(out, '');
    main(app({}));
    expect(readFileSync(out, 'utf8')).toMatch(/per-file-threshold<<(EOF_\w+)\n\n\1/);
  });
});
