import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { actionPaths, scriptsIn } from './actions.mjs';

describe('actionPaths', () => {
  it('never throws, and each path it finds is written in the text', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (text, name) => {
        const vars = /^\w+$/.test(name) ? new Map([[name, '/x']]) : new Map();
        for (const { token } of actionPaths(text, vars)) expect(text).toContain(token);
      }),
    );
  });
});

describe('scriptsIn', () => {
  it('never throws, and each script it finds is one word', () => {
    const word = fc.oneof(
      fc.constantFrom('node', '-e', '--import', '#', '\n', ';', '"', 'a/b.mjs', '*.ts', '$x'),
      fc.string(),
    );
    fc.assert(
      fc.property(fc.array(word), (words) => {
        for (const script of scriptsIn(words.join(' '))) expect(script).toMatch(/^\S+$/);
      }),
    );
  });
});
