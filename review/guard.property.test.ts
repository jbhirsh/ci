import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createGuard, resolved } from './guard.ts';

const top = mkdtempSync(path.join(tmpdir(), 'review-guard-prop-'));
const repo = path.join(top, 'app');
mkdirSync(repo);
const root = resolved(repo, '/');

/** Paths a model might send: escapes, absolute, odd segments. */
const pathArb = fc.oneof(
  fc.string(),
  fc
    .array(fc.constantFrom('..', '.', 'src', '', 'proc', 'self', 'environ', '~', 'app', '/'), {
      maxLength: 6,
    })
    .map((parts) => parts.join('/')),
  fc.constantFrom('/proc/self/environ', `${repo}/../x`, `${repo}x/y`, '//etc/passwd'),
);

describe('the guard, for any path or URL', () => {
  it('lets Read open only paths inside the checkout', () => {
    fc.assert(
      fc.property(pathArb, (file_path) => {
        const g = createGuard({ roots: [repo], cwd: repo });
        const decision = g.before('Read', { file_path });
        if (decision.allow) {
          const where = resolved(file_path, repo);
          expect(where === root || where.startsWith(`${root}${path.sep}`)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
  it('fetches no URL it was never shown', () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.array(fc.webUrl(), { maxLength: 3 }), (url, shown) => {
        const g = createGuard({ roots: [repo], cwd: repo });
        g.after('WebSearch', shown.join(' '));
        const decision = g.before('WebFetch', { url });
        if (decision.allow) {
          const strip = (u: string) => u.replace(/[#?].*$/, '').replace(/\/+$/, '');
          expect(shown.some((s) => s.includes(strip(url)) || strip(s).startsWith(strip(url)))).toBe(
            true,
          );
        }
      }),
      { numRuns: 300 },
    );
  });
  it('never throws on any tool or input', () => {
    fc.assert(
      fc.property(fc.string(), fc.anything(), (tool, input) => {
        const g = createGuard({ roots: [repo], cwd: repo });
        g.after(tool, input);
        expect(typeof g.before(tool, input).allow).toBe('boolean');
      }),
      { numRuns: 300 },
    );
  });
});
