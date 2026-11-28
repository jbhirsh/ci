// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEY_LABEL, LAYER_ID, OVERLAY_SCRIPT } from './overlay.ts';
import { keyLabel } from './timeline.ts';
import type { KeyPress } from './timeline.ts';

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

// overlay.ts's script as it runs in the page: once, in this file's jsdom
// window. jsdom has no layout, so boxes are stubbed where the label is placed.
// The window gets the key-naming binding record.ts's showPointer exposes,
// answering as Playwright's does (a promise) with the real keyLabel.

type Win = typeof globalThis & {
  __prGifMoves: { x: number; y: number; t: number }[];
  __prGifTicks: { t: number; moving: boolean }[];
  __prGifClip?: unknown;
} & Record<typeof KEY_LABEL, (press: KeyPress) => Promise<string | null>>;
const win = window as unknown as Win;
const part = (name: string) => {
  const el = document.querySelector(`[data-pr-gif="${name}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no ${name}`);
  return el;
};
const frames = () => vi.advanceTimersByTime(40);
/** Two frames, after the binding has answered. */
const labelled = () => vi.advanceTimersByTimeAsync(40);
const named = (press: KeyPress) => Promise.resolve(keyLabel(press));
let naming = named;
const pointer = (type: string, x = 0, y = 0) =>
  window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y }));

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'Date'] });
  // As if the page before had the pointer here.
  sessionStorage.setItem('prGif:pointer', JSON.stringify({ x: 7, y: 9 }));
  win[KEY_LABEL] = (press) => naming(press);
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
    for (const [deltaX, deltaY, arrow] of [
      [0, 100, '↓'],
      [0, -100, '↑'],
      [100, 0, '→'],
      [-100, 0, '←'],
      [50, 50, '↓'],
      [80, 10, '→'],
    ] as const) {
      window.dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY }));
      expect(part('wheel').textContent).toBe(arrow);
      expect(part('wheel').style.opacity).toBe('1');
    }
    vi.advanceTimersByTime(400);
    expect(part('wheel').style.opacity).toBe('0');
  });
});

describe('the ticks', () => {
  const box = (left: number, top: number) => ({
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
    const at = (el: unknown, playState: string) => ({ playState, effect: { target: el } });
    const inShot = { getBoundingClientRect: () => box(100, 100) };
    const outOfShot = { getBoundingClientRect: () => box(100, 900) };
    const doc = document as unknown as { getAnimations?: () => unknown[] };
    const cases: [unknown[], boolean][] = [
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
   */
  function focusOn(box: { left: number; top: number; width: number; height: number }) {
    const button = document.createElement('button');
    document.body.prepend(button);
    button.getBoundingClientRect = () =>
      ({
        ...box,
        right: box.left + box.width,
        bottom: box.top + box.height,
        x: box.left,
        y: box.top,
        toJSON: () => box,
      }) as ReturnType<typeof document.body.getBoundingClientRect>;
    button.focus();
    return button;
  }
  const press = (key: string, init: ConstructorParameters<typeof KeyboardEvent>[1] = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ...init }));
  const label = () => part('key');

  it('is labelled under what has focus, a frame after its name comes back', async () => {
    focusOn({ left: 300, top: 100, width: 100, height: 40 });
    press('Tab');
    expect(label().style.opacity).not.toBe('1');
    await labelled();
    expect(label().textContent).toBe('Tab');
    expect(label().style.opacity).toBe('1');
    expect(label().style.left).toBe('350px');
    expect(label().style.top).toBe('148px');
    vi.advanceTimersByTime(600);
    expect(label().style.opacity).toBe('0');
  });

  it('goes over what has focus when under it would leave the recorded area, and stays inside it', async () => {
    win.__prGifClip = { x: 0, y: 50, width: 400, height: 100 };
    focusOn({ left: 380, top: 100, width: 100, height: 40 });
    press('Enter');
    await labelled();
    expect(label().textContent).toBe('Enter');
    expect(label().style.top).toBe('92px');
    expect(label().style.left).toBe('396px');
  });

  it('sits at the bottom of the recorded area with nothing focused', async () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    win.__prGifClip = { x: 0, y: 50, width: 400, height: 110 };
    press('Escape');
    await labelled();
    expect(label().textContent).toBe('Esc');
    expect(label().style.top).toBe('148px');
    expect(label().style.left).toBe('200px');
  });

  it('sits at the bottom of the recorded area, not on its edge, when what has focus is out of shot', async () => {
    win.__prGifClip = { x: 0, y: 50, width: 400, height: 110 };
    focusOn({ left: -3000, top: 100, width: 100, height: 40 });
    press('ArrowRight');
    await labelled();
    expect(label().textContent).toBe('→');
    expect(label().style.left).toBe('200px');
    expect(label().style.top).toBe('148px');
  });

  it('builds up characters typed one after another, spaces and all, into one label', async () => {
    for (const key of ['c', 'a', 't', ' ', 'm']) {
      press(key);
      await labelled();
    }
    expect(label().textContent).toBe('cat m');
    vi.advanceTimersByTime(600);
    press('d');
    await labelled();
    expect(label().textContent).toBe('d');
  });

  it('names a shortcut or a space on its own, and nothing for a modifier on its own', async () => {
    press('k', { ctrlKey: true });
    await labelled();
    expect(label().textContent).toBe('Ctrl+K');
    vi.advanceTimersByTime(600);
    press(' ');
    await labelled();
    expect(label().textContent).toBe('Space');
    press('Shift', { shiftKey: true });
    await labelled();
    expect(label().textContent).toBe('Space');
  });

  it("asks Node to name it with the key's fields", async () => {
    const asked: KeyPress[] = [];
    naming = (p) => (asked.push(p), named(p));
    try {
      press('k', { shiftKey: true, altKey: true, metaKey: true });
      await labelled();
    } finally {
      naming = named;
    }
    expect(asked).toEqual([
      { key: 'k', shiftKey: true, ctrlKey: false, altKey: true, metaKey: true },
    ]);
    expect(label().textContent).toBe('Alt+Meta+Shift+K');
  });

  it('shows labels in the order their keys went down, whatever order Node answers in', async () => {
    const asked: { press: KeyPress; answer: (label: string | null) => void }[] = [];
    naming = (p) => new Promise((answer) => asked.push({ press: p, answer }));
    try {
      press('o');
      press('k');
      expect(asked.map(({ press: p }) => p.key)).toEqual(['o', 'k']);
      asked[1].answer(keyLabel(asked[1].press));
      await labelled();
      expect(label().style.opacity).toBe('0');
      asked[0].answer(keyLabel(asked[0].press));
      await labelled();
    } finally {
      naming = named;
    }
    expect(label().textContent).toBe('ok');
    expect(label().style.opacity).toBe('1');
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
