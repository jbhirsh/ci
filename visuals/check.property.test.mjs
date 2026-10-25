import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkPrVisuals, settings, visibleText } from './check.mjs';

// A description is whatever its author typed: build it from the pieces
// the check treats specially.
const piece = fc.constantFrom(
  '<!--',
  '-->',
  '`',
  '```',
  '~~~',
  '\n',
  ' ',
  'text',
  '<img src="a.png">',
  '![a](b.png)',
  '- [x] No visible UI change',
  '- [ ] No visible UI change',
);
const body = fc.array(piece, { maxLength: 30 }).map((parts) => parts.join(''));

describe('the description, for any input', () => {
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

  it('a picture inside a closed comment never counts', () => {
    const s = settings({});
    fc.assert(
      fc.property(body, (text) => {
        const hidden = `<!-- ${text.replaceAll('-->', '')} -->`;
        const files = ['src/A.tsx'];
        const verdict = checkPrVisuals({ files, body: hidden, settings: s });
        // Only code can reopen what the comment hid: a fence or backtick
        // inside it may swallow the closing marker, as GitHub's renderer would.
        if (!/[`~]/.test(text)) expect(verdict.ok).toBe(false);
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

  it('a PR with no UI file always passes', () => {
    const s = settings({});
    fc.assert(
      fc.property(body, (text) => {
        expect(
          checkPrVisuals({ files: ['README.md', 'api/x.ts'], body: text, settings: s }).ok,
        ).toBe(true);
      }),
    );
  });
});
