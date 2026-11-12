// The pointer moves a scenario records, at a person's pace. A scenario gets
// them in its `gif` argument (cli.mjs), so it needs nothing from this repo
// to type-check: glide, click, drag, scroll and swipe, each taking the page
// first. swipe is a finger's: for what listens to touch rather than the
// mouse (a carousel, a sheet pulled down), which drag's mouse never reaches.
// It dispatches touches in the page (touchStep), so it needs no touch
// emulation from the browser, but they're the page's own events, not the
// browser's: what listens for them moves, while what the browser itself
// does with a finger (scrolling, the click after a tap) doesn't happen.
//
// They go by the clock: page.mouse.move(x, y, { steps }) sends every step in
// a few milliseconds, and while frames are being taken each one slows, so a
// count of steps would catch the arrow in one or two places either way; a
// bare down()/up() presses for no time, too short for the drawn ring to be
// in a frame; locator.click() sends no pointer moves at all; one
// page.mouse.wheel leaps the whole way between two frames, and
// window.scrollTo shows no wheel. Pause between actions (page.waitForTimeout)
// for a viewer to follow, keep the pointer inside the recorded area while it
// rests, and end on a pause, which the GIF holds before it loops.

/**
 * @typedef {object} Point
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {object} Mouse What these need of Playwright's page.mouse: a page passes as is.
 * @property {(x: number, y: number) => Promise<void>} move
 * @property {() => Promise<void>} down
 * @property {() => Promise<void>} up
 * @property {(deltaX: number, deltaY: number) => Promise<void>} wheel
 */

/**
 * @typedef {{ boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> } | Point} Target
 *   A locator (its middle), or a point in CSS pixels.
 */

/** How long the moves wait between the events they send, in ms. */
export const STEP_MS = 16;

/**
 * Eases 0..1 in and out; anything outside is held at its end.
 *
 * @param {number} t
 */
export function smoothstep(t) {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
}

/** @param {number} ms */
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Calls `step` with the eased progress, 0 to 1, every STEP_MS for `ms`, and
 * once more at 1.
 *
 * @param {number} ms
 * @param {(progress: number) => Promise<void>} step
 * @param {(t: number) => number} [ease]
 */
async function overTime(ms, step, ease = smoothstep) {
  const start = performance.now();
  for (;;) {
    const t = ms > 0 ? (performance.now() - start) / ms : 1;
    await step(ease(t));
    if (t >= 1) return;
    await wait(STEP_MS);
  }
}

// Where each page's pointer was last put, for the next move to start from.
// The same Page across a page load, so it outlives one.
/** @type {WeakMap<object, Point>} */
const pointers = new WeakMap();

/**
 * @param {Target} target
 * @returns {Promise<Point>}
 */
async function pointOf(target) {
  if (!('boundingBox' in target)) return target;
  const box = await target.boundingBox();
  if (!box) throw new Error('glide: the target has no box (is it on the page?)');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Moves the pointer to the middle of `target` (or to a point) over `ms`,
 * easing in and out from where it last was, so the drawn arrow glides there
 * rather than jumping. The first move of a page, or one of 0 ms, puts it
 * straight there. Resolves with where it went.
 *
 * @param {{ mouse: Pick<Mouse, 'move'> }} page
 * @param {Target} target
 * @param {number} [ms]
 * @returns {Promise<Point>}
 */
export async function glide(page, target, ms = 500) {
  const to = await pointOf(target);
  const from = pointers.get(page) ?? to;
  await overTime(ms, (e) =>
    page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e),
  );
  pointers.set(page, to);
  return to;
}

/**
 * A click as a person makes it: glides to `target` over `ms`, pauses, and
 * holds the button for `holdMs`, long enough for the drawn ring to be in a
 * frame.
 *
 * @param {{ mouse: Pick<Mouse, 'move' | 'down' | 'up'> }} page
 * @param {Target} target
 * @param {{ ms?: number; holdMs?: number }} [options]
 * @returns {Promise<Point>}
 */
export async function click(page, target, { ms = 500, holdMs = 200 } = {}) {
  const at = await glide(page, target, ms);
  await wait(150);
  await page.mouse.down();
  await wait(holdMs);
  await page.mouse.up();
  return at;
}

/**
 * A drag from `from` to `to`, over `ms`, holding a moment at either end.
 *
 * @param {{ mouse: Pick<Mouse, 'move' | 'down' | 'up'> }} page
 * @param {Target} from
 * @param {Target} to
 * @param {number} [ms]
 */
export async function drag(page, from, to, ms = 800) {
  await glide(page, from);
  await page.mouse.down();
  await wait(250);
  await glide(page, to, ms);
  await wait(250);
  await page.mouse.up();
}

/**
 * Turns the wheel `dy` pixels (down when positive) over `ms`, a little at a
 * time, so the page glides rather than leaping in one event, and the drawn
 * ↓/↑ stays up all the while. Glide the pointer over what scrolls first.
 *
 * @param {{ mouse: Pick<Mouse, 'wheel'> }} page
 * @param {number} dy
 * @param {number} [ms]
 */
export async function scroll(page, dy, ms = 700) {
  let done = 0;
  await overTime(ms, async (e) => {
    const target = Math.round(dy * e);
    if (target === done) return;
    await page.mouse.wheel(0, target - done);
    done = target;
  });
}

/**
 * @typedef {object} TouchStep One step of a finger's touch, as touchStep takes it.
 * @property {'start' | 'move' | 'end'} type
 * @property {Point} at where the finger is, in CSS pixels from the viewport's top left
 */

/**
 * @typedef {object} TouchPage What swipe needs of a page: a page passes as is.
 * @property {Pick<Mouse, 'move'>} mouse
 * @property {(fn: (step: TouchStep) => void, step: TouchStep) => Promise<unknown>} evaluate
 */

/**
 * One step of a finger's touch, dispatched in the page (it runs there, so it
 * uses nothing from this module): a touch pointer event, then a touch event,
 * as a phone's browser sends them, both to the element the touch started on,
 * as touches stay with it. The touch event is a plain event carrying its
 * touches, since a desktop browser (WebKit on Linux among them) has no Touch
 * constructor; what a page reads of one (`touches`, `changedTouches`, each
 * point's `clientX`/`clientY` and `target`, `preventDefault` on a cancelable
 * move) it has. The pointer event draws the ring and trail (overlay.mjs).
 *
 * @param {TouchStep} step
 */
export function touchStep({ type, at }) {
  // The page's own, named off globalThis, as this module is also Node's.
  const { document, PointerEvent } = globalThis;
  const held = /** @type {{ __prGifTouch?: EventTarget }} */ (/** @type {unknown} */ (globalThis));
  if (type === 'start') {
    held.__prGifTouch = document.elementFromPoint(at.x, at.y) ?? document.documentElement;
  }
  const target = held.__prGifTouch;
  if (!target) return;
  const pointer = { start: 'pointerdown', move: 'pointermove', end: 'pointerup' }[type];
  target.dispatchEvent(
    new PointerEvent(pointer, {
      bubbles: true,
      cancelable: true,
      composed: true,
      // Not 1, the mouse's.
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: true,
      clientX: at.x,
      clientY: at.y,
      button: type === 'move' ? -1 : 0,
      buttons: type === 'end' ? 0 : 1,
      pressure: type === 'end' ? 0 : 0.5,
    }),
  );
  const point = {
    identifier: 0,
    target,
    clientX: at.x,
    clientY: at.y,
    pageX: at.x + globalThis.scrollX,
    pageY: at.y + globalThis.scrollY,
    screenX: at.x,
    screenY: at.y,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
  };
  const event = new Event(`touch${type}`, { bubbles: true, cancelable: true, composed: true });
  const down = type === 'end' ? [] : [point];
  Object.defineProperties(event, {
    touches: { value: down },
    targetTouches: { value: down },
    changedTouches: { value: [point] },
  });
  target.dispatchEvent(event);
  if (type === 'end') delete held.__prGifTouch;
}

/**
 * A finger's swipe from `from` to `to` over `ms`: the pointer glides to
 * `from`, a touch goes down there, moves at an even pace by the clock (a
 * finger still moving when it lifts, as a flick does, where an eased one
 * would stop first), and lifts at `to`. Each step is a touch pointer event
 * and a touch event in the page (touchStep), so what listens to either
 * moves, and the drawn ring and trail show the swipe as they show a drag.
 *
 * @param {TouchPage} page
 * @param {Target} from
 * @param {Target} to
 * @param {number} [ms]
 */
export async function swipe(page, from, to, ms = 300) {
  const start = await glide(page, from);
  const end = await pointOf(to);
  await wait(150);
  /**
   * @param {TouchStep['type']} type
   * @param {Point} at
   */
  const touch = (type, at) => page.evaluate(touchStep, { type, at });
  await touch('start', start);
  await overTime(
    ms,
    (e) =>
      touch('move', {
        x: start.x + (end.x - start.x) * e,
        y: start.y + (end.y - start.y) * e,
      }).then(() => undefined),
    (t) => Math.min(Math.max(t, 0), 1),
  );
  await touch('end', end);
  pointers.set(page, end);
}
