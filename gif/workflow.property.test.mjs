import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  changedScenarios,
  parseApiFiles,
  parseInputs,
  parseNameStatus,
  readManifest,
  recordRuns,
  writeManifest,
} from './workflow.mjs';

// What a person types into the dispatch form, or a Claude session sends
// through the API: any text, with the pieces paths and options are made of.
const word = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom('a.ts', 'scripts/gif-scenarios/x.ts', '..', '-', '--dir', '/', ';', '$(x)', ' '),
);
const text = fc.array(word, { maxLength: 6 }).map((parts) => parts.join(''));
const flag = fc.oneof(fc.constantFrom('true', 'false', undefined), fc.string({ maxLength: 5 }));

describe('parseInputs, for any inputs', () => {
  it('only ever accepts a PR number and scenario paths inside the app, never an option', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.nat().map(String), text),
        text,
        flag,
        flag,
        (PR, SCENARIOS, SIDE_BY_SIDE, AFTER_ONLY) => {
          let inputs;
          try {
            inputs = parseInputs({ PR, SCENARIOS, SIDE_BY_SIDE, AFTER_ONLY });
          } catch (error) {
            expect(String(error)).toMatch(/^Error: pr-gif: /);
            return;
          }
          expect(inputs.pr).toMatch(/^[1-9]\d*$/);
          for (const file of inputs.scenarios) {
            expect(file).not.toMatch(/^[-/.]/);
            expect(file.split('/')).not.toContain('..');
            expect(file).toMatch(/^[\w./-]+$/);
          }
          expect(inputs.sideBySide && inputs.afterOnly).toBe(false);
          // Each run's first argument is the scenario (or the PR): no option.
          for (const source of /** @type {const} */ (['web', 'ci-videos'])) {
            try {
              for (const args of recordRuns(source, inputs)) expect(args[0]).not.toMatch(/^-/);
            } catch (error) {
              expect(String(error)).toMatch(/^Error: pr-gif: /);
            }
          }
        },
      ),
    );
  });
});

// A PR's file list: whatever paths its author named, git's or the API's.
const segment = fc.oneof(
  fc.string({ maxLength: 10 }),
  fc.constantFrom(
    'scripts',
    'gif-scenarios',
    'e2e',
    'gifs',
    'a.ts',
    'b.test.ts',
    'c.yaml',
    'x--y.ts',
    'a\nb.ts',
    '..',
  ),
);
const file = fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => parts.join('/'));
const changes = fc.array(fc.record({ file, removed: fc.boolean() }), { maxLength: 20 });

describe('changedScenarios, for any files a PR changes', () => {
  it('never throws, and gives each plainly named, kept file directly in the folder once, sorted', () => {
    fc.assert(
      fc.property(
        changes,
        fc.constantFrom('scripts/gif-scenarios', 'e2e/gifs/', undefined),
        fc.constantFrom(/** @type {const} */ ('web'), /** @type {const} */ ('ci-videos')),
        (list, folder, source) => {
          const found = changedScenarios(list, folder, source);
          expect([...found].sort()).toEqual(found);
          expect(new Set(found).size).toBe(found.length);
          for (const f of found) {
            expect(f.startsWith(`${(folder ?? '').replace(/\/$/, '')}/`)).toBe(true);
            // Safe as one argument, one output line and one marker.
            expect(f).toMatch(/^[\w./-]+$/);
            expect(f.split('/').at(-1)).not.toContain('--');
            expect(list.some((c) => c.file === f && !c.removed)).toBe(true);
          }
        },
      ),
    );
  });

  it('reads what git and the API print back as the same files', () => {
    fc.assert(
      fc.property(changes, (list) => {
        const plain = list.filter((c) => c.file && !c.file.includes('\0'));
        const git = plain.map((c) => `${c.removed ? 'D' : 'M'}\0${c.file}\0`).join('');
        expect(parseNameStatus(git)).toEqual(plain);
        const api = plain
          .map((c) =>
            JSON.stringify({ filename: c.file, status: c.removed ? 'removed' : 'modified' }),
          )
          .join('\n');
        expect(parseApiFiles(api)).toEqual(plain);
      }),
    );
  });
});

describe('readManifest, for any artifact', () => {
  const name = fc.stringMatching(/^\w[\w.-]{0,15}$/).filter((n) => !n.includes('--'));
  const manifest = fc.record({
    pr: fc.integer({ min: 1, max: 1e9 }),
    head: fc.stringMatching(/^[0-9a-f]{40}$/),
    automatic: fc.boolean(),
    recorded: fc.array(name, { maxLength: 5 }),
    failed: fc.array(name, { maxLength: 5 }),
  });

  it('reads back what writeManifest wrote', () => {
    fc.assert(
      fc.property(manifest, (m) => {
        expect(readManifest(writeManifest(m))).toEqual(m);
      }),
    );
  });

  it('turns anything else away with a clear error, never another', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.json(),
          manifest.chain((m) =>
            fc
              .record({ key: fc.constantFrom(...Object.keys(m), 'extra'), value: fc.jsonValue() })
              .map(({ key, value }) => JSON.stringify({ ...m, [key]: value })),
          ),
        ),
        (text) => {
          try {
            readManifest(text);
          } catch (error) {
            expect(String(error)).toMatch(/^Error: pr-gif: pr-gif\/pr-gif\.json /);
          }
        },
      ),
    );
  });
});
