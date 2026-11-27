import { describe, expect, it } from 'vitest';
import { formatServerTiming, hasEntry, parseServerTiming } from './server-timing.ts';

// BoardGames' real header (api/_lib/timing.ts), on an instance's first request.
const BOARDGAMES =
  'cold, loaded;dur=3181.6, deps;dur=0.2, db-open;dur=249.4, field.games;dur=338.5;desc="Query.games";calls=1, field.games.wishlist.votes;dur=60;desc="Game.votes";calls=30;slowest=2.4, total;dur=375.7';

describe('parseServerTiming', () => {
  it("reads BoardGames' real header: the flag, each phase and each field", () => {
    expect(parseServerTiming(BOARDGAMES)).toEqual([
      { name: 'cold' },
      { name: 'loaded', dur: 3181.6 },
      { name: 'deps', dur: 0.2 },
      { name: 'db-open', dur: 249.4 },
      { name: 'field.games', dur: 338.5, desc: 'Query.games', calls: 1 },
      { name: 'field.games.wishlist.votes', dur: 60, desc: 'Game.votes', calls: 30, slowest: 2.4 },
      { name: 'total', dur: 375.7 },
    ]);
  });

  it('reads start, ms from the handler’s start', () => {
    expect(parseServerTiming('field.games;dur=20.6;start=1.4')).toEqual([
      { name: 'field.games', dur: 20.6, start: 1.4 },
    ]);
  });

  it('keeps commas and semicolons inside a quoted desc, and its escapes', () => {
    expect(parseServerTiming('a;desc="x, y; \\"z\\"";dur=1, b;dur=2')).toEqual([
      { name: 'a', desc: 'x, y; "z"', dur: 1 },
      { name: 'b', dur: 2 },
    ]);
    expect(parseServerTiming('a;desc=token;dur=1')).toEqual([{ name: 'a', desc: 'token', dur: 1 }]);
  });

  it('reads repeated headers as one list', () => {
    expect(parseServerTiming(['cold', 'total;dur=3'])).toEqual([
      { name: 'cold' },
      { name: 'total', dur: 3 },
    ]);
  });

  it('leaves out a number that is not finite and at least 0, and keeps a first value', () => {
    expect(
      parseServerTiming('a;dur=-1, b;dur=NaN, c;dur=Infinity, d;dur=0x10, e;dur=1;dur=2, f;dur'),
    ).toEqual([
      { name: 'a' },
      { name: 'b' },
      { name: 'c' },
      { name: 'd' },
      { name: 'e', dur: 1 },
      { name: 'f' },
    ]);
  });

  it('reads an entry with no dur, and the flag alone', () => {
    expect(parseServerTiming('miss')).toEqual([{ name: 'miss' }]);
    expect(parseServerTiming(' cold ')).toEqual([{ name: 'cold' }]);
    expect(parseServerTiming('')).toEqual([]);
  });

  it('skips what is not an entry, to the next comma outside quotes', () => {
    expect(parseServerTiming('"x, y", a b, c;="d", e;desc="never closes, f;dur=1')).toEqual([]);
    expect(parseServerTiming('(bad);dur=1, ok;dur=2, ;dur=3,, ok2 ; dur = 4')).toEqual([
      { name: 'ok', dur: 2 },
      { name: 'ok2', dur: 4 },
    ]);
  });
});

describe('hasEntry', () => {
  it('finds the cold flag wherever it sits, and only by its exact name', () => {
    expect(hasEntry(parseServerTiming(BOARDGAMES), 'cold')).toBe(true);
    expect(hasEntry(parseServerTiming('total;dur=1, cold'), 'cold')).toBe(true);
    expect(hasEntry(parseServerTiming('total;dur=1;desc="cold"'), 'cold')).toBe(false);
    expect(hasEntry(parseServerTiming('colder'), 'cold')).toBe(false);
  });
});

describe('formatServerTiming', () => {
  it('writes entries as an app sends them', () => {
    expect(
      formatServerTiming([
        { name: 'cold' },
        { name: 'f', dur: 1, desc: 'a "b"', calls: 2, slowest: 0.5, start: 3 },
      ]),
    ).toBe('cold, f;dur=1;desc="a \\"b\\"";calls=2;slowest=0.5;start=3');
  });
});
