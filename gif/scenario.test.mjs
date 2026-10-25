import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadModule, scenarioFiles, scenarioProblems, setupProblems } from './scenario.mjs';

/**
 * An app with these files, and, if `vite` is given, a Vite whose
 * runnerImport is that source.
 *
 * @param {Record<string, string>} files
 * @param {string} [vite]
 */
function app(files, vite) {
  const root = mkdtempSync(path.join(tmpdir(), 'gif-scenario-'));
  writeFileSync(path.join(root, 'package.json'), '{"type": "module"}');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  if (vite !== undefined) {
    mkdirSync(path.join(root, 'node_modules', 'vite'), { recursive: true });
    writeFileSync(
      path.join(root, 'node_modules', 'vite', 'package.json'),
      '{"name": "vite", "type": "module", "exports": "./index.js"}',
    );
    writeFileSync(path.join(root, 'node_modules', 'vite', 'index.js'), vite);
  }
  return root;
}

const PLAY = 'export default { play: async () => {} };';

describe('loadModule', () => {
  it("imports with Node's import when the app has no Vite", async () => {
    const root = app({ 'scripts/flow.mjs': PLAY });
    const module = await loadModule('scripts/flow.mjs', root);
    expect(typeof (/** @type {{ play?: unknown }} */ (module.default).play)).toBe('function');
  });

  it("imports through the app's Vite, from the app's root, when it has one", async () => {
    const root = app(
      { 'scripts/flow.ts': 'not read by this Vite' },
      'export async function runnerImport(id, config) { return { module: { default: { id, config } } }; }',
    );
    const module = await loadModule('scripts/flow.ts', root);
    expect(module.default).toEqual({
      id: path.join(root, 'scripts/flow.ts'),
      config: { root, logLevel: 'error' },
    });
  });

  it('gives an empty module for one that exports nothing it can read', async () => {
    const root = app(
      { 'a.ts': '' },
      'export async function runnerImport() { return { module: null }; }',
    );
    expect(await loadModule('a.ts', root)).toEqual({});
  });

  it('says so when the file isn’t there', async () => {
    await expect(loadModule('nope.ts', app({}))).rejects.toThrow('pr-gif: no such file: nope.ts');
  });
});

describe('scenarioProblems', () => {
  const play = async () => {};

  it('passes a scenario with only play, or with every part', () => {
    expect(scenarioProblems({ play })).toEqual([]);
    expect(
      scenarioProblems({
        name: 'open-activity',
        path: '/?view=list',
        viewport: { width: 1100, height: 640 },
        colorScheme: 'dark',
        clip: { x: 0, y: 80, width: 1100, height: 560 },
        width: 600,
        setup: play,
        ready: play,
        play,
      }),
    ).toEqual([]);
    expect(
      scenarioProblems({ play, clip: async () => ({ x: 0, y: 0, width: 1, height: 1 }) }),
    ).toEqual([]);
  });

  it('names what is wrong, such as the old name of play', () => {
    expect(scenarioProblems(null)).toEqual(['its default export is not a scenario object']);
    expect(scenarioProblems({ run: play })).toEqual([
      'unknown key "run"',
      'play(page, gif) is missing',
    ]);
    expect(
      scenarioProblems({
        play,
        setup: 3,
        ready: 'no',
        name: 'a b',
        path: 'nowhere',
        viewport: { width: 0, height: 10 },
        colorScheme: 'blue',
        clip: { width: 10, height: 10 },
        width: -1,
      }),
    ).toEqual([
      'setup must be a function',
      'ready must be a function',
      'name must be letters, digits, . _ -',
      "path must start with '/'",
      'viewport must be { width, height }',
      "colorScheme must be 'light' or 'dark'",
      'clip must be { x, y, width, height } or a function of the page',
      'width must be a number above 0',
    ]);
  });

  it('never throws, whatever a module exports', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(Array.isArray(scenarioProblems(value))).toBe(true);
        expect(Array.isArray(setupProblems(value))).toBe(true);
      }),
    );
  });
});

describe('setupProblems', () => {
  it('passes an empty setup, or one with every part', () => {
    expect(setupProblems({})).toEqual([]);
    const hook = async () => {};
    expect(
      setupProblems({
        options: { fixtures: { type: 'boolean' }, production: { type: 'string', default: 'x' } },
        beforeSetup: hook,
        afterSetup: hook,
        check: hook,
      }),
    ).toEqual([]);
  });

  it('names what is wrong', () => {
    expect(setupProblems(undefined)).toEqual(['its default export is not a setup object']);
    expect(
      setupProblems({ before: 1, check: 'x', options: { a: { type: 'number' }, b: 3 } }),
    ).toEqual([
      'unknown key "before"',
      'check must be a function',
      "option --a needs a type, 'boolean' or 'string'",
      "option --b needs a type, 'boolean' or 'string'",
    ]);
    expect(setupProblems({ options: [] })).toEqual(['options must map names to { type }']);
  });
});

describe('scenarioFiles', () => {
  it('lists the modules in the folder, not their tests or declarations, in order', () => {
    const root = app({
      'scripts/gif-scenarios/b.ts': '',
      'scripts/gif-scenarios/a.mjs': '',
      'scripts/gif-scenarios/a.test.ts': '',
      'scripts/gif-scenarios/types.d.ts': '',
      'scripts/gif-scenarios/notes.md': '',
    });
    expect(scenarioFiles('scripts/gif-scenarios', root)).toEqual([
      path.join('scripts/gif-scenarios', 'a.mjs'),
      path.join('scripts/gif-scenarios', 'b.ts'),
    ]);
  });
});
