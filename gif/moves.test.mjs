import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STEP_MS, click, drag, glide, scroll, smoothstep } from './moves.mjs';

// The moves go by the clock, so the tests run them on a fake one: a loaded
// machine would otherwise stretch their steps, and what they send with them.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Runs the fake clock until `move`, started on it, is done.
 *
 * @template T
 * @param {Promise<T>} move
 */
async function play(move) {
  const [done] = await Promise.all([move, vi.runAllTimersAsync()]);
  return done;
}

describe('smoothstep', () => {
  it('eases from 0 to 1, holding either end', () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.25)).toBeCloseTo(0.15625);
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
  });
});

/** @typedef {{ at: number; what: string; x?: number; y?: number }} Sent */

// A page whose mouse notes what it's sent, and when, by the fake clock.
function fakePage() {
  const start = performance.now();
  /** @type {Sent[]} */
  const sent = [];
  /**
   * @param {string} what
   * @param {number} [x]
   * @param {number} [y]
   */
  const note = (what, x, y) => {
    sent.push({ at: performance.now() - start, what, x, y });
    return Promise.resolve();
  };
  const mouse = {
    /**
     * @param {number} x
     * @param {number} y
     */
    move: (x, y) => note('move', x, y),
    down: () => note('down'),
    up: () => note('up'),
    /**
     * @param {number} _dx
     * @param {number} dy
     */
    wheel: (_dx, dy) => note('wheel', 0, dy),
  };
  return { page: { mouse }, sent };
}

/**
 * @param {Sent[]} sent
 * @param {string} what
 */
const first = (sent, what) => {
  const found = sent.find((s) => s.what === what);
  if (!found) throw new Error(`no ${what}`);
  return found;
};

describe('glide', () => {
  it('puts the pointer straight on the middle of a target the first time', async () => {
    const { page, sent } = fakePage();
    const target = {
      boundingBox: () => Promise.resolve({ x: 10, y: 20, width: 100, height: 40 }),
    };
    expect(await play(glide(page, target))).toEqual({ x: 60, y: 40 });
    expect(sent.every((s) => s.x === 60 && s.y === 40)).toBe(true);
  });

  it('then moves by the clock from where it was, easing in and out', async () => {
    const { page, sent } = fakePage();
    await glide(page, { x: 0, y: 0 }, 0);
    expect(sent).toHaveLength(1);
    expect(await play(glide(page, { x: 100, y: 50 }, 200))).toEqual({ x: 100, y: 50 });
    const moves = sent.slice(1);
    // About one move every STEP_MS for the time asked, not all at once.
    expect(STEP_MS).toBe(16);
    expect(moves.length).toBeGreaterThan(4);
    expect(moves[moves.length - 1].at - moves[0].at).toBeGreaterThanOrEqual(190);
    // Along the line, never back, and ending on the target.
    for (const m of moves) expect(m.y).toBeCloseTo(Number(m.x) / 2);
    const xs = moves.map((m) => Number(m.x));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(xs[0]).toBeLessThan(20);
    expect(moves[moves.length - 1]).toMatchObject({ x: 100, y: 50 });
    // The next one starts from there.
    await play(glide(page, { x: 100, y: 150 }, 50));
    expect(sent[moves.length + 1]).toMatchObject({ x: 100 });
    expect(sent[moves.length + 1].y).toBeLessThan(60);
  });

  it('says so when the target isn’t on the page', async () => {
    const { page } = fakePage();
    await expect(glide(page, { boundingBox: () => Promise.resolve(null) })).rejects.toThrow(
      'glide: the target has no box',
    );
  });
});

describe('click', () => {
  it('glides there, pauses, and holds the button long enough to be seen', async () => {
    const { page, sent } = fakePage();
    await glide(page, { x: 0, y: 0 }, 0);
    expect(await play(click(page, { x: 30, y: 40 }, { ms: 50 }))).toEqual({ x: 30, y: 40 });
    const down = first(sent, 'down');
    const up = first(sent, 'up');
    const lastMove = sent.filter((s) => s.what === 'move').at(-1);
    expect(lastMove).toMatchObject({ x: 30, y: 40 });
    expect(down.at - Number(lastMove?.at)).toBeGreaterThanOrEqual(140);
    expect(up.at - down.at).toBeGreaterThanOrEqual(190);
    expect(sent.indexOf(up)).toBe(sent.length - 1);
  });

  it('takes how long to hold', async () => {
    const { page, sent } = fakePage();
    await play(click(page, { x: 1, y: 1 }, { holdMs: 0 }));
    expect(first(sent, 'up').at - first(sent, 'down').at).toBeLessThan(100);
  });
});

describe('drag', () => {
  it('presses at one point, moves by the clock to the other, and lets go there', async () => {
    const { page, sent } = fakePage();
    await play(drag(page, { x: 0, y: 0 }, { x: 200, y: 0 }, 150));
    const what = sent.map((s) => s.what);
    const down = what.indexOf('down');
    const up = what.indexOf('up');
    expect(sent[down - 1]).toMatchObject({ x: 0, y: 0 });
    expect(up).toBe(sent.length - 1);
    const during = sent.slice(down + 1, up);
    expect(during.every((s) => s.what === 'move')).toBe(true);
    expect(during.length).toBeGreaterThan(3);
    expect(during[during.length - 1]).toMatchObject({ x: 200 });
    // A moment held at either end.
    expect(during[0].at - sent[down].at).toBeGreaterThanOrEqual(240);
    expect(sent[up].at - during[during.length - 1].at).toBeGreaterThanOrEqual(240);
  });
});

describe('scroll', () => {
  it('turns the wheel a little at a time, by the clock, to the whole distance', async () => {
    const { page, sent } = fakePage();
    await play(scroll(page, 300, 200));
    const turns = sent.map((s) => Number(s.y));
    expect(turns.length).toBeGreaterThan(4);
    expect(turns.every((dy) => dy > 0)).toBe(true);
    expect(turns.reduce((a, b) => a + b, 0)).toBe(300);
    expect(sent[sent.length - 1].at - sent[0].at).toBeGreaterThanOrEqual(150);
  });

  it('goes up too, and sends nothing while the eased distance hasn’t moved', async () => {
    const { page, sent } = fakePage();
    await play(scroll(page, -2, 100));
    expect(sent.map((s) => s.y)).toEqual([-1, -1]);
    await scroll(page, 0, 0);
    expect(sent).toHaveLength(2);
  });
});
