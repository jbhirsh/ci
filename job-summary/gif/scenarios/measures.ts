// The report page's "Where the time went" card, a probe's measurements
// (ci#151): the games request's lane opened, its slower `Games.bgg` field
// picked, then Cold start, and its "Opening the database" phase picked, its
// details open. On a phone, in light. Recorded by PR GIFs (pr-gif.yml) on a
// PR that adds or changes it, from the page page.ts builds (fixture.ts
// holds the measurements); measures.test.ts plays it with its pauses made
// instant. measures-wide.ts plays it at 1000 px.
//
// Each step is held a moment, so whoever watches can read what it opened.

import type { Locator, Page } from 'playwright';
import type { Helpers, Scenario } from '../../../gif/cli.ts';

/** The games request's lane. */
const GAMES = '#measures-card button.sum[data-op="games"]';
/** The card's Cold start tab. */
const COLD = '#measures-card .mswitch button[data-mode="cold"]';
/** A part's row in the opened lane, by its name. */
const row = (page: Page, name: string) => page.locator('#measures .wrow', { hasText: name });

/** How far from the window's edges a target is brought, in CSS pixels. */
const MARGIN = 16;

/**
 * Scrolls `target` into the window, its top MARGIN below the window's top
 * when it's above or `top` is set, or its bottom MARGIN above the window's
 * bottom when it's below, with the wheel as a person would. Returns once the
 * page is where the wheel took it: the next glide aims at where the target
 * is then.
 */
async function bring(page: Page, gif: Helpers, target: Locator, { top = false } = {}) {
  const box = await target.boundingBox();
  if (!box) throw new Error(`measures: ${target.toString()} has no box`);
  const { height } = page.viewportSize() ?? { height: 0 };
  let dy = 0;
  if (top || box.y < MARGIN) dy = box.y - MARGIN;
  else if (box.y + box.height > height - MARGIN) dy = box.y + box.height - (height - MARGIN);
  if (Math.abs(dy) < 1) return;
  // Where the wheel stops, worked out here from the page's numbers: the
  // page gets only expressions as text, never a function's source, which
  // Stryker instruments with helpers the page lacks (CLAUDE.md).
  const [scrollY, scrollHeight, innerHeight] = (await page.evaluate(
    '[window.scrollY, document.documentElement.scrollHeight, window.innerHeight]',
  )) as [number, number, number];
  const to = Math.round(Math.min(Math.max(scrollY + dy, 0), scrollHeight - innerHeight));
  await gif.scroll(page, Math.round(dy));
  await page.waitForFunction(`Math.abs(window.scrollY - ${to}) < 1`);
}

/** Glides to `target`, brought into view first, and clicks it. */
async function pick(page: Page, gif: Helpers, target: Locator) {
  await bring(page, gif, target);
  await gif.click(page, target);
}

export default {
  path: '/',
  viewport: { width: 402, height: 874 },
  colorScheme: 'light',
  ready: async (page, gif) => {
    await page.locator(GAMES).waitFor();
    // Start in the page's margin, beside Needs attention.
    await gif.glide(page, { x: 200, y: 120 });
  },
  play: async (page, gif) => {
    await page.waitForTimeout(800);
    // Over the card, then the card brought up to the window's top.
    await gif.glide(page, { x: 200, y: 500 });
    await bring(page, gif, page.locator('#measures-card'), { top: true });
    await page.waitForTimeout(600);
    await pick(page, gif, page.locator(GAMES));
    await page.waitForTimeout(1400);
    await pick(page, gif, row(page, 'Games.bgg'));
    await bring(page, gif, page.locator('#measures .detail'));
    await page.waitForTimeout(2200);
    await pick(page, gif, page.locator(COLD));
    await page.waitForTimeout(1400);
    await pick(page, gif, row(page, 'Opening the database'));
    await bring(page, gif, page.locator('#measures .detail'));
    await page.waitForTimeout(2600);
  },
} satisfies Scenario;
