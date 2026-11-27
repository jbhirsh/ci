// A fetch for tests of the code that calls GitHub (github.ts): it answers
// from a table of routes and records each call.

/**
 * A fetch that answers from a table of URL → [status, body, link header].
 *
 * @param {Record<string, [number, unknown, string?]>} routes
 * @param {{ url: string, method?: string, body?: string, headers?: Record<string, string> }[]} [calls]
 * @returns {import('./github.ts').Fetch}
 */
export function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, ...init });
    const key = `${init.method ?? 'GET'} ${url}`;
    const [status, body, link] = routes[key] ?? [404, { message: `no route ${key}` }];
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: (name) => (name === 'link' ? (link ?? null) : null) },
    };
  };
}
