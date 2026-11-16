// The GitHub REST calls the review's own code makes (skip.mjs, tools.mjs):
// reading a PR's commits, threads and comments, and posting the review's
// comments. Plain fetch with the token it's given, never `gh`: the job's
// token, which only this code holds, never the reviewer's process (sdk.mjs
// says why).

/**
 * @typedef {(url: string, init?: { method?: string, headers?: Record<string, string>, body?: string }) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown>, text: () => Promise<string>, headers: { get: (name: string) => string | null } }>} Fetch
 */

/**
 * @typedef {object} GitHub
 * @property {(path: string) => Promise<unknown>} get
 * @property {(path: string) => Promise<unknown[]>} list every page of a list
 * @property {(method: 'POST' | 'PATCH', path: string, body: unknown) => Promise<unknown>} send
 */

const API = 'https://api.github.com';

/**
 * A client for the REST API, with this token.
 *
 * @param {string} token
 * @param {Fetch} [fetchImpl]
 * @returns {GitHub}
 */
export function github(token, fetchImpl = /** @type {Fetch} */ (/** @type {unknown} */ (fetch))) {
  if (!token) throw new Error('no GitHub token');
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'jbhirsh-ci-review',
  };
  /**
   * @param {string} url
   * @param {string} [method]
   * @param {unknown} [body]
   */
  const call = async (url, method = 'GET', body = undefined) => {
    const res = await fetchImpl(url.startsWith('http') ? url : `${API}${url}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub ${method} ${url} failed: ${res.status} ${text.slice(0, 300)}`);
    }
    return res;
  };
  return {
    get: async (path) => (await call(path)).json(),
    list: async (path) => {
      /** @type {unknown[]} */
      const all = [];
      let url = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
      for (let page = 0; page < 30 && url; page++) {
        const res = await call(url);
        const items = await res.json();
        if (Array.isArray(items)) all.push(...items);
        url = nextLink(res.headers.get('link')) ?? '';
      }
      return all;
    },
    send: async (method, path, body) => (await call(path, method, body)).json(),
  };
}

/**
 * The `rel="next"` URL of a Link header, if any.
 *
 * @param {string | null} link
 * @returns {string | null}
 */
export function nextLink(link) {
  const m = /<([^>]+)>;\s*rel="next"/.exec(link ?? '');
  return m ? m[1] : null;
}
