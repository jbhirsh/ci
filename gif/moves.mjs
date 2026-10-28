// The pointer moves a scenario records, at a person's pace. A scenario gets
// them in its `gif` argument (cli.mjs), so it needs nothing from this repo
// to type-check: glide, click, drag, scroll and swipe, each taking the page
// first. swipe is a finger's: for what listens to touch rather than the
// mouse (a carousel, a sheet pulled down), which drag's mouse never reaches.
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
 * @typedef {object} TouchSession What swipe needs of a CDP session.
 * @property {(method: string, params?: object) => Promise<unknown>} send
 */

/**
 * @typedef {object} TouchPage What swipe needs of a page: a page passes as is.
 * @property {Pick<Mouse, 'move'>} mouse
 * @property {() => { newCDPSession(page: object): Promise<TouchSession> }} context
 */

// Each page's session for touches, with touch turned on: made at its first
// swipe, so a scenario that never swipes leaves the page as it was.
/** @type {WeakMap<object, Promise<TouchSession>>} */
const touchSessions = new WeakMap();

/** @param {TouchPage} page */
function touchSession(page) {
  let session = touchSessions.get(page);
  if (!session) {
    session = page
      .context()
      .newCDPSession(page)
      .then(async (cdp) => {
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
        return cdp;
      });
    touchSessions.set(page, session);
  }
  return session;
}

/**
 * A finger's swipe from `from` to `to` over `ms`: the pointer glides to
 * `from`, a touch goes down there, moves at an even pace by the clock (a
 * finger still moving when it lifts, as a flick does, where an eased one
 * would stop first), and lifts at `to`. Touches are pointer events too, so
 * the drawn ring and trail show the swipe as they show a drag.
 *
 * @param {TouchPage} page
 * @param {Target} from
 * @param {Target} to
 * @param {number} [ms]
 */
export async function swipe(page, from, to, ms = 300) {
  const cdp = await touchSession(page);
  const start = await glide(page, from);
  const end = await pointOf(to);
  await wait(150);
  /**
   * @param {'touchStart' | 'touchMove' | 'touchEnd'} type
   * @param {Point} [at]
   */
  const touch = (type, at) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at ? [{ x: at.x, y: at.y }] : [] });
  await touch('touchStart', start);
  await overTime(
    ms,
    (e) =>
      touch('touchMove', {
        x: start.x + (end.x - start.x) * e,
        y: start.y + (end.y - start.y) * e,
      }).then(() => undefined),
    (t) => Math.min(Math.max(t, 0), 1),
  );
  await touch('touchEnd');
  pointers.set(page, end);
}
