import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  expressions,
  lintAction,
  lintCall,
  lintWorkflow,
  main,
  names,
  ownPath,
  targetOf,
} from './actions.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const always = () => true;

/** @param {Record<string, unknown>} overrides */
const action = (overrides = {}) => ({
  name: 'x',
  description: 'y',
  inputs: { token: { required: true } },
  runs: {
    using: 'composite',
    steps: [{ id: 'a', shell: 'bash', run: 'echo ${{ inputs.token }}' }],
  },
  ...overrides,
});

describe('expressions and names', () => {
  it('finds every expression, however deep', () => {
    expect(expressions({ a: ['${{ x }} and ${{ y.z }}'], b: { c: '${{ w }}' }, d: 3 })).toEqual([
      ' x ',
      ' y.z ',
      ' w ',
    ]);
  });
  it("takes a context's names, not a property of something else", () => {
    expect(names(' inputs.a && github.event.inputs.b || inputs.c-d ', 'inputs')).toEqual([
      'a',
      'c-d',
    ]);
  });
  it('never throws on any string', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expressions(text);
        names(text, 'steps');
      }),
    );
  });
});

describe('ownPath', () => {
  it("names a path in this repo, or null for anything else's", () => {
    expect(ownPath('jbhirsh/ci/mutation/sweep-plan@main')).toBe('mutation/sweep-plan');
    expect(ownPath('jbhirsh/ci/.github/workflows/audit.yml@main')).toBe(
      '.github/workflows/audit.yml',
    );
    expect(ownPath('actions/checkout@v7')).toBeNull();
    expect(ownPath(undefined)).toBeNull();
  });
});

describe('lintAction', () => {
  it('passes a well-wired action', () => {
    expect(
      lintAction(
        'a/action.yml',
        action({
          outputs: { out: { value: '${{ steps.a.outputs.v }}' } },
          runs: {
            using: 'composite',
            steps: [
              { id: 'a', shell: 'bash', run: 'echo ${{ inputs.token }}' },
              { uses: 'jbhirsh/ci/b@main', with: { x: '${{ steps.a.outputs.v }}' } },
            ],
          },
        }),
        always,
      ),
    ).toEqual([]);
  });
  it('names each wiring mistake', () => {
    const errors = lintAction(
      'a/action.yml',
      {
        runs: {
          using: 'node24',
          steps: [
            { name: 'one', run: 'echo ${{ inputs.nope }} ${{ steps.later.outputs.v }}' },
            { id: 'later', shell: 'bash', run: 'echo ${{ secrets.TOKEN }}', 'timeout-minutes': 5 },
            { uses: 'jbhirsh/ci/missing@main' },
          ],
        },
        outputs: { out: { value: '${{ steps.ghost.outputs.v }}' } },
      },
      (target) => target !== 'missing',
    );
    expect(errors).toEqual([
      'a/action.yml: no name',
      'a/action.yml: no description',
      'a/action.yml: runs.using must be composite',
      'a/action.yml: step 1 (one): run without shell',
      'a/action.yml: step 1 (one): inputs.nope is not declared',
      'a/action.yml: step 1 (one): steps.later is not an earlier step',
      'a/action.yml: step 2: timeout-minutes is not allowed in a composite step',
      'a/action.yml: step 2: secrets are out of reach in an action; take them as inputs',
      'a/action.yml: step 3: jbhirsh/ci/missing@main names nothing here',
      'a/action.yml: output out reads steps.ghost, which no step has',
    ]);
  });
  it('refuses what is not a mapping, or has no steps', () => {
    expect(lintAction('a', [], always)).toEqual(['a: not a YAML mapping']);
    expect(lintAction('a', action({ runs: { using: 'composite' } }), always)).toEqual([
      'a: no steps',
    ]);
  });
});

describe('targetOf', () => {
  it("reads an action's inputs, required meaning required with no default", () => {
    const target = targetOf({
      runs: {},
      inputs: { a: { required: true }, b: { required: true, default: 'x' }, c: {} },
    });
    expect(target).toEqual({
      inputs: new Map([
        ['a', true],
        ['b', false],
        ['c', false],
      ]),
      secrets: null,
    });
  });
  it("reads a reusable workflow's inputs and secrets, even with nothing declared", () => {
    expect(targetOf({ on: { workflow_call: null } })).toEqual({
      inputs: new Map(),
      secrets: new Map(),
    });
    expect(
      targetOf({ on: { workflow_call: { secrets: { key: { required: true } } } } })?.secrets,
    ).toEqual(new Map([['key', true]]));
  });
  it('is null for anything that is neither', () => {
    expect(targetOf('x')).toBeNull();
    expect(targetOf({ on: { push: null } })).toBeNull();
  });
});

describe('lintCall', () => {
  const target = {
    inputs: new Map([
      ['a', true],
      ['b', false],
    ]),
    secrets: new Map([['s', true]]),
  };
  it('passes a call that fits', () => {
    expect(lintCall('w', target, { a: 1 }, { s: 'x' })).toEqual([]);
    expect(lintCall('w', target, { a: 1 }, 'inherit')).toEqual([]);
  });
  it('names undeclared and missing inputs and secrets', () => {
    expect(lintCall('w', target, { c: 1 }, { t: 1 })).toEqual([
      'w: passes undeclared input c',
      'w: misses required input a',
      'w: passes undeclared secret t',
      'w: misses required secret s',
    ]);
  });
});

describe('lintWorkflow', () => {
  /** @param {string} target */
  const resolve = (target) =>
    target === 'tool' ? { inputs: new Map([['token', true]]), secrets: null } : null;
  it('checks every job-level and step-level call into this repo', () => {
    const doc = {
      jobs: {
        a: { uses: 'jbhirsh/ci/gone.yml@main' },
        b: {
          steps: [
            { uses: 'actions/checkout@v7' },
            { uses: 'jbhirsh/ci/tool@main', with: { token: 'x' } },
            { uses: 'jbhirsh/ci/tool@main' },
          ],
        },
      },
    };
    expect(lintWorkflow('w.yml', doc, resolve)).toEqual([
      'w.yml: job a: jbhirsh/ci/gone.yml@main names nothing here',
      'w.yml: job b step 3: misses required input token',
    ]);
    expect(lintWorkflow('w.yml', null, resolve)).toEqual(['w.yml: not a YAML mapping']);
  });
});

describe('main', () => {
  it('finds no problem in this repo', () => {
    expect(main(root, null)).toEqual([]);
  });
  it("lints an app's calls into this repo", () => {
    const app = mkdtempSync(path.join(tmpdir(), 'app-'));
    mkdirSync(path.join(app, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      path.join(app, '.github', 'workflows', 'ci.yml'),
      'jobs:\n  a:\n    steps:\n      - uses: jbhirsh/ci/commits@main\n        with:\n          nope: 1\n',
    );
    expect(main(root, app)).toEqual([
      '.github/workflows/ci.yml: job a step 1: passes undeclared input nope',
    ]);
  });
});
