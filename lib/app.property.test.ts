import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lockedVersion } from './app.ts';

// Any lockfile JSON at all: arbitrary values, and ones shaped like a
// lockfile with arbitrary entries where Playwright's would be.
const lockfiles = fc.oneof(
  fc.jsonValue(),
  fc.record({
    packages: fc.dictionary(
      fc.oneof(fc.constant('node_modules/playwright'), fc.string()),
      fc.oneof(fc.jsonValue(), fc.record({ version: fc.oneof(fc.string(), fc.jsonValue()) })),
    ),
  }),
);

describe('lockedVersion, for any lockfile JSON', () => {
  it('returns a release or throws an Error naming the file, never anything else', () => {
    fc.assert(
      fc.property(lockfiles, (lock) => {
        let version: unknown;
        try {
          version = lockedVersion(lock, 'playwright');
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(/^package-lock\.json/);
          return;
        }
        expect(version).toMatch(/^\d+\.\d+\.\d+/);
      }),
    );
  });
});
