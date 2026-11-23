import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addCompanions, formatSettings, settingsProblems } from './companion.mjs';

/** @param {string[]} key */
const companion = (key, value = 'its reason') => ({ key, value });
const GIFS = companion(['autofix', 'exempt', 'PR GIFs'], 'records GIFs');

/** An app's ci.json as the apps write it: objects expanded, short arrays on one line. */
const APP = `{
  "mutation": {
    "smoke": ["src/a.ts", "src/b.ts"]
  },
  "autofix": {
    "engine": "sdk",
    "exempt": {
      "PR changes": "reads the PR as data"
    }
  }
}
`;

describe('addCompanions', () => {
  it('adds a key after the last member of its object, indented as they are', () => {
    expect(addCompanions(APP, [GIFS])).toBe(
      APP.replace(
        '"PR changes": "reads the PR as data"\n',
        '"PR changes": "reads the PR as data",\n      "PR GIFs": "records GIFs"\n',
      ),
    );
  });

  it('writes the missing objects on the way, whole', () => {
    const out = addCompanions(APP, [companion(['gif', 'scenarios'], 'scripts/gifs')]);
    expect(JSON.parse(out).gif).toEqual({ scenarios: 'scripts/gifs' });
    expect(out).toContain('  },\n  "gif": {\n    "scenarios": "scripts/gifs"\n  }\n}\n');
    const deeper = addCompanions('{\n  "a": 1\n}\n', [companion(['x', 'y', 'z'])]);
    expect(deeper).toBe(
      '{\n  "a": 1,\n  "x": {\n    "y": {\n      "z": "its reason"\n    }\n  }\n}\n',
    );
  });

  it('leaves a key the app holds as it is, and every other byte', () => {
    const held = companion(['autofix', 'exempt', 'PR changes'], 'a different reason');
    expect(addCompanions(APP, [held])).toBe(APP);
    expect(addCompanions(APP, [GIFS, GIFS])).toBe(addCompanions(APP, [GIFS]));
  });

  it('makes a file for an app that has none, and fills an empty object', () => {
    expect(addCompanions('', [GIFS])).toBe(
      '{\n  "autofix": {\n    "exempt": {\n      "PR GIFs": "records GIFs"\n    }\n  }\n}\n',
    );
    expect(JSON.parse(addCompanions('{ "autofix": {} }', [GIFS]))).toEqual({
      autofix: { exempt: { 'PR GIFs': 'records GIFs' } },
    });
  });

  it('adds to an object written on one line, on that line', () => {
    expect(addCompanions('{ "autofix": { "engine": "sdk" } }\n', [GIFS])).toBe(
      '{ "autofix": { "engine": "sdk", "exempt": {"PR GIFs":"records GIFs"} } }\n',
    );
  });

  it('reads strings with escapes, arrays and other values on the way', () => {
    const text =
      '{"a\\"}": [1, {"b": [ ]}, "x]"], "n": -1.5e3, "t": true, "z": null, "o": {"p": []}}';
    expect(JSON.parse(addCompanions(text, [companion(['o', 'q'])]))).toEqual({
      'a"}': [1, { b: [] }, 'x]'],
      n: -1500,
      t: true,
      z: null,
      o: { p: [], q: 'its reason' },
    });
  });

  it('refuses to write over a key on the way that holds something else', () => {
    expect(() => addCompanions('{ "autofix": { "exempt": true } }', [GIFS])).toThrow(
      '.github/ci.json: "autofix.exempt" is not an object, so "autofix.exempt.PR GIFs" can\'t be set',
    );
    expect(() => addCompanions('{}', [companion(['a']), companion(['a', 'b'])])).toThrow(
      '"a" is not an object',
    );
  });

  it('refuses settings that are not a JSON object', () => {
    expect(() => addCompanions('[1]', [GIFS])).toThrow('.github/ci.json must hold an object');
    expect(() => addCompanions('{', [GIFS])).toThrow(SyntaxError);
  });
});

describe('formatSettings', () => {
  it("formats with the app's own Prettier and config, keeping one-line arrays", async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'app-'));
    mkdirSync(path.join(root, 'node_modules'));
    mkdirSync(path.join(root, '.github'));
    symlinkSync(
      fileURLToPath(new URL('../node_modules/prettier', import.meta.url)),
      path.join(root, 'node_modules', 'prettier'),
    );
    writeFileSync(path.join(root, 'package.json'), '{}');
    writeFileSync(path.join(root, '.prettierrc.json'), '{ "printWidth": 40 }');
    const added = addCompanions(APP, [GIFS]);
    // Already in Prettier's shape: the insertion is written as it would be.
    expect(await formatSettings(added, root)).toBe(added);
    const long = addCompanions(APP, [companion(['mutation', 'more'], 'x'.repeat(10))]);
    expect(
      await formatSettings('{"smoke":["a","b"],"wide":["aaaaaaaaaa","bbbbbbbbbb","cccc"]}', root),
    ).toBe(
      // The app's printWidth of 40, not Prettier's 80: its config is read.
      '{\n  "smoke": ["a", "b"],\n  "wide": [\n    "aaaaaaaaaa",\n    "bbbbbbbbbb",\n    "cccc"\n  ]\n}\n',
    );
    expect(await formatSettings(long, root)).toContain('"smoke": ["src/a.ts", "src/b.ts"]');
  });
});

describe('settingsProblems', () => {
  it('passes exactly the companion keys added, with no line of the app’s lost', () => {
    expect(settingsProblems(APP, addCompanions(APP, [GIFS]), [GIFS])).toEqual([]);
    expect(settingsProblems('', addCompanions('', [GIFS]), [GIFS])).toEqual([]);
    // A key the app held is not added again, and no change is the right one.
    const held = companion(['autofix', 'exempt', 'PR changes'], 'other');
    expect(settingsProblems(APP, APP, [held])).toEqual([]);
  });

  it('fails a change to anything else, a changed value, or a missing key', () => {
    const extra = addCompanions(APP, [GIFS, companion(['other'])]);
    expect(settingsProblems(APP, extra, [GIFS])).toEqual([
      '.github/ci.json in the sync PR changes more than the companion keys (autofix.exempt.PR GIFs)',
    ]);
    const changed = APP.replace('"sdk"', '"cli"');
    expect(settingsProblems(APP, addCompanions(changed, [GIFS]), [GIFS])).toEqual([
      '.github/ci.json in the sync PR changes more than the companion keys (autofix.exempt.PR GIFs)',
      '.github/ci.json in the sync PR removes or rewrites the line "    \\"engine\\": \\"sdk\\","',
    ]);
    expect(settingsProblems(APP, APP, [GIFS])).toHaveLength(1);
  });

  it('fails a reflow that rewrites a line of the app’s, even to the same value', () => {
    const reflowed = JSON.stringify(JSON.parse(addCompanions(APP, [GIFS])), null, 2) + '\n';
    expect(settingsProblems(APP, reflowed, [GIFS])).toEqual([
      '.github/ci.json in the sync PR removes or rewrites the line "    \\"smoke\\": [\\"src/a.ts\\", \\"src/b.ts\\"]"',
    ]);
  });

  it('fails what is not a JSON object, on either side, or a key it can’t set', () => {
    expect(settingsProblems('[]', '{}', [GIFS])).toEqual([
      '.github/ci.json in the app is not a JSON object',
    ]);
    expect(settingsProblems(APP, '{', [GIFS])).toEqual([
      '.github/ci.json in the sync PR is not a JSON object',
    ]);
    expect(settingsProblems('{"autofix": "on"}', '{}', [GIFS])).toEqual([
      '.github/ci.json: "autofix" is not an object, so "autofix.exempt.PR GIFs" can\'t be set',
    ]);
  });
});
