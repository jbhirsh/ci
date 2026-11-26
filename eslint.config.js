import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** The JavaScript files, while the repo moves to TypeScript (ci#155). */
const JS = ['**/*.mjs', '**/*.js', '**/*.cjs'];
/** The TypeScript files Node runs by stripping their types. */
const TS = ['**/*.ts'];

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
];
