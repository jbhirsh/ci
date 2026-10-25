// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYER_ID, OVERLAY_SCRIPT } from './overlay.mjs';

// jsdom's globals, which this file runs in (the repo's lint knows Node's).
const {
  window,
  document,
  sessionStorage,
  HTMLElement,
  MouseEvent,
  KeyboardEvent,
  WheelEvent,
  Event,
} = globalThis;

// overlay.mjs's script as it runs in the page: once, in this file's jsdom
// window. jsdom has no layout, so boxes are stubbed where the label is placed.

/**
 * @typedef {typeof globalThis & {
 *   __prGifMoves: { x: number; y: number; t: number }[];
 *   __prGifTicks: { t: number; moving: boolean }[];
 *   __prGifClip?: unknown;
 * }} Win
 */
const win = /** @type {Win} */ (/** @type {unknown} */ (window));
/** @param {string} name */
const part = (name) => {
  const el = document.querySelector(`[data-pr-gif="${name}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no ${name}`);
  return el;
};
const frames = () => vi.advanceTimersByTime(40);
/**
 * @param {string} type
 * @param {number} [x]
 * @param {number} [y]
 */
const pointer = (type, x = 0, y = 0) =>
  window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y }));

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'Date'] });
  // As if the page before had the pointer here.
  sessionStorage.setItem('prGif:pointer', JSON.stringify({ x: 7, y: 9 }));
  new Function(OVERLAY_SCRIPT)();
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  vi.advanceTimersByTime(2000);
  delete win.__prGifClip;
});

describe('the layer', () => {
  it("is drawn on the root element, over everything, and the page can't click it", () => {
    const layer = part('layer');
    expect(layer.id).toBe(LAYER_ID);
    expect(layer.parentElement).toBe(document.documentElement);
    expect(layer.style.pointerEvents).toBe('none');
    expect(layer.style.position).toBe('fixed');
  });

  it('is added once, however often the script runs (each page load runs it again)', () => {
    new Function(OVERLAY_SCRIPT)();
    expect(document.querySelectorAll(`#${LAYER_ID}`)).toHaveLength(1);
  });
});

describe('the pointer', () => {
  it('starts where the pointer was on the page before, and keeps where it goes for the next', () => {
    expect(part('arrow').style.left).toBe('7px');
    expect(part('arrow').style.top).toBe('9px');
    pointer('pointermove', 60, 70);
    expect(JSON.parse(sessionStorage.getItem('prGif:pointer') ?? 'null')).toEqual({ x: 60, y: 70 });
  });

  it('follows each move, and keeps a log of them', () => {
    win.__prGifMoves.length = 0;
    pointer('pointermove', 120, 80);
    expect(part('arrow').style.left).toBe('120px');
    expect(part('arrow').style.top).toBe('80px');
    expect(win.__prGifMoves).toEqual([{ x: 120, y: 80, t: Date.now() }]);
  });

  it('shows a ring where it was pressed, even with no move before, and trails a drag', () => {
    pointer('pointerdown', 125, 85);
    expect(part('ring').style.opacity).toBe('1');
    expect(part('ring').style.left).toBe('125px');
    expect(part('ring').style.transition).toBe('none');
    pointer('pointermove', 130, 80);
    expect(document.querySelectorAll('[data-pr-gif="trail"]')).toHaveLength(1);
    pointer('pointerup', 130, 80);
    expect(part('ring').style.opacity).toBe('0');
    pointer('pointermove', 140, 80);
    expect(document.querySelectorAll('[data-pr-gif="trail"]')).toHaveLength(1);
    vi.advanceTimersByTime(700);
    expect(document.querySelectorAll('[data-pr-gif="trail"]')).toHaveLength(0);
  });

  it('lets the ring go when the press is cancelled', () => {
    pointer('pointerdown', 10, 10);
    pointer('pointercancel', 10, 10);
    expect(part('ring').style.opacity).toBe('0');
    pointer('pointermove', 20, 10);
    expect(document.querySelectorAll('[data-pr-gif="trail"]')).toHaveLength(0);
  });

  it('points a wheel turn the way the page scrolls, the larger way on a tie to the vertical, then fades it', () => {
    for (const [deltaX, deltaY, arrow] of /** @type {const} */ ([
      [0, 100, '↓'],
      [0, -100, '↑'],
      [100, 0, '→'],
      [-100, 0, '←'],
      [50, 50, '↓'],
      [80, 10, '→'],
    ])) {
      window.dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY }));
      expect(part('wheel').textContent).toBe(arrow);
      expect(part('wheel').style.opacity).toBe('1');
    }
    vi.advanceTimersByTime(400);
    expect(part('wheel').style.opacity).toBe('0');
  });
});

describe('the ticks', () => {
  /**
   * @param {number} left
   * @param {number} top
   */
  const box = (left, top) => ({
    left,
    top,
    right: left + 10,
    bottom: top + 10,
    width: 10,
    height: 10,
  });

  it('note nothing until recording starts', () => {
    win.__prGifTicks.length = 0;
    frames();
    expect(win.__prGifTicks).toEqual([]);
  });

  it('note each frame while recording, moving after the pointer, a key or the wheel, still otherwise', () => {
    win.__prGifClip = { x: 0, y: 0, width: 400, height: 300 };
    frames();
    pointer('pointermove', 10, 10);
    vi.advanceTimersByTime(16);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    vi.advanceTimersByTime(16);
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 10 }));
    vi.advanceTimersByTime(16);
    vi.advanceTimersByTime(16);
    expect(win.__prGifTicks.slice(-4).map((k) => k.moving)).toEqual([true, true, true, false]);
    const ticks = win.__prGifTicks;
    expect(ticks.every((k, i) => i === 0 || k.t >= ticks[i - 1].t)).toBe(true);
  });

  it('count an animation running in the recorded area as moving, not a paused one or one out of shot', () => {
    win.__prGifClip = { x: 0, y: 0, width: 400, height: 300 };
    /**
     * @param {unknown} el
     * @param {string} playState
     */
    const at = (el, playState) => ({ playState, effect: { target: el } });
    const inShot = { getBoundingClientRect: () => box(100, 100) };
    const outOfShot = { getBoundingClientRect: () => box(100, 900) };
    const doc = /** @type {{ getAnimations?: () => unknown[] }} */ (
      /** @type {unknown} */ (document)
    );
    /** @type {[unknown[], boolean][]} */
    const cases = [
      [[at(inShot, 'running')], true],
      [[at(inShot, 'paused')], false],
      [[at(outOfShot, 'running')], false],
      [[at(null, 'running')], true],
      [[], false],
    ];
    try {
      for (const [animations, moving] of cases) {
        doc.getAnimations = () => animations;
        vi.advanceTimersByTime(16);
        expect(win.__prGifTicks.at(-1)?.moving).toBe(moving);
      }
    } finally {
      delete doc.getAnimations;
    }
  });
});

describe('a key press', () => {
  /**
   * A focusable button whose box is `box`.
   *
   * @param {{ left: number; top: number; width: number; height: number }} box
   */
  function focusOn(box) {
    const button = document.createElement('button');
    document.body.prepend(button);
    button.getBoundingClientRect = () =>
      /** @type {ReturnType<typeof document.body.getBoundingClientRect>} */ ({
        ...box,
        right: box.left + box.width,
        bottom: box.top + box.height,
        x: box.left,
        y: box.top,
        toJSON: () => box,
      });
    button.focus();
    return button;
  }
  /**
   * @param {string} key
   * @param {ConstructorParameters<typeof KeyboardEvent>[1]} [init]
   */
  const press = (key, init = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ...init }));
  const label = () => part('key');

  it('is labelled under what has focus, a frame after the key', () => {
    focusOn({ left: 300, top: 100, width: 100, height: 40 });
    press('Tab');
    expect(label().style.opacity).not.toBe('1');
    frames();
    expect(label().textContent).toBe('Tab');
    expect(label().style.opacity).toBe('1');
    expect(label().style.left).toBe('350px');
    expect(label().style.top).toBe('148px');
    vi.advanceTimersByTime(600);
    expect(label().style.opacity).toBe('0');
  });

  it('goes over what has focus when under it would leave the recorded area, and stays inside it', () => {
    win.__prGifClip = { x: 0, y: 50, width: 400, height: 100 };
    focusOn({ left: 380, top: 100, width: 100, height: 40 });
    press('Enter');
    frames();
    expect(label().textContent).toBe('Enter');
    expect(label().style.top).toBe('92px');
    expect(label().style.left).toBe('396px');
  });

  it('sits at the bottom of the recorded area with nothing focused', () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    win.__prGifClip = { x: 0, y: 50, width: 400, height: 110 };
    press('Escape');
    frames();
    expect(label().textContent).toBe('Esc');
    expect(label().style.top).toBe('148px');
    expect(label().style.left).toBe('200px');
  });

  it('sits at the bottom of the recorded area, not on its edge, when what has focus is out of shot', () => {
    win.__prGifClip = { x: 0, y: 50, width: 400, height: 110 };
    focusOn({ left: -3000, top: 100, width: 100, height: 40 });
    press('ArrowRight');
    frames();
    expect(label().textContent).toBe('→');
    expect(label().style.left).toBe('200px');
    expect(label().style.top).toBe('148px');
  });

  it('builds up characters typed one after another, spaces and all, into one label', () => {
    for (const key of ['c', 'a', 't', ' ', 'm']) {
      press(key);
      frames();
    }
    expect(label().textContent).toBe('cat m');
    vi.advanceTimersByTime(600);
    press('d');
    frames();
    expect(label().textContent).toBe('d');
  });

  it('names a shortcut or a space on its own, and nothing for a modifier on its own', () => {
    press('k', { ctrlKey: true });
    frames();
    expect(label().textContent).toBe('Ctrl+K');
    vi.advanceTimersByTime(600);
    press(' ');
    frames();
    expect(label().textContent).toBe('Space');
    press('Shift', { shiftKey: true });
    frames();
    expect(label().textContent).toBe('Space');
  });
});

describe('a page still loading', () => {
  it('waits for the DOM before drawing, and starts off the page when what was saved is unreadable', () => {
    document.getElementById(LAYER_ID)?.remove();
    sessionStorage.setItem('prGif:pointer', '{not json');
    const state = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    try {
      new Function(OVERLAY_SCRIPT)();
      expect(document.getElementById(LAYER_ID)).toBeNull();
      state.mockReturnValue('interactive');
      document.dispatchEvent(new Event('DOMContentLoaded'));
      window.dispatchEvent(new Event('DOMContentLoaded'));
      expect(document.querySelectorAll(`#${LAYER_ID}`)).toHaveLength(1);
      expect(part('arrow').style.left).toBe('-60px');
    } finally {
      state.mockRestore();
    }
  });
});
