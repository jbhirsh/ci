import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { body, problems } from './check.mjs';

// A commit message is whatever a person (or a bot) typed.
const message = fc.string({ unit: fc.constantFrom('a', 'B', ' ', ':', '-', '\n', '!', 'é', '🎉') });
const line = fc.stringMatching(/^[a-z][a-z ]{0,30}[a-z.]$/);

describe('commit messages, for any input', () => {
  it('never throws, and a merge commit has exactly one problem', () => {
    fc.assert(
      fc.property(message, fc.integer({ min: 0, max: 3 }), (text, parents) => {
        const found = problems({ sha: 'a', login: 'x', parents, message: text });
        if (parents > 1) expect(found).toHaveLength(1);
      }),
    );
  });

  it('a body paragraph survives any trailers after it', () => {
    fc.assert(
      fc.property(
        line,
        line,
        fc.array(fc.stringMatching(/^[A-Z][a-z-]{0,10}: \w+$/)),
        (s, b, t) => {
          const text = [s, '', b, ...(t.length ? ['', ...t] : [])].join('\n');
          expect(body(text)).toBe(b);
        },
      ),
    );
  });

  it('the body is never longer than what follows the subject', () => {
    fc.assert(
      fc.property(message, (text) => {
        expect(body(text).length).toBeLessThanOrEqual(Math.max(0, text.length));
      }),
    );
  });
});
