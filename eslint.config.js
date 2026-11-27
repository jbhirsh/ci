import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The JavaScript: only this config, which stays .js as ESLint loads a .ts
 * one only through jiti or an unstable flag.
 */
const JS = ['**/*.js'];
/** The TypeScript files Node runs by stripping their types. */
const TS = ['**/*.ts'];

const NO_TIMERS =
  'No fixed-time waits in the probe: wait on the event (waitForResponse, finished(), goto) instead.';

export default [
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  // Plain JavaScript: types live in JSDoc and TypeScript checks them (checkJs).
  { ...jsdoc.configs['flat/recommended'], files: JS },
  // TypeScript: typescript-eslint parses it (its `typescript` is the TS 6 API
  // alias, as TS 7 has none), and its recommended rules replace the core ones
  // that misread types. Types live in the code, so JSDoc tags carry none.
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: TS })),
  { ...jsdoc.configs['flat/recommended-typescript'], files: TS },
  {
    files: TS,
    rules: {
      // A destructured parameter's fields are named in its type, so its tag
      // isn't asked to name each one again (as `@param options.base`).
      'jsdoc/check-param-names': ['warn', { checkDestructured: false }],
    },
  },
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/require-property-description': 'off',
      // A blank line between a block's description and its tags, as the apps write them.
      'jsdoc/tag-lines': ['warn', 'any', { startLines: 1 }],
    },
  },
  // The probe waits on events and conditions only, never on a timer (ci#58,
  // ci#151): a fixed wait is a guess, too short a flaky number, too long a
  // held runner. Playwright's waits with a `timeout` are only a hang limit.
  // Its files, tests included.
  {
    files: ['probe/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['setTimeout', 'setInterval'].map((name) => ({ name, message: NO_TIMERS })),
      ],
      'no-restricted-properties': [
        'error',
        { property: 'waitForTimeout', message: NO_TIMERS },
        { object: 'globalThis', property: 'setTimeout', message: NO_TIMERS },
        { object: 'globalThis', property: 'setInterval', message: NO_TIMERS },
      ],
      // `import('node:timers/promises')`, which no-restricted-imports doesn't read.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression[source.value=/^(node:)?timers(\\u002Fpromises)?$/]',
          message: NO_TIMERS,
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: ['node:timers', 'node:timers/promises', 'timers', 'timers/promises'].map(
            (name) => ({ name, message: NO_TIMERS }),
          ),
        },
      ],
    },
  },
];
