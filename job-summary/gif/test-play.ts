// Playing a scenario of the report page in real WebKit, for the scenarios'
// tests: the page page.ts builds, served as the GIF tool serves it
// (gif/route.ts), with the scenario's pauses and moves made instant. A
// scenario that can't run on the page fails its test, in Check, rather than
// on a PR's recording. Nothing waits on a clock: each test's checks are
// condition waits on the page's end state.
//
// This repo's Check job installs WebKit (ci.yml), so the tests always run
// there. Elsewhere they run when WebKit is installed (`npx playwright
// install --with-deps webkit`; a Claude cloud session has only Chromium).

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { webkit } from 'playwright';
import { glide } from '../../gif/moves.ts';
import { PAGE_ORIGIN, routePage } from '../../gif/route.ts';
import { buildPage } from './page.ts';
import type { Browser, Page } from 'playwright';
import type { Helpers, Scenario } from '../../gif/cli.ts';

/** Whether the scenarios' tests run: always in CI, elsewhere when WebKit is installed. */
export const runs = Boolean(process.env.CI) || existsSync(webkit.executablePath());

/** The moves, at once: no glide, no press held, the wheel turned in one go. */
const instant: Helpers = {
  glide: (page, target) => glide(page, target, 0),
  click: async (page, target) => {
    const at = await glide(page, target, 0);
    await page.mouse.down();
    await page.mouse.up();
    return at;
  },
  drag: async () => {
    throw new Error('the report page has nothing to drag');
  },
  scroll: async (page, dy) => {
    await page.mouse.wheel(0, dy);
  },
  swipe: async () => {
    throw new Error('the report page has nothing to swipe');
  },
  side: 'after',
  origin: PAGE_ORIGIN,
};

/** The page, its pauses (which hold a GIF's frames) made instant. */
const unpaused = (page: Page) =>
  new Proxy(page, {
    get: (target, key) => {
      if (key === 'waitForTimeout') return async () => {};
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

/**
 * Opens the built page in `browser` as `scenario` asks (its window, or a
 * phone's), its pauses made instant.
 *
 * @returns the page, and `play`, which plays the scenario on it
 */
export async function openScenario(browser: Browser, scenario: Scenario) {
  const dir = mkdtempSync(path.join(tmpdir(), 'scenario-'));
  buildPage(dir);
  const context = await browser.newContext({
    viewport: scenario.viewport ?? { width: 402, height: 874 },
    colorScheme: scenario.colorScheme ?? 'light',
    reducedMotion: 'no-preference',
  });
  await routePage(context, dir);
  const page = unpaused(await context.newPage());
  await page.goto(PAGE_ORIGIN + (scenario.path ?? '/'));
  return {
    page,
    play: async () => {
      await scenario.ready?.(page, instant);
      await scenario.play(page, instant);
    },
    close: () => context.close(),
  };
}
