import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { visibleText } from './structure.mjs';

// A description is whatever its author typed: build it from the pieces
// visibleText treats specially.
const piece = fc.constantFrom('<!--', '-->', '`', '```', '~~~', '\n', ' ', 'text', '![a](b.png)');
const body = fc.array(piece, { maxLength: 30 }).map((parts) => parts.join(''));

describe('visibleText, for any input', () => {
  it('what renders is the description with parts taken out, in order', () => {
    fc.assert(
      fc.property(body, (text) => {
        let at = 0;
        for (const char of visibleText(text)) {
          at = text.indexOf(char, at) + 1;
          expect(at).toBeGreaterThan(0);
        }
      }),
    );
  });

  it('what renders is never longer than the description', () => {
    fc.assert(
      fc.property(body, (text) => {
        expect(visibleText(text).length).toBeLessThanOrEqual(text.length);
      }),
    );
  });
});
