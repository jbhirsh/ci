// measures.ts and measures-wide.ts played in real WebKit against the page
// page.ts builds, their pauses and moves made instant (test-play.ts).

import { webkit } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openScenario, runs } from '../test-play.ts';
import wide from './measures-wide.ts';
import phone from './measures.ts';
import type { Browser } from 'playwright';

describe.skipIf(!runs)('measures, in WebKit', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await webkit.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it.each([
    ['measures.ts', phone],
    ['measures-wide.ts', wide],
  ])(
    '%s opens games, picks Games.bgg, then the cold start and its database row',
    async (_, scenario) => {
      const { page, play, close } = await openScenario(browser, scenario);
      // Nothing is wider than the window, closed or open: the page never
      // scrolls sideways (the notes hold long URLs, as a real run's do).
      const sideways = () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
      expect(await sideways()).toBe(0);
      await play();
      expect(await sideways()).toBe(0);
      const lane = page.locator('#measures-card button.sum[data-op="games"]');
      expect(await lane.getAttribute('aria-expanded')).toBe('true');
      const cold = page.locator('#measures-card .mswitch button[data-mode="cold"]');
      expect(await cold.getAttribute('aria-selected')).toBe('true');
      const db = page.locator('#measures .wrow', { hasText: 'Opening the database' });
      expect(await db.getAttribute('aria-expanded')).toBe('true');
      // Its details, just after its row, are what the scenario ends on.
      const detail = page.locator('#measures .wrow.sel + .detail');
      expect(await detail.textContent()).toContain('db-open;dur=249');
      const box = await detail.boundingBox();
      const window = page.viewportSize();
      expect(box && window && box.y >= 0 && box.y + box.height <= window.height).toBe(true);
      await close();
    },
  );
});
