// drive.ts in real WebKit, against two local node:http servers: the
// deployment, protected as Vercel protects a preview (a request needs the
// bypass cookie, which a request carrying the secret and
// `x-vercel-set-bypass-cookie` sets), and a second origin standing in for
// Sentry's ingest, on another host (localhost rather than 127.0.0.1: a
// cookie is kept per host, not per port). The page is reached through a
// redirect to the second origin and back, and makes a request that
// redirects there too, so a secret that followed a redirect would show.
// No network, and no wait but on events: the page's own requests are
// chained, so each one the test checks has reached its server before the
// listed request the driver waits for goes out.
//
// This repo's Check job installs WebKit (ci.yml), so the test always runs
// there. Elsewhere it runs when WebKit is installed (`npx playwright
// install --with-deps webkit`; a Claude cloud session has only Chromium).

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { webkit } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSettings } from '../settings.ts';
import { drive } from './drive.ts';
import type { IncomingHttpHeaders, RequestListener, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright';

interface Hit {
  url: string;
  method: string;
  headers: IncomingHttpHeaders;
}

interface Listening {
  server: Server;
  port: number;
}

/**
 * Starts a server on a free port, resolved once it's listening, on the
 * interface `host`, or every one when absent.
 */
function listen(listener: RequestListener, host?: string): Promise<Listening> {
  const server = createServer(listener);
  return new Promise((resolve) => {
    const done = () => {
      const address = server.address() as AddressInfo;
      resolve({ server, port: address.port });
    };
    if (host) server.listen(0, host, done);
    else server.listen(0, done);
  });
}

const SECRET = 's3cret';
const BYPASS = 'x-vercel-protection-bypass';
const COOKIE = '_vercel_jwt=ok';
const runs = Boolean(process.env.CI) || existsSync(webkit.executablePath());

describe.skipIf(!runs)('drive, in WebKit', () => {
  const deployment: Hit[] = [];
  const ingest: Hit[] = [];
  let app: Listening;
  let other: Listening;
  let browser: Browser;
  const origin = () => `http://127.0.0.1:${app.port}`;
  const otherOrigin = () => `http://localhost:${other.port}`;

  beforeAll(async () => {
    other = await listen((req, res) => {
      ingest.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers });
      if (req.url === '/hop') res.writeHead(302, { location: `${origin()}/` }).end();
      else res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
    });
    let served = false;
    app = await listen((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      deployment.push({ url: url.pathname, method: req.method ?? '', headers: req.headers });
      if (req.headers[BYPASS] === SECRET && req.headers['x-vercel-set-bypass-cookie'] === 'true') {
        // As Vercel does: the cookie on a redirect back to the page.
        res
          .writeHead(307, {
            location: '/',
            'set-cookie': `${COOKIE}; Path=/; HttpOnly; SameSite=Lax`,
          })
          .end();
        return;
      }
      if (!(req.headers.cookie ?? '').split('; ').includes(COOKIE)) {
        res.writeHead(401).end();
        return;
      }
      if (url.pathname === '/go') {
        res.writeHead(302, { location: `${otherOrigin()}/hop` }).end();
      } else if (url.pathname === '/api/redirect') {
        res.writeHead(302, { location: `${otherOrigin()}/leak` }).end();
      } else if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html>
<script>
  (async () => {
    await fetch('${otherOrigin()}/api/1/envelope/', { method: 'POST', body: '{}', mode: 'no-cors' }).catch(() => {});
    await fetch('${otherOrigin()}/pixel', { mode: 'no-cors' });
    await fetch('/api/redirect', { mode: 'no-cors' }).catch(() => {});
    await fetch('/_vercel/insights/view', { method: 'POST', body: '{}' }).catch(() => {});
    await navigator.serviceWorker?.register('/sw.js').catch(() => {});
    const query = encodeURIComponent('query Games { games }');
    await fetch('/api/graphql?operationName=Games&query=' + query);
  })();
</script>`);
      } else if (url.pathname === '/api/graphql') {
        const timing = served
          ? 'total;dur=2.5'
          : 'cold, loaded;dur=30, field.games;dur=1.5;desc="Query.games";calls=1, total;dur=4';
        served = true;
        res.writeHead(200, { 'content-type': 'application/json', 'server-timing': timing });
        res.end('{"data":{"games":[]}}');
      } else if (url.pathname === '/sw.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' }).end('');
      } else {
        res.writeHead(404).end();
      }
    }, '127.0.0.1');
    browser = await webkit.launch();
  });

  afterAll(async () => {
    await browser?.close();
    app?.server.close();
    other?.server.close();
  });

  it('measures cold then warm through the bypass cookie, never sends the secret anywhere else, aborts writes, blocks workers, and times each request', async () => {
    const settings = parseSettings({
      pages: [{ path: '/go', expect: ['games'] }],
      requests: [{ name: 'games', path: '/api/graphql', operation: 'Games' }],
      repeats: 2,
      timeout: 20,
      headers: { 'x-synthetic': 'probe' },
    });
    const outcome = await drive({
      browser,
      settings,
      target: origin(),
      environment: 'production',
      secret: SECRET,
    });

    expect(outcome.problems).toEqual([]);
    expect(outcome.notes).toEqual([
      'cold carried by: games',
      `3 requests not sent: POST ${otherOrigin()}/api/1/envelope/, not a read`,
      '3 requests not sent: POST /_vercel/insights/view, not a read',
    ]);
    const rows = outcome.measurements.map((m) => `${m.start} ${m.phase}`);
    expect(rows).toEqual([
      'cold loaded',
      'cold field.games',
      'cold total',
      'cold browser',
      'warm total',
      'warm browser',
      'warm total',
      'warm browser',
    ]);

    // request.timing() gives real numbers on a routed request.
    for (const row of outcome.measurements.filter((m) => m.phase === 'browser')) {
      expect(Number.isFinite(row.ms)).toBe(true);
      expect(row.ms).toBeGreaterThanOrEqual(0);
      expect(row.requestStartMs).toBeGreaterThanOrEqual(0);
      expect(row.responseStartMs).toBeGreaterThanOrEqual(row.requestStartMs as number);
    }

    // The secret went only in the one request per load that sets the
    // cookie; the browser's own requests reached the protected deployment
    // by the cookie, with the app's headers.
    const setups = deployment.filter((hit) => hit.headers[BYPASS] !== undefined);
    expect(setups).toHaveLength(3);
    const own = deployment.filter((hit) => hit.headers[BYPASS] === undefined);
    expect(own.filter((hit) => hit.url === '/api/graphql')).toHaveLength(3);
    for (const hit of own) {
      expect(hit.headers.cookie).toContain(COOKIE);
      expect(hit.headers['x-synthetic']).toBe('probe');
    }

    // The second origin, reached by a navigation's redirect, a request's
    // redirect and the page itself, never saw the secret or the cookie, nor
    // the write the page tried. The app's own headers reach it only by
    // following a redirect, as Playwright carries a route's added headers
    // along a redirect (drive.ts's header): never on a request of its own.
    expect(ingest.map((hit) => `${hit.method} ${hit.url}`).sort()).toEqual(
      ['GET /hop', 'GET /leak', 'GET /pixel'].flatMap((hit) => [hit, hit, hit]),
    );
    for (const hit of ingest) {
      expect(hit.headers).not.toHaveProperty(BYPASS);
      expect(hit.headers.cookie ?? '').not.toContain(COOKIE);
      if (hit.url === '/pixel') expect(hit.headers).not.toHaveProperty('x-synthetic');
    }

    // The unlisted write never left the browser, and no service worker's
    // script was fetched (with serviceWorkers 'allow' it is).
    expect(deployment.map((hit) => hit.url)).not.toContain('/_vercel/insights/view');
    expect(deployment.map((hit) => hit.url)).not.toContain('/sw.js');
  });
});
