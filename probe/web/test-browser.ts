// A stand-in browser for drive.ts's and run.ts's tests: just enough of
// Playwright's Browser, BrowserContext, Page, Route, Request and Response
// for the driver, with a made-up app answering each request. Not part of
// any tool. A page's goto makes the navigation request and then the
// requests the test says the page makes, each through the context's route
// handler; a waitForResponse nothing answered fails once goto is done, as
// the real one does at its hang limit. The context's API client
// (context.request) answers with `bypass`'s status (and headers, when it
// has them), or throws its message.

import type { Browser } from 'playwright';

/** How the fake deployment answers the bypass request: a status, a status with headers, or an error's message. */
export type Bypass = number | string | { status: number; headers: Record<string, string> };

/** A request the page makes. */
export interface Sent {
  url: string;
  method?: string;
  body?: string | null;
}

/** What the made-up app answers. */
export interface Answer {
  status?: number;
  headers?: Record<string, string>;
  timing?: { requestStart: number; responseStart: number; responseEnd: number };
}

/** A request that left the browser. */
export interface Hit {
  url: string;
  method: string;
  headers: Record<string, string>;
}

interface FakeRequest {
  url: () => string;
  method: () => string;
  postData: () => string | null;
  headers: () => Record<string, string>;
  timing: () => Record<string, number>;
}

interface FakeResponse {
  request: () => FakeRequest;
  status: () => number;
  allHeaders: () => Promise<Record<string, string>>;
  finished: () => Promise<null>;
}

interface FakeRoute {
  continue: (overrides?: { headers?: Record<string, string> }) => Promise<void>;
  abort: () => Promise<void>;
}

type Handler = (route: FakeRoute, request: FakeRequest) => Promise<void>;

interface Waiter {
  predicate: (response: FakeResponse) => boolean;
  resolve: (response: FakeResponse) => void;
  reject: (error: Error) => void;
}

export function testBrowser({
  page,
  answer,
  gotoFails,
  bypass = 200,
}: {
  page: (url: string, load: number) => Sent[];
  answer: (request: Sent & { method: string }, load: number) => Answer;
  gotoFails?: string;
  bypass?: Bypass;
}) {
  const seen: Hit[] = [];
  const aborted: string[] = [];
  const contexts: unknown[] = [];
  const setups: { url: string; options: unknown }[] = [];
  let loads = 0;
  let closed = false;

  const browser = {
    close: async () => {
      closed = true;
    },
    newContext: async (options: unknown) => {
      contexts.push(options);
      const load = loads;
      loads += 1;
      let handler: Handler | undefined;
      const listeners: ((response: FakeResponse) => void)[] = [];
      let waiters: Waiter[] = [];

      async function send(sent: Sent) {
        const method = sent.method ?? 'GET';
        const body = sent.body ?? null;
        const answered = answer({ ...sent, method, body }, load);
        const timing = answered.timing ?? { requestStart: 1, responseStart: 5, responseEnd: 9 };
        const request: FakeRequest = {
          url: () => sent.url,
          method: () => method,
          postData: () => body,
          headers: () => ({ accept: '*/*' }),
          timing: () => ({ startTime: 0, ...timing }),
        };
        let fate: 'sent' | 'aborted' | null = null;
        let headers = request.headers();
        const route: FakeRoute = {
          continue: async (overrides) => {
            fate = 'sent';
            if (overrides?.headers) headers = overrides.headers;
          },
          abort: async () => {
            fate = 'aborted';
          },
        };
        if (!handler) throw new Error('no route handler');
        await handler(route, request);
        if (fate === 'aborted') {
          aborted.push(`${method} ${sent.url}`);
          return;
        }
        seen.push({ url: sent.url, method, headers });
        const response: FakeResponse = {
          request: () => request,
          status: () => answered.status ?? 200,
          allHeaders: async () => answered.headers ?? {},
          finished: async () => null,
        };
        for (const listener of listeners) listener(response);
        waiters = waiters.filter((w) => {
          if (!w.predicate(response)) return true;
          w.resolve(response);
          return false;
        });
      }

      return {
        request: {
          get: async (url: string, options: unknown) => {
            setups.push({ url, options });
            if (typeof bypass === 'string') throw new Error(bypass);
            const { status, headers } =
              typeof bypass === 'number' ? { status: bypass, headers: {} } : bypass;
            return {
              status: () => status,
              headers: () => headers,
              headersArray: () => Object.entries(headers).map(([name, value]) => ({ name, value })),
              dispose: async () => {},
            };
          },
        },
        route: async (_pattern: string, h: Handler) => {
          handler = h;
        },
        on: (_event: string, listener: (response: FakeResponse) => void) =>
          listeners.push(listener),
        close: async () => {},
        newPage: async () => ({
          waitForResponse: (
            predicate: (response: FakeResponse) => boolean,
            options: { timeout: number },
          ) =>
            new Promise((resolve, reject) => {
              waiters.push({
                predicate,
                resolve,
                reject: () => reject(new Error(`Timeout ${options.timeout}ms exceeded`)),
              });
            }),
          goto: async (url: string) => {
            if (gotoFails) throw new Error(gotoFails);
            await send({ url });
            for (const sent of page(url, load)) await send(sent);
            for (const w of waiters) w.reject(new Error('hang limit'));
            waiters = [];
          },
        }),
      };
    },
  };
  return {
    browser: browser as unknown as Browser,
    seen,
    aborted,
    contexts,
    setups,
    isClosed: () => closed,
  };
}
