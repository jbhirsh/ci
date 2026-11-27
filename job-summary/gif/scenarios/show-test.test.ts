// show-test.ts played in real WebKit against the page page.ts builds, its
// pauses and moves made instant (test-play.ts).

import { webkit } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openScenario, runs } from '../test-play.ts';
import scenario from './show-test.ts';
import type { Browser } from 'playwright';

describe.skipIf(!runs)('show-test, in WebKit', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await webkit.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('opens the tree down to the slower test and brings its row into view', async () => {
    const { page, play, close } = await openScenario(browser, scenario);
    const row = page.locator('#tree [data-ti]', {
      hasText: 'plays the scenario against the routed page',
    });
    expect(await row.count()).toBe(0);
    await play();
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
    await close();
  });
});
