// The overlay's arrow in real WebKit, through the screencast record.ts takes
// its frames from: the screencast sends only what a repaint changed, so an
// arrow whose old place isn't repainted stays in every frame after, and a
// glide leaves a trail of arrows. A screenshot repaints the whole page and
// can't show it. The frames are JPEGs, decoded by a second page's canvas.
// No wait but on the frames themselves: each check polls the latest one.
//
// This repo's Check job installs WebKit (ci.yml), so the test always runs
// there. Elsewhere it runs when WebKit is installed (`npx playwright
// install --with-deps webkit`; a Claude cloud session has only Chromium).

import { existsSync } from 'node:fs';
import { webkit } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OVERLAY_SCRIPT } from './overlay.ts';
import { FIRST_FRAME_MS } from './record.ts';
import type { Browser, Page } from 'playwright';

const runs = Boolean(process.env.CI) || existsSync(webkit.executablePath());

const VIEWPORT = { width: 400, height: 600 };

/**
 * Whether the JPEG `frame` is of the page (light where nothing is drawn, as
 * the screencast's first frame can be black) with something dark, the
 * arrow, just below and right of `at`, where its tip points from.
 */
async function arrowAt(decoder: Page, frame: Buffer, at: { x: number; y: number }) {
  return decoder.evaluate(
    async ({ src, at }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const g = canvas.getContext('2d') as CanvasRenderingContext2D;
      g.drawImage(img, 0, 0);
      const dark = (x: number, y: number, w: number, h: number) => {
        const { data } = g.getImageData(x, y, w, h);
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] + data[i + 1] + data[i + 2] < 150) return true;
        }
        return false;
      };
      return !dark(img.width - 20, img.height - 20, 20, 20) && dark(at.x, at.y, 14, 18);
    },
    { src: `data:image/jpeg;base64,${frame.toString('base64')}`, at },
  );
}

describe.skipIf(!runs)('the overlay, in WebKit', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await webkit.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('leaves no arrow behind where the pointer was, in the screencast of a still page', async () => {
    const context = await browser.newContext({ viewport: VIEWPORT });
    await context.addInitScript({ content: OVERLAY_SCRIPT });
    const page = await context.newPage();
    await context.route('http://still.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<body style="margin:0;background:#f6f4ef"><h1>A still page</h1></body>',
      }),
    );
    await page.goto('http://still.test/');
    const decoder = await browser.newPage();
    let latest: Buffer | undefined;
    const screencast = page.screencast;
    if (!screencast) throw new Error("this Playwright's page has no screencast");
    await screencast.start({
      size: VIEWPORT,
      quality: 90,
      onFrame: ({ data }) => (latest = data),
    });
    const showsArrow = (at: { x: number; y: number }) => () =>
      latest ? arrowAt(decoder, latest, at) : false;
    const from = { x: 100, y: 150 };
    const mid = { x: 200, y: 300 };
    const to = { x: 300, y: 450 };
    // As long as the recorder allows for a frame: a hang limit, never the success path.
    const limit = { timeout: FIRST_FRAME_MS };

    await page.mouse.move(from.x, from.y);
    await expect.poll(showsArrow(from), limit).toBe(true);
    // A glide, as a scenario's is: the arrow passes through mid on its way.
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await expect.poll(showsArrow(to), limit).toBe(true);
    expect(await showsArrow(from)()).toBe(false);
    expect(await showsArrow(mid)()).toBe(false);

    await screencast.stop();
    await context.close();
  });
});
