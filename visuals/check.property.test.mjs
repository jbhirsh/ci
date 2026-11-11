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
  '![GIF: x](b.gif)',
  '![No test draws: mail](b.png)',
  'https://github.com/user-attachments/assets/1',
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

describe('with fromBaselines, for any description', () => {
  const on = settings({ fromBaselines: true });
  const off = settings({});
  const files = ['src/A.tsx'];

  it('counts no more than the check without it, unless baselines show the change', () => {
    fc.assert(
      fc.property(body, (text) => {
        const strict = checkPrVisuals({ files, body: text, baselines: { shown: 0 }, settings: on });
        if (strict.ok) expect(checkPrVisuals({ files, body: text, settings: off }).ok).toBe(true);
      }),
    );
  });

  it('passes whenever a changed baseline lands in a column, and any closed PR', () => {
    fc.assert(
      fc.property(body, fc.integer({ min: 1, max: 50 }), (text, shown) => {
        expect(checkPrVisuals({ files, body: text, baselines: { shown }, settings: on }).ok).toBe(
          true,
        );
        expect(checkPrVisuals({ files, body: text, state: 'closed', settings: on }).ok).toBe(true);
      }),
    );
  });
});
