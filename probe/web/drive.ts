// The web driver: loads each of the app's listed pages on a deployment, in
// a browser it's handed (WebKit, from run.ts; a fake in the tests), and
// turns each listed request's response into measurements (../results.ts).
//
// Each page is loaded 1 + `repeats` times, each in a fresh browser context:
// no cache carried over, and service workers blocked, since one answers
// requests before the route below sees them. Load 1 is the first visit;
// loads 2 on are the warm repeats.
//
// No browser request ever carries the bypass secret. With one given, each
// load starts with a single request from the context's own API client
// (context.request, which shares the context's cookie jar) to the
// deployment's root, carrying `x-vercel-protection-bypass` and
// `x-vercel-set-bypass-cookie: true`, following no redirect: Vercel answers
// it with its bypass cookie, on a redirect back to the deployment, a
// host-only cookie the browser then sends on its own requests to the
// deployment and, being a browser, never to another origin, redirects
// included. (A header added through route.continue would follow every
// redirect the request starts, to any origin.) A redirect elsewhere (its
// sign-in) or without `Set-Cookie`, a 401 or a 403 means the secret was
// refused, and the load isn't made. That request isn't the page's, so the response listener
// below never sees it: an app whose root its function serves, rather than
// a static file, would have a cold flag there go unseen (BoardGames' root
// is static).
//
// One `context.route('**/*')` handler sees every request:
//   - a non-GET, non-HEAD request, to any origin, goes out only when it's a
//     request to the deployment listed in `reads`, or in `previewSafe` on a
//     preview. Any other one is aborted before it leaves the browser and
//     noted; that fails the probe only when it's a request the app listed
//     to time;
//   - to the deployment's own origin (scheme, host and port), it adds the
//     app's non-secret `headers` (../match.ts). Playwright carries headers
//     added this way along every redirect the request starts, so a request
//     the deployment redirects elsewhere takes them there: which is why
//     the secret never goes this way;
//   - to any other origin (Sentry's ingest, fonts) it passes a request on
//     untouched;
//   - with `coldFirst`, on the first page's first load only, it holds
//     every other request to the deployment's origin that a page's script
//     sends (`fetch`, `xhr` or `eventsource`, by request.resourceType(),
//     whatever its path), after the write checks above, until the named
//     request's own wait (below) ends, whichever way: its response, its
//     abort as a write, its failure in the network (the page's
//     `requestfailed`: no response comes, and the failure is the problem),
//     or its hang limit. No timer of its own. So the
//     named request is the first API call to reach the deployment, and a
//     fresh instance serves it first. A held request is left out of that
//     load, and counted: in WebKit its timing (responseEnd) includes the
//     hold, and a cold flag it carried would have the named request's
//     cold start inside it; a redirected one is known by the request it
//     was redirected from. It gets no problem of its own when its wait
//     ends unanswered (the named request's is the one that says why), nor
//     when it's listed and its response would raise one (a 500, or no
//     `Server-Timing`): the warm loads, which hold nothing, catch that.
//     A request sent once the named one's wait has ended isn't held, and
//     a named request that fails while another named one is on its way
//     (the page cancelled one of two) doesn't end the wait.
//
// It waits only on events: page.waitForResponse for each request the page
// must make, set up before page.goto, then response.finished() so the
// request's timing is complete. The `timeout` setting is only those waits'
// hang limit.
//
// Each listed response becomes rows: one per `Server-Timing` entry with a
// `dur` (a `field.<path>` entry keeps its `desc`, `calls`, `slowest` and
// `span`; any entry its `start`), plus `browser`, the browser's own time for the
// request (request.timing()'s responseEnd - requestStart). A response is
// cold only when its `Server-Timing` carries the app's cold flag; the flag
// is read from every response on the deployment, timed or not, and the
// notes name which request carried it. On load 1, a response without the
// flag is left out, and counted: it shared an instance that was starting,
// and its time is neither a cold start's nor a warm request's. A response served from a
// cache (`Age` above 0, or `x-vercel-cache: HIT`) is left out, and counted.
//
// It returns problems, rather than throwing, for what breaks the measuring:
// a listed response that isn't 2xx, has no `Server-Timing` entry with a
// `dur`, never came within the hang limit, or was aborted; a page that
// didn't load, or whose path leads off the deployment's origin; and a
// refused bypass secret. A slow number is never a problem.

import { hasEntry, parseServerTiming } from '../server-timing.ts';
import {
  addedHeaders,
  findListed,
  isListed,
  operationOf,
  readsByMethod,
  sameOrigin,
} from '../match.ts';

import type { Seen } from '../match.ts';
import type { Measurement, Start } from '../results.ts';
import type { PageSpec, ProbeSettings, RequestSpec } from '../settings.ts';
import type { Browser, BrowserContext, Request, Response, Route } from 'playwright';

/** The requests a page's script sends: what `coldFirst` holds. */
const SCRIPT_TYPES = new Set(['fetch', 'xhr', 'eventsource']);

/** The header Vercel reads its Protection Bypass for Automation secret from. */
export const BYPASS_HEADER = 'x-vercel-protection-bypass';
/** The header that has Vercel answer the secret with its bypass cookie. */
export const SET_COOKIE_HEADER = 'x-vercel-set-bypass-cookie';

/**
 * Whether a bypass request's answer set a cookie and, if it redirects, stays
 * on the deployment: Vercel answers `x-vercel-set-bypass-cookie` with a
 * redirect back to the page carrying `Set-Cookie`, while a refused secret
 * redirects to Vercel's sign-in on another origin, or answers 401 or 403.
 */
export function setsBypassCookie(
  response: {
    headers(): Record<string, string>;
    headersArray(): { name: string; value: string }[];
  },
  target: string,
): boolean {
  const cookie = response.headersArray().some(({ name }) => name.toLowerCase() === 'set-cookie');
  const location = response.headers()['location'];
  if (!location) return cookie;
  let to: URL;
  try {
    to = new URL(location, target);
  } catch {
    return false;
  }
  return cookie && to.origin === new URL(target).origin;
}

export interface DriveOptions {
  browser: Pick<Browser, 'newContext'>;
  settings: ProbeSettings;
  /** The deployment's URL. */
  target: string;
  environment: 'production' | 'preview';
  /** The bypass secret, or ''. */
  secret: string;
}

export interface Outcome {
  measurements: Measurement[];
  notes: string[];
  problems: string[];
}

/** A request as match.ts reads it. */
const seenOf = (request: Request): Seen => ({
  url: request.url(),
  method: request.method(),
  body: request.postData(),
});

/**
 * How a request reads in a note: its method, its path (its origin too when
 * it isn't the deployment's) and its operation, if any.
 */
function describe(seen: Seen, target: string): string {
  const url = new URL(seen.url);
  const where = sameOrigin(seen.url, target) ? url.pathname : `${url.origin}${url.pathname}`;
  const operation = operationOf(seen.url, seen.body);
  return `${seen.method} ${where}${operation ? ` (${operation})` : ''}`;
}

/** Whether a cache answered, rather than the app. */
function fromCache(headers: Record<string, string>): boolean {
  const age = Number(headers.age);
  return (Number.isFinite(age) && age > 0) || /^hit$/i.test(headers['x-vercel-cache'] ?? '');
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Loads every listed page, 1 + repeats times each, and measures its listed
 * requests.
 */
export async function drive({
  browser,
  settings,
  target,
  environment,
  secret,
}: DriveOptions): Promise<Outcome> {
  const measurements: Measurement[] = [];
  const problems = new Set<string>();
  const coldBy = new Set<string>();
  const notSent = new Map<string, number>();
  let cached = 0;
  let untimed = 0;
  let leftOut = 0;
  let held = 0;
  let coldFirstWarm = false;
  const limit = settings.timeout * 1000;
  const requests = new Map(settings.requests.map((spec) => [spec.name, spec]));
  const unlisted = environment === 'preview' ? 'not a read or preview-safe' : 'not a read';

  /** The name a request goes by: its listed name, or how it reads. */
  const nameOf = (seen: Seen): string =>
    findListed(settings.requests, seen, target)?.name ?? describe(seen, target);

  /** Notes whether a response on the deployment carried the cold flag. */
  async function noteCold(response: Response): Promise<void> {
    const request = response.request();
    if (!sameOrigin(request.url(), target)) return;
    const headers = await response.allHeaders();
    if (fromCache(headers)) return;
    if (hasEntry(parseServerTiming(headers['server-timing'] ?? ''), settings.cold)) {
      coldBy.add(nameOf(seenOf(request)));
    }
  }

  /**
   * Turns one listed response into rows; `first` is whether this is load 1.
   */
  async function measure(spec: RequestSpec, response: Response, first: boolean): Promise<void> {
    const status = response.status();
    if (status < 200 || status > 299) {
      const hint =
        status === 401 || status === 403
          ? ': check the bypass secret (VERCEL_AUTOMATION_BYPASS_SECRET, and probe.hosts)'
          : '';
      problems.add(`${spec.name}: answered ${status}${hint}`);
      return;
    }
    const headers = await response.allHeaders();
    if (fromCache(headers)) {
      cached += 1;
      return;
    }
    const header = headers['server-timing'];
    const entries = parseServerTiming(header ?? '');
    const timed = entries.filter((entry) => entry.dur !== undefined);
    if (timed.length === 0) {
      problems.add(
        header === undefined
          ? `${spec.name}: its response has no Server-Timing header`
          : `${spec.name}: its Server-Timing has no entry with a dur`,
      );
      return;
    }
    const cold = hasEntry(entries, settings.cold);
    if (first && !cold) {
      leftOut += 1;
      return;
    }
    const start: Start = cold ? 'cold' : 'warm';
    for (const entry of timed) {
      const row: Measurement = {
        name: spec.name,
        phase: entry.name,
        start,
        ms: entry.dur as number,
      };
      if (entry.desc !== undefined) row.label = entry.desc;
      if (entry.calls !== undefined) row.calls = entry.calls;
      if (entry.slowest !== undefined) row.slowestMs = entry.slowest;
      if (entry.start !== undefined) row.atMs = entry.start;
      if (entry.span !== undefined) row.spanMs = entry.span;
      measurements.push(row);
    }
    const failed = await response.finished();
    const timing = response.request().timing();
    if (failed === null && timing.requestStart >= 0 && timing.responseEnd >= timing.requestStart) {
      measurements.push({
        name: spec.name,
        phase: 'browser',
        start,
        // To a microsecond: the subtraction leaves float noise (2.0949999999999998).
        ms: Math.round((timing.responseEnd - timing.requestStart) * 1000) / 1000,
        requestStartMs: timing.requestStart,
        ...(timing.responseStart >= 0 ? { responseStartMs: timing.responseStart } : {}),
      });
    } else {
      untimed += 1;
    }
  }

  /**
   * Has Vercel set its bypass cookie in the context, from one request that
   * carries the secret and follows no redirect. Whether the load can go on.
   */
  async function setBypassCookie(context: BrowserContext): Promise<boolean> {
    if (!secret) return true;
    let status: number;
    let setsCookieHere: boolean;
    try {
      const response = await context.request.get(new URL('/', target).href, {
        headers: { ...settings.headers, [BYPASS_HEADER]: secret, [SET_COOKIE_HEADER]: 'true' },
        maxRedirects: 0,
        timeout: limit,
      });
      status = response.status();
      setsCookieHere = setsBypassCookie(response, target);
      await response.dispose();
    } catch (error) {
      problems.add(
        `the bypass cookie's request failed: ${error instanceof Error ? error.message : error}`,
      );
      return false;
    }
    if (status >= 200 && status <= 299) return true;
    // Vercel sets the cookie with a redirect back to the deployment.
    if (status >= 300 && status <= 399 && setsCookieHere) return true;
    problems.add(
      (status >= 300 && status <= 399) || status === 401 || status === 403
        ? `the bypass secret was refused (answered ${status}): check VERCEL_AUTOMATION_BYPASS_SECRET`
        : `the bypass cookie's request to / answered ${status}`,
    );
    return false;
  }

  /** One load of one page, in a fresh context. */
  async function load(page: PageSpec, first: boolean): Promise<void> {
    const url = new URL(page.path, target);
    if (url.origin !== new URL(target).origin) {
      problems.add(`${page.path}: leads to ${url.origin}, not the deployment's origin`);
      return;
    }
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let closing = false;
    const abortable: { spec: RequestSpec; reject: (error: Error) => void }[] = [];
    const pending: Promise<void>[] = [];
    // With coldFirst, on the first page's first load: the named request,
    // the requests held until its wait ends, and that end.
    const named =
      first && page === settings.pages[0] && settings.coldFirst !== undefined
        ? (requests.get(settings.coldFirst) as RequestSpec)
        : null;
    const holding = new Set<Request>();
    // Whether the named request's wait has ended: from then on, nothing is
    // held (a request sent after it answered is measured as usual).
    let releasing = false;
    let resolveReleased = () => {};
    const released = new Promise<void>((resolve) => (resolveReleased = resolve));
    const release = () => {
      releasing = true;
      resolveReleased();
    };
    /** Named requests that have left the browser, unanswered and not failed. */
    let namedInFlight = 0;
    /** Whether a response's request, or one it was redirected from, was held. */
    const wasHeld = (request: Request | null): boolean =>
      request !== null && (holding.has(request) || wasHeld(request.redirectedFrom()));

    async function handle(route: Route, request: Request): Promise<void> {
      try {
        const seen = seenOf(request);
        if (!readsByMethod(seen.method)) {
          const sent =
            findListed(settings.reads, seen, target) ??
            (environment === 'preview'
              ? findListed(settings.previewSafe, seen, target)
              : undefined);
          if (!sent) {
            const key = describe(seen, target);
            notSent.set(key, (notSent.get(key) ?? 0) + 1);
            const where = `probe.reads${environment === 'preview' ? ', probe.previewSafe' : ''}`;
            for (const spec of settings.requests.filter((s) => isListed(s, seen, target))) {
              const message = `${spec.name}: aborted, as ${key} is ${unlisted} (${where})`;
              problems.add(message);
              for (const wait of abortable) if (wait.spec === spec) wait.reject(new Error(message));
            }
            return await route.abort('blockedbyclient');
          }
        }
        if (!sameOrigin(seen.url, target)) return await route.continue();
        if (named && !releasing && isListed(named, seen, target)) namedInFlight += 1;
        else if (named && !releasing && SCRIPT_TYPES.has(request.resourceType())) {
          holding.add(request);
          await released;
        }
        await route.continue({
          headers: { ...request.headers(), ...addedHeaders(seen.url, target, settings.headers) },
        });
      } catch (error) {
        // A request still in flight as the context closes has nowhere to go.
        if (!closing) problems.add(`route: ${error instanceof Error ? error.message : error}`);
      }
    }

    try {
      if (!(await setBypassCookie(context))) return;
      await context.route('**/*', handle);
      context.on('response', (response) => {
        pending.push(noteCold(response).catch(() => {}));
      });
      const tab = await context.newPage();
      const waits = page.expect.map((name) => {
        const spec = requests.get(name) as RequestSpec;
        const aborted = new Promise<Response>((_, reject) => abortable.push({ spec, reject }));
        // The named request failing in the network (no response comes)
        // ends its wait at once, so the held requests go on: unless another
        // named request is still on its way (the page cancelled one of two),
        // whose answer ends it instead.
        const failed = new Promise<Response>((_, reject) => {
          if (spec !== named) return;
          tab.on('requestfailed', (request) => {
            if (!isListed(spec, seenOf(request), target)) return;
            namedInFlight -= 1;
            if (namedInFlight > 0) return;
            const reason = request.failure()?.errorText ?? 'no reason given';
            reject(new Error(`${spec.name}: failed: ${reason}`));
          });
        });
        const response = tab.waitForResponse((r) => isListed(spec, seenOf(r.request()), target), {
          timeout: limit,
        });
        return Promise.race([response, aborted, failed]).then(
          (r) => ({ spec, response: r, error: null }),
          (error: unknown) => ({ spec, response: null, error }),
        );
      });
      if (named) void waits[page.expect.indexOf(named.name)].then(release);
      try {
        await tab.goto(url.href, { waitUntil: 'load', timeout: limit });
      } catch (error) {
        problems.add(
          `${page.path}: didn't load: ${error instanceof Error ? error.message : error}`,
        );
        return;
      }
      for (const { spec, response, error } of await Promise.all(waits)) {
        if (response && wasHeld(response.request())) continue;
        if (response && spec === named) {
          const headers = await response.allHeaders();
          coldFirstWarm = !hasEntry(
            parseServerTiming(headers['server-timing'] ?? ''),
            settings.cold,
          );
        }
        if (response) await measure(spec, response, first);
        else if (error instanceof Error && error.message.startsWith(`${spec.name}: failed: `)) {
          problems.add(error.message);
        } else if ([...holding].some((request) => isListed(spec, seenOf(request), target)))
          continue;
        else if (!(error instanceof Error && error.message.startsWith(`${spec.name}: aborted`))) {
          problems.add(
            `${spec.name}: ${page.path} never made this request within ${settings.timeout}s`,
          );
        }
      }
      await Promise.all(pending);
    } finally {
      closing = true;
      held += holding.size;
      release();
      await context.close();
    }
  }

  for (const page of settings.pages) {
    for (let i = 0; i <= settings.repeats; i += 1) await load(page, i === 0);
  }

  const notes = [
    coldBy.size > 0
      ? `cold carried by: ${[...coldBy].join(', ')}`
      : `cold not seen this run: no response carried the cold flag (${settings.cold})`,
  ];
  if (coldFirstWarm) notes.push(`${settings.coldFirst} carried no cold flag on the first load`);
  if (held > 0) notes.push(`${held} held until ${settings.coldFirst}'s wait ended, left out`);
  for (const [key, n] of notSent)
    notes.push(`${count(n, 'request')} not sent: ${key}, ${unlisted}`);
  if (cached > 0) {
    notes.push(
      `${count(cached, 'cached response')} left out (Age above 0, or x-vercel-cache: HIT)`,
    );
  }
  if (untimed > 0) notes.push(`${count(untimed, 'response')} without the browser's own timing`);
  if (leftOut > 0) {
    notes.push(`${count(leftOut, 'response')} on the first load left out: not cold, not a repeat`);
  }
  return { measurements, notes, problems: [...problems] };
}
