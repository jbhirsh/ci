import { describe, expect, it } from 'vitest';
import { fingerprint, mark, MAX_DESCRIPTION, readMark, shownAt, status } from './status.ts';
import type { Pull } from './status.ts';

const OWNER = 'jbhirsh';
const changed = { kind: 'compared' as const, screens: 3, fingerprint: 'abcdef12' };
const none = { kind: 'compared' as const, screens: 0, fingerprint: '00000000' };
const pull = (over: Partial<Pull> = {}) => ({
  author: OWNER,
  bot: false,
  autoMerge: null,
  ...over,
});

describe('status', () => {
  it('passes when nothing changed', () => {
    expect(status({ result: none, pull: pull(), owner: OWNER, shown: 10 })).toEqual({
      state: 'success',
      description: 'No visual changes',
    });
  });

  it('passes a change a person will merge, with the mark', () => {
    const s = status({ result: changed, pull: pull(), owner: OWNER, shown: 10 });
    expect(s.state).toBe('success');
    expect(s.description).toBe('3 screens changed: see the table [vr:abcdef12@10]');
  });

  it("blocks a change on a bot's PR with auto-merge on, whoever turned it on", () => {
    for (const by of [OWNER, 'github-actions[bot]']) {
      const s = status({
        result: changed,
        pull: pull({ author: 'dependabot[bot]', bot: true, autoMerge: { by, at: 99 } }),
        owner: OWNER,
        shown: 10,
      });
      expect(s.state).toBe('failure');
      expect(s.description).toMatch(/merges itself/);
    }
  });

  it("blocks a bot/* branch's PR even though the owner opened it", () => {
    const s = status({
      result: changed,
      pull: pull({ bot: true, autoMerge: { by: OWNER, at: 99 } }),
      owner: OWNER,
      shown: 10,
    });
    expect(s.state).toBe('failure');
  });

  it("blocks auto-merge turned on by someone else on the owner's PR", () => {
    const s = status({
      result: changed,
      pull: pull({ autoMerge: { by: 'github-actions[bot]', at: 99 } }),
      owner: OWNER,
      shown: 10,
    });
    expect(s.state).toBe('failure');
  });

  it('accepts auto-merge the owner turned on after the result was shown', () => {
    const s = status({
      result: changed,
      pull: pull({ autoMerge: { by: OWNER, at: 11 } }),
      owner: OWNER,
      shown: 10,
    });
    expect(s).toEqual({
      state: 'success',
      description: '3 screens changed, accepted by turning on auto-merge [vr:abcdef12@10]',
    });
  });

  it('blocks auto-merge turned on before the result was shown, a tie included', () => {
    for (const at of [9, 10]) {
      const s = status({
        result: changed,
        pull: pull({ autoMerge: { by: OWNER, at } }),
        owner: OWNER,
        shown: 10,
      });
      expect(s.state).toBe('failure');
      expect(s.description).toMatch(/turn it off and on to accept/);
    }
  });

  it('says one screen, not one screens', () => {
    const s = status({
      result: { ...changed, screens: 1 },
      pull: pull(),
      owner: OWNER,
      shown: 10,
    });
    expect(s.description).toMatch(/^1 screen changed/);
  });

  it('says no screens were taken', () => {
    const s = status({
      result: { kind: 'no-shots' },
      pull: pull(),
      owner: OWNER,
      shown: 10,
    });
    expect(s).toEqual({ state: 'success', description: 'No screens taken' });
  });

  it('fails when the screenshot job failed, and clips a long name', () => {
    const s = status({
      result: { kind: 'job-failed', job: 'x'.repeat(300) },
      pull: pull(),
      owner: OWNER,
      shown: 10,
    });
    expect(s.state).toBe('failure');
    expect(s.description.length).toBe(MAX_DESCRIPTION);
  });

  it("waits for main's run, and fails when it has no screenshots", () => {
    const base = '0123456789abcdef';
    expect(
      status({
        result: { kind: 'waiting', base },
        pull: pull(),
        owner: OWNER,
        shown: 1,
      }),
    ).toEqual({ state: 'pending', description: "Waiting for main's screenshots of 0123456" });
    expect(
      status({
        result: { kind: 'no-reference', base },
        pull: pull(),
        owner: OWNER,
        shown: 1,
      }).state,
    ).toBe('failure');
  });
});

describe('fingerprint', () => {
  it('ignores order and tells different changes apart', () => {
    const a = { name: 'a.png', after: '11' };
    const b = { name: 'b.png', after: '' };
    expect(fingerprint([a, b])).toBe(fingerprint([b, a]));
    expect(fingerprint([a])).not.toBe(fingerprint([{ ...a, after: '12' }]));
    expect(fingerprint([a])).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('mark and readMark', () => {
  it('read back what they wrote, and nothing else', () => {
    expect(readMark(`x ${mark('abcdef12', 42.7)}`)).toEqual({ hash: 'abcdef12', shown: 42 });
    expect(readMark('No visual changes')).toBeNull();
    expect(readMark(null)).toBeNull();
    expect(readMark('[vr:ABCDEF12@1]')).toBeNull();
  });
});

describe('shownAt', () => {
  it('keeps the time for the same fingerprint, and starts again for a new one', () => {
    const previous = `3 screens changed ${mark('abcdef12', 5)}`;
    expect(shownAt('abcdef12', previous, 100)).toBe(5);
    expect(shownAt('12345678', previous, 100)).toBe(100);
    expect(shownAt('abcdef12', undefined, 100)).toBe(100);
  });
});
