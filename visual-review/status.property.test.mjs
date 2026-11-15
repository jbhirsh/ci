import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fingerprint, mark, MAX_DESCRIPTION, readMark, status } from './status.mjs';

const login = fc.string({ minLength: 1, maxLength: 39 });
const epoch = fc.integer({ min: 0, max: 99_999_999_999 });
const sha = fc.stringMatching(/^[0-9a-f]{40}$/);

const result = fc.oneof(
  fc.record({
    kind: fc.constant(/** @type {const} */ ('compared')),
    screens: fc.nat({ max: 10_000 }),
    fingerprint: fc.stringMatching(/^[0-9a-f]{8}$/),
  }),
  fc.constant({ kind: /** @type {const} */ ('no-shots') }),
  fc.record({ kind: fc.constant(/** @type {const} */ ('job-failed')), job: fc.string() }),
  fc.record({ kind: fc.constant(/** @type {const} */ ('waiting')), base: sha }),
  fc.record({ kind: fc.constant(/** @type {const} */ ('no-reference')), base: sha }),
);

const pull = fc.record({
  author: login,
  bot: fc.boolean(),
  autoMerge: fc.option(fc.record({ by: login, at: epoch }), { nil: null }),
});

describe('status, for any facts', () => {
  it('never throws, and always fits a status description', () => {
    fc.assert(
      fc.property(
        result,
        pull,
        login,
        epoch,
        fc.record({ changed: fc.boolean(), shown: fc.boolean() }),
        (r, p, owner, shown, ui) => {
          const s = status({ result: r, pull: p, owner, shown, ui });
          expect(['success', 'failure', 'pending']).toContain(s.state);
          expect(s.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
        },
      ),
    );
  });

  it('never passes a changed screen on a PR that merges itself unless the owner accepted it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        pull,
        login,
        epoch,
        (screens, p, owner, shown) => {
          const s = status({
            result: { kind: 'compared', screens, fingerprint: 'abcdef12' },
            pull: p,
            owner,
            shown,
            ui: { changed: false, shown: false },
          });
          const am = p.autoMerge;
          const accepted =
            am !== null && !p.bot && p.author === owner && am.by === owner && am.at > shown;
          if (am && !accepted) expect(s.state).toBe('failure');
          if (s.state === 'success') expect(readMark(s.description)?.hash).toBe('abcdef12');
        },
      ),
    );
  });
});

describe('fingerprint, for any changes', () => {
  it('is 8 hex digits, the same in any order', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ name: fc.string(), after: fc.string() })), (changes) => {
        const f = fingerprint(changes);
        expect(f).toMatch(/^[0-9a-f]{8}$/);
        expect(fingerprint([...changes].reverse())).toBe(f);
      }),
    );
  });
});

describe('readMark, for any text', () => {
  it('never throws, and reads back any mark at the end', () => {
    fc.assert(
      fc.property(fc.string(), fc.stringMatching(/^[0-9a-f]{8}$/), epoch, (text, hash, shown) => {
        readMark(text);
        expect(readMark(`${text} ${mark(hash, shown)}`)).toEqual({ hash, shown });
      }),
    );
  });
});
