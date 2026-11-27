// The report page's "Needs attention" card sending you to a test: its
// slower test's "Show ↓" tapped, the test tree opens down to it and the
// page scrolls there, the test's row flashing. Recorded by PR GIFs
// (pr-gif.yml) on a PR that adds or changes it, from the page page.ts
// builds; show-test.test.ts plays it with its pauses made instant.
//
// The first of this repo's scenarios (ci#176): its folder, `gif.scenarios`
// in .github/ci.json, holds at least one, as the GIF self-test asks.

import type { Scenario } from '../../../gif/cli.ts';

/** The slower test's item in Needs attention. */
const SLOWER_TEST = '#attention [data-go^="test:"]';

export default {
  path: '/',
  ready: async (page, gif) => {
    await page.locator(SLOWER_TEST).waitFor();
    // Start beside the card, off its items.
    await gif.glide(page, { x: 200, y: 160 });
  },
  play: async (page, gif) => {
    await page.waitForTimeout(1000);
    await gif.click(page, page.locator(SLOWER_TEST).locator('.go'));
    // Held while the page glides down to the test's row, then off the row
    // it scrolled under, into the window's margin.
    await page.waitForTimeout(1000);
    await gif.glide(page, { x: 390, y: 600 });
    await page.waitForTimeout(2000);
  },
} satisfies Scenario;
