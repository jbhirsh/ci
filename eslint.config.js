import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  // Plain JavaScript: types live in JSDoc and TypeScript checks them (checkJs).
  jsdoc.configs['flat/recommended'],
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
