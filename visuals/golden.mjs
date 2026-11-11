// The cases check.test.mjs's golden test runs through report() with no
// `fromBaselines`, whose output was taken from the check before ci#33's
// table came in (check.golden.txt): an app that doesn't opt in must see the
// same lines, byte for byte. Not part of the tool.

import { report, settings } from './check.mjs';

/** @type {[string, string, { body: string | undefined, author?: string, state?: string, advice?: string }][]} */
export const CASES = [
  ['no UI files', 'README.md\napi/x.ts\n', { body: '' }],
  ['Dependabot', 'src/App.tsx\n', { body: undefined, author: 'dependabot[bot]' }],
  ['ticked', 'src/App.tsx\n', { body: '- [x] No visible UI change' }],
  ['an image', 'src/App.tsx\n', { body: '![after](https://example.com/a.png)' }],
  ['a bare video', 'src/App.tsx\n', { body: 'https://github.com/user-attachments/assets/1' }],
  [
    'a closed PR, no pictures',
    ' src/App.tsx \n\nsrc/index.css\n',
    { body: 'Nothing to see.', state: 'closed' },
  ],
  ['an unlabelled still', 'src/App.tsx\n', { body: '<img src="x.png" width="300">' }],
  ['custom advice', 'src/a.tsx\n', { body: '<!-- ![x](y) -->', advice: 'Take shots.' }],
];

/** Each case's printed lines and exit code, as the golden file holds them. */
export function goldenText() {
  return CASES.map(([name, files, { advice, ...pr }]) => {
    const { code, message } = report(files, {
      ...pr,
      settings: settings(advice ? { advice } : {}),
    });
    return `## ${name} (exit ${code})\n${message}\n`;
  }).join('\n');
}
