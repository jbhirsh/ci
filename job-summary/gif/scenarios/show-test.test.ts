// show-test.ts played in real WebKit against the page page.ts builds,
// served as the GIF tool serves it (gif/route.ts), with its pauses and
// glides made instant: a scenario that can't run on the page fails here,
// in Check, rather than on a PR's recording. Nothing waits on a clock: each
// check is a condition wait on the page's end state.
//
// This repo's Check job installs WebKit (ci.yml), so the test always runs
// there. Elsewhere it runs when WebKit is installed (`npx playwright
// install --with-deps webkit`; a Claude cloud session has only Chromium).

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { webkit } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { glide } from '../../../gif/moves.ts';
import { PAGE_ORIGIN, routePage } from '../../../gif/route.ts';
import { buildPage } from '../page.ts';
import scenario from './show-test.ts';
import type { Browser, Page } from 'playwright';
import type { Helpers } from '../../../gif/cli.ts';

const runs = Boolean(process.env.CI) || existsSync(webkit.executablePath());

/** The moves, at once: no glide, no press held. */
const instant: Helpers = {
  glide: (page, target) => glide(page, target, 0),
  click: async (page, target) => {
    const at = await glide(page, target, 0);
    await page.mouse.down();
    await page.mouse.up();
    return at;
  },
  drag: async () => {
    throw new Error('show-test.ts drags nothing');
  },
  scroll: async () => {
    throw new Error('show-test.ts scrolls nothing');
  },
  swipe: async () => {
    throw new Error('show-test.ts swipes nothing');
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

describe.skipIf(!runs)('show-test, in WebKit', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await webkit.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('opens the tree down to the slower test and brings its row into view', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'show-test-'));
    buildPage(dir);
    const context = await browser.newContext({
      viewport: { width: 402, height: 874 },
      reducedMotion: 'no-preference',
    });
    await routePage(context, dir);
    const page = unpaused(await context.newPage());
    await page.goto(PAGE_ORIGIN + (scenario.path ?? '/'));
    const row = page.locator('#tree [data-ti]', {
      hasText: 'plays the scenario against the routed page',
    });
    expect(await row.count()).toBe(0);
    await scenario.ready?.(page, instant);
    await scenario.play(page, instant);
    await row.waitFor();
    for (const id of ['gif/', 'gif/cli.test.ts', 'gif/cli.test.ts › recordSide']) {
      expect(await page.locator(`#tree [data-id="${id}"]`).getAttribute('aria-expanded')).toBe(
        'true',
      );
    }
    // Once the page's smooth scroll has brought the row on screen.
    await row.evaluate(
      (el) =>
        new Promise<void>((done) => {
          const seen = new IntersectionObserver(
            (entries) => {
              if (entries.some((e) => e.intersectionRatio === 1)) {
                seen.disconnect();
                done();
              }
            },
            { threshold: 1 },
          );
          seen.observe(el);
        }),
    );
    await context.close();
  });
});
