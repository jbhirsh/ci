// Which listed request a browser request is, and what may go with it. Pure:
// the driver (web/drive.ts) hands over each request's URL, method and body
// as the browser has them, which is outside input, so nothing here throws.
//
// A request matches a listed one when it goes to the deployment's own
// origin, its path is the listed path exactly (no query string), its
// method is the listed one (any method when none is listed), and, when one
// is listed, its GraphQL operation name is the listed one. The operation
// name is read as a GraphQL server reads it: the `operationName` parameter
// (in the query string for a GET, the JSON body for a POST), or else the
// name of the one operation in the document (`query`).
//
// The app's headers go only to the deployment's origin: the same scheme,
// host and port, compared as the URL standard writes them, so
// `https://app.example:443` is the deployment's and
// `https://app.example.evil` or `http://app.example` is not. No browser
// request carries the bypass secret at all (web/drive.ts sets Vercel's
// bypass cookie instead).

/** A request as the settings list it. */
export interface Listed {
  path: string;
  method?: string;
  operation?: string;
}

/** A request as the browser makes it. */
export interface Seen {
  url: string;
  method: string;
  body: string | null;
}

/** The URL, or null when it isn't one. */
function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Whether `url` is on the deployment's own origin (scheme, host and port):
 * `target` is the deployment's URL.
 */
export function sameOrigin(url: string, target: string): boolean {
  const a = parse(url);
  const b = parse(target);
  return a !== null && b !== null && a.origin !== 'null' && a.origin === b.origin;
}

/** The first operation's name in a GraphQL document, if it names one. */
const OPERATION = /\b(?:query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/;

/** The GraphQL operation name a request asks for, or null. */
export function operationOf(url: string, body: string | null): string | null {
  let name: unknown;
  let query: unknown;
  const params = parse(url)?.searchParams;
  if (params?.has('operationName') || params?.has('query')) {
    name = params.get('operationName');
    query = params.get('query');
  } else if (body) {
    try {
      const json: unknown = JSON.parse(body);
      if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
        name = (json as Record<string, unknown>).operationName;
        query = (json as Record<string, unknown>).query;
      }
    } catch {
      return null;
    }
  }
  if (typeof name === 'string' && name !== '') return name;
  if (typeof query === 'string') return OPERATION.exec(query)?.[1] ?? null;
  return null;
}

/** Whether a request is the listed one, on the deployment at `target`. */
export function isListed(listed: Listed, seen: Seen, target: string): boolean {
  if (!sameOrigin(seen.url, target)) return false;
  if (listed.method !== undefined && listed.method !== seen.method.toUpperCase()) return false;
  if (parse(seen.url)?.pathname !== listed.path) return false;
  return listed.operation === undefined || operationOf(seen.url, seen.body) === listed.operation;
}

/** The first of `list` the request is, or undefined. */
export function findListed<T extends Listed>(list: T[], seen: Seen, target: string): T | undefined {
  return list.find((listed) => isListed(listed, seen, target));
}

/** Whether a request only reads by its method: GET and HEAD always go out. */
export const readsByMethod = (method: string): boolean =>
  ['GET', 'HEAD'].includes(method.toUpperCase());

/**
 * The headers to add to a request: the app's, only on the deployment's own
 * origin; none anywhere else.
 */
export function addedHeaders(
  url: string,
  target: string,
  headers: Record<string, string>,
): Record<string, string> {
  return sameOrigin(url, target) ? { ...headers } : {};
}

/**
 * Whether a host matches a glob of `hosts`: `*` stands for one or more
 * characters within one label (`*.vercel.app` matches `a.vercel.app`, not
 * `a.b.vercel.app` or `vercel.app`). Case is ignored, as DNS ignores it.
 * `host` is a hostname, with no port.
 */
export function hostMatches(host: string, glob: string): boolean {
  const pattern = glob
    .toLowerCase()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^.]+');
  return new RegExp(`^${pattern}$`).test(host.toLowerCase());
}
