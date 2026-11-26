import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  actionPaths,
  expressions,
  lintAction,
  lintCall,
  lintScripts,
  lintWorkflow,
  main,
  names,
  ownPath,
  scriptsIn,
  targetOf,
  treeAt,
} from './actions.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const always = () => true;

/**
 * A tree of these files (and their folders), which records each path asked.
 *
 * @param {string[]} files
 */
const treeOf = (files) => {
  /** @type {string[]} */
  const asked = [];
  const all = new Set(['.', ...files]);
  for (const file of files) {
    for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir))
      all.add(dir);
  }
  return {
    asked,
    exists: (/** @type {string} */ file) => (asked.push(file), all.has(file)),
    glob: (/** @type {string} */ pattern) => (
      asked.push(pattern),
      files.filter((file) => path.posix.matchesGlob(file, pattern))
    ),
  };
};
const noFiles = treeOf([]);

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
        noFiles,
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
      noFiles,
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
  it("refuses ${{ }} in a description, its own or an input's", () => {
    const steps = { using: 'composite', steps: [{ shell: 'bash', run: 'true' }] };
    expect(
      lintAction(
        'a/action.yml',
        {
          name: 'A',
          description: 'Runs with `if: ${{ !cancelled() }}`.',
          inputs: { x: { description: 'Defaults to ${{ github.token }}' }, y: 'odd' },
          runs: steps,
        },
        always,
        noFiles,
      ),
    ).toEqual([
      'a/action.yml: description holds ${{ }}, which the runner evaluates; write it without',
      "a/action.yml: input x's description holds ${{ }}, which the runner evaluates; write it without",
    ]);
  });
  it('refuses what is not a mapping, or has no steps', () => {
    expect(lintAction('a', [], always, noFiles)).toEqual(['a: not a YAML mapping']);
    expect(lintAction('a', action({ runs: { using: 'composite' } }), always, noFiles)).toEqual([
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

describe('actionPaths', () => {
  it("reads each way a value names the action's folder, and a variable set to one", () => {
    const text = [
      'node "$GITHUB_ACTION_PATH/a.mjs" x',
      'node ${GITHUB_ACTION_PATH}/../b.mjs;',
      'cp ${{ github.action_path }}/c.json "$RUNNER_TEMP"',
      'npm ci --prefix "$GITHUB_ACTION_PATH/.."',
      'cd $GITHUB_ACTION_PATH && node "$CI_DIR/lib/d.mjs"',
      'echo $GITHUB_ACTION_PATHS $CI_DIRT',
      'node "$GITHUB_ACTION_PATH"/e.mjs ${X:-$GITHUB_ACTION_PATH/f.mjs}',
    ].join('\n');
    expect(actionPaths(text, new Map([['CI_DIR', '/..']]))).toEqual([
      { token: '$GITHUB_ACTION_PATH/a.mjs', path: '/a.mjs' },
      { token: '${GITHUB_ACTION_PATH}/../b.mjs', path: '/../b.mjs' },
      { token: '${{ github.action_path }}/c.json', path: '/c.json' },
      { token: '$GITHUB_ACTION_PATH/..', path: '/..' },
      { token: '$GITHUB_ACTION_PATH', path: '' },
      { token: '$CI_DIR/lib/d.mjs', path: '/../lib/d.mjs' },
      { token: '$GITHUB_ACTION_PATH"/e.mjs', path: '/e.mjs' },
      { token: '$GITHUB_ACTION_PATH/f.mjs', path: '/f.mjs' },
    ]);
  });
});

describe('scriptsIn', () => {
  it('finds the script node runs, after its options, and every glob of scripts', () => {
    const run = [
      '# node old/gone.mjs, only a comment',
      'node pins/check.mjs',
      'tests=$(node --no-warnings ci/lib/selftests.mjs) || exit 1',
      'node --import ./hook.mjs "ci/lint/actions.mjs" --app app',
      'node "$test" "$GITHUB_WORKSPACE/app"',
      'node -e "console.log(1)"',
      'node --version',
      'echo "no node on the PATH"',
      'for t in ci/*/selftest.{mjs,ts} lib/*.json; do :; done',
      'gzip -c dist/assets/index-*.js | wc -c',
      'node check.mjs',
    ].join('\n');
    expect(scriptsIn(run)).toEqual([
      'pins/check.mjs',
      'ci/lib/selftests.mjs',
      './hook.mjs',
      'ci/lint/actions.mjs',
      'ci/*/selftest.{mjs,ts}',
      'check.mjs',
    ]);
  });
});

describe('scriptsIn, read as the shell reads it', () => {
  it('leaves out comments, heredoc bodies and quoted messages', () => {
    const run = [
      'node build.mjs # then node gone/x.mjs',
      'echo "run node scripts/later.mjs"',
      "echo 'node scripts/later.mjs too'",
      'cat > out.sh <<EOF',
      'node dist/x.mjs',
      'EOF',
      'node ./after.mjs\\',
      '  --flag',
    ].join('\n');
    expect(scriptsIn(run)).toEqual(['build.mjs', './after.mjs']);
  });
  it('checks the modules node loads by option, and reads past an option and its value', () => {
    expect(scriptsIn('node -r ./setup.cjs --import=x main.mjs')).toEqual([
      './setup.cjs',
      'main.mjs',
    ]);
    expect(scriptsIn('node --test-reporter spec lib/a.test.mjs')).toEqual(['lib/a.test.mjs']);
  });
});

describe("lintAction's paths", () => {
  const tree = treeOf(['tool/a.mjs', 'tool/sub/action.yml', 'lib/gh.mjs', 'tool/b.ts']);
  /**
   * @param {string} file
   * @param {unknown[]} steps
   */
  const at = (file, steps) =>
    lintAction(file, action({ runs: { using: 'composite', steps } }), always, tree);

  it("resolves each path from the action's folder, `..` included", () => {
    expect(
      at('tool/sub/action.yml', [
        { shell: 'bash', run: 'node "$GITHUB_ACTION_PATH/../a.mjs"' },
        { shell: 'bash', run: 'node "$GITHUB_ACTION_PATH/../../lib/gh.mjs" check' },
        { shell: 'bash', run: 'npm ci --prefix "$GITHUB_ACTION_PATH/../.."' },
        { shell: 'bash', run: 'node $GITHUB_ACTION_PATH/../*.{mjs,ts}' },
      ]),
    ).toEqual([]);
  });
  it('names the file, the step and each path that is not there', () => {
    expect(
      at('tool/sub/action.yml', [
        { name: 'Run', shell: 'bash', run: 'node "$GITHUB_ACTION_PATH/../a.ts"' },
        { shell: 'bash', run: 'node "$GITHUB_ACTION_PATH/../../../out.mjs"' },
        { shell: 'bash', run: 'node $GITHUB_ACTION_PATH/*.mjs' },
        { uses: 'some/action@v1', with: { file: '${{ github.action_path }}/gone.json' } },
      ]),
    ).toEqual([
      'tool/sub/action.yml: step 1 (Run): $GITHUB_ACTION_PATH/../a.ts: no tool/a.ts in this repo',
      'tool/sub/action.yml: step 2: $GITHUB_ACTION_PATH/../../../out.mjs: leaves this repo (../out.mjs)',
      'tool/sub/action.yml: step 3: $GITHUB_ACTION_PATH/*.mjs: nothing in this repo matches tool/sub/*.mjs',
      'tool/sub/action.yml: step 4: ${{ github.action_path }}/gone.json: no tool/sub/gone.json in this repo',
    ]);
  });
  it("follows a variable a step sets to a path from the folder, as review's CI_DIR", () => {
    const env = { CI_DIR: '${{ github.action_path }}/..', OTHER: '${{ github.workspace }}/x' };
    expect(
      at('tool/action.yml', [
        { shell: 'bash', env, run: 'node "$CI_DIR/lib/gh.mjs" && node "$OTHER/y.mjs"' },
        { shell: 'bash', env, run: 'node "${CI_DIR}/lib/gone.mjs"' },
        { shell: 'bash', run: 'node "$CI_DIR/lib/gone.mjs"' },
      ]),
    ).toEqual(['tool/action.yml: step 2: ${CI_DIR}/lib/gone.mjs: no lib/gone.mjs in this repo']);
  });
});

describe('lintScripts', () => {
  const tree = treeOf([
    'pins/check.mjs',
    'lint/actions.mjs',
    'a/selftest.mjs',
    'commits/action.yml',
    'sync/prepare/action.yml',
    '.github/workflows/job-reports.yml',
  ]);
  /** @param {Record<string, unknown>} doc */
  const lint = (doc) => lintScripts('.github/workflows/w.yml', doc, tree);
  const checkout = (/** @type {Record<string, unknown>} */ given = {}) => ({
    uses: 'actions/checkout@v7',
    with: given,
  });

  it("finds each path where this repo's checkout put it", () => {
    expect(
      lint({
        on: { push: null },
        jobs: {
          root: {
            steps: [
              checkout(),
              { uses: './commits' },
              { run: 'node pins/check.mjs' },
              { run: 'node actions.mjs', 'working-directory': 'lint' },
            ],
          },
          nested: {
            defaults: { run: { 'working-directory': 'ci' } },
            steps: [
              checkout({ path: 'ci' }),
              checkout({ repository: 'jbhirsh/${{ matrix.app }}', path: 'app' }),
              { uses: './ci/sync/prepare' },
              { run: 'node lint/actions.mjs --app ../app' },
              { run: 'for t in */selftest.mjs; do node "$t"; done' },
              { run: 'node "$GITHUB_WORKSPACE/ci/pins/check.mjs"', 'working-directory': 'app' },
              {
                run: 'node ../app/scripts/gone.mjs && node scripts/gone.mjs',
                'working-directory': 'app',
              },
            ],
          },
          reports: { uses: './.github/workflows/job-reports.yml' },
        },
      }),
    ).toEqual([]);
  });
  it('names each path that is not there, with its job and step', () => {
    expect(
      lint({
        on: 'pull_request',
        jobs: {
          a: {
            steps: [
              checkout({ path: 'ci' }),
              { uses: './ci/gone' },
              { name: 'Run', run: 'node ci/pins/check.ts' },
              { run: 'for t in ci/*/selftest.ts; do :; done' },
              { run: 'node "${{ github.workspace }}/ci/lint/gone.mjs"' },
            ],
          },
          b: { uses: './.github/workflows/gone.yml' },
        },
      }),
    ).toEqual([
      '.github/workflows/w.yml: job a step 2: uses ./ci/gone: no gone/action.yml in this repo',
      '.github/workflows/w.yml: job a step 3 (Run): runs ci/pins/check.ts: no pins/check.ts in this repo',
      '.github/workflows/w.yml: job a step 4: runs ci/*/selftest.ts: nothing in this repo matches */selftest.ts',
      '.github/workflows/w.yml: job a step 5: runs $GITHUB_WORKSPACE/ci/lint/gone.mjs: no lint/gone.mjs in this repo',
      '.github/workflows/w.yml: job b: uses ./.github/workflows/gone.yml: no .github/workflows/gone.yml in this repo',
    ]);
  });
  it('leaves a path after a cd, or from an absolute working directory, unchecked', () => {
    const steps = [
      checkout(),
      { run: 'cd lint && node actions.mjs' },
      { run: 'node gone.mjs', 'working-directory': '/tmp' },
    ];
    expect(lint({ on: 'push', jobs: { a: { steps } } })).toEqual([]);
  });
  it("leaves a reusable workflow's plain checkout to its caller, and a path built from a variable", () => {
    const steps = [checkout(), { uses: './.github/actions/theirs' }, { run: 'node scripts/x.mjs' }];
    for (const on of ['workflow_call', ['workflow_call'], { workflow_call: null }]) {
      expect(lint({ on, jobs: { a: { steps } } })).toEqual([]);
    }
    expect(
      lint({
        on: { workflow_call: null },
        jobs: {
          a: {
            steps: [
              checkout({ repository: 'jbhirsh/ci', path: 'ci' }),
              { run: 'node ci/gone.mjs' },
              { run: 'node "$DIR/gone.mjs"', 'working-directory': 'ci' },
              { run: 'node gone.mjs', 'working-directory': '${{ env.DIR }}' },
              checkout({ repository: 'jbhirsh/ci', path: '${{ env.DIR }}' }),
            ],
          },
        },
      }),
    ).toEqual([
      '.github/workflows/w.yml: job a step 2: runs ci/gone.mjs: no gone.mjs in this repo',
    ]);
  });
  it('reads nothing from what is not a mapping', () => {
    expect(lintScripts('w.yml', null, tree)).toEqual([]);
  });
});

describe('treeAt', () => {
  it('reads files and globs from a checkout, never node_modules', () => {
    const tree = treeAt(root);
    expect(tree.exists('lint/actions.mjs')).toBe(true);
    expect(tree.exists('lint/gone.mjs')).toBe(false);
    expect(tree.glob('*/selftest.{mjs,ts}')).toContain('sync/selftest.mjs');
    expect(tree.glob('**/node_modules/**/*.mjs')).toEqual([]);
  });
});

describe('main', () => {
  it('finds no problem in this repo', () => {
    expect(main(root, null)).toEqual([]);
  });
  it('fails on a script one action.yml and one workflow run, once it is renamed', () => {
    const copy = mkdtempSync(path.join(tmpdir(), 'ci-'));
    try {
      cpSync(root, copy, {
        recursive: true,
        filter: (from) => !/[/\\](node_modules|\.git|\.claude|coverage)$/.test(from),
      });
      renameSync(path.join(copy, 'pins', 'check.mjs'), path.join(copy, 'pins', 'check.ts'));
      expect(main(copy, null)).toEqual([
        'pins/action.yml: step 2 (Check for pins without a reason): $GITHUB_ACTION_PATH/check.mjs: no pins/check.mjs in this repo',
        '.github/workflows/ci.yml: job check step 9 (Pins (pins/check.mjs, as the apps run it)): runs pins/check.mjs: no pins/check.mjs in this repo',
      ]);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
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

  it("holds an app's GIF callers to their rules, with the app's workflow names", () => {
    const app = mkdtempSync(path.join(tmpdir(), 'app-'));
    mkdirSync(path.join(app, '.github', 'workflows'), { recursive: true });
    const put = (/** @type {string} */ name, /** @type {string} */ file) =>
      writeFileSync(
        path.join(app, '.github', 'workflows', name),
        readFileSync(path.join(root, 'gif', 'callers', file), 'utf8'),
      );
    put('pr-gif.yml', 'pr-gif.yml');
    put('pr-gif-attach.yml', 'pr-gif-attach.yml');
    expect(main(root, app)).toEqual([]);
    writeFileSync(
      path.join(app, '.github', 'workflows', 'pr-gif.yml'),
      readFileSync(path.join(root, 'gif', 'callers', 'pr-gif.yml'), 'utf8').replace(
        /name: PR GIFs/,
        'name: Renamed',
      ),
    );
    expect(main(root, app).join('\n')).toMatch(/waits for "PR GIFs"/);
    // A workflow with no `name:` is named by its path.
    writeFileSync(
      path.join(app, '.github', 'workflows', 'pr-gif.yml'),
      readFileSync(path.join(root, 'gif', 'callers', 'pr-gif.yml'), 'utf8').replace(
        /name: PR GIFs/,
        '',
      ),
    );
    writeFileSync(
      path.join(app, '.github', 'workflows', 'pr-gif-attach.yml'),
      readFileSync(path.join(root, 'gif', 'callers', 'pr-gif-attach.yml'), 'utf8').replace(
        'workflows: [PR GIFs]',
        'workflows: [.github/workflows/pr-gif.yml]',
      ),
    );
    expect(main(root, app)).toEqual([]);
  });
});
