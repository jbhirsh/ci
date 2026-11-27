// An app's settings for the probe: the `probe` key of its `.github/ci.json`
// (lib/app.mjs). With no key, the app doesn't use the probe. Read at the
// boundary: everything after trusts what parseSettings returns.
//
//   pages        the pages to load, at least one: { path, expect }, `path`
//                from the deployment's root ("/", with no query string),
//                `expect` the names of the requests (below) the page must
//                make, each once. Each is loaded
//                1 + `repeats` times, each time in a fresh browser context.
//   requests     the requests to time, at least one: { name, path, method,
//                operation }. `name` is the row's name in the results
//                ("games"); `path` the exact path, with no query string;
//                `method` (any when absent) and `operation`, the GraphQL
//                operation name (from the query string or the JSON body),
//                narrow it. A listed request the page doesn't make, or
//                answers with no `Server-Timing`, fails the probe.
//   reads        non-GET requests that only read, sent in both
//                environments: { method, path, operation }. Every other
//                non-GET, non-HEAD request to the deployment is aborted
//                before it leaves the browser, and noted.
//   previewSafe  writes safe to repeat on a preview, sent only there: the
//                same shape. Never sent to production.
//   cold         the `Server-Timing` entry that marks an instance's first
//                request ("cold"). Only a response carrying it gives cold
//                rows; nothing else is taken as cold.
//   repeats      the warm loads after the first (5, from 1 to 20). The
//                warm column is their median.
//   hosts        globs of the hosts the bypass secret may go to
//                (`*.vercel.app`; `*` within one label). None by default:
//                a secret given for a host none matches fails at once.
//   headers      non-secret headers added to the browser's requests to the
//                deployment's own origin, as a name-to-value map
//                ({ "x-synthetic": "probe" }). A request the deployment
//                redirects to another origin takes them along (Playwright
//                carries a route's headers along redirects), so they must
//                never be secret.
//   timeout      each wait's hang limit, in seconds (90, a cold start's
//                limit in BoardGames' smoke test). Only ever a hang limit:
//                the probe moves on when the event it waits for happens.

import { appSettings, SETTINGS_FILE } from '../lib/app.mjs';

export interface RequestSpec {
  name: string;
  path: string;
  method?: string;
  operation?: string;
}

export interface SendSpec {
  method: string;
  path: string;
  operation?: string;
}

export interface PageSpec {
  path: string;
  expect: string[];
}

export interface ProbeSettings {
  pages: PageSpec[];
  requests: RequestSpec[];
  reads: SendSpec[];
  previewSafe: SendSpec[];
  cold: string;
  repeats: number;
  hosts: string[];
  headers: Record<string, string>;
  /** Seconds. */
  timeout: number;
}

const KEYS = [
  'pages',
  'requests',
  'reads',
  'previewSafe',
  'cold',
  'repeats',
  'hosts',
  'headers',
  'timeout',
];

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const NAME = /^[A-Za-z0-9][\w-]*$/;
const METHOD = /^[A-Z]+$/;
const OPERATION = /^[_A-Za-z][_0-9A-Za-z]*$/;
/**
 * A path from the root, with no query string, fragment, space or
 * backslash, and not starting `//`: `//evil.example/` and `/\evil.example`
 * would resolve to another origin.
 */
const PATH = /^\/(?![/\\])[^\s?#\\]*$/;
/** A host glob: DNS characters and `*`. */
const HOST_GLOB = /^[A-Za-z0-9*]([A-Za-z0-9*.-]*[A-Za-z0-9*])?$/;
/** A header value: visible characters and spaces, nothing that ends a line. */
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (name: string) => (problem: string) =>
  new Error(`${SETTINGS_FILE}: probe${name ? `.${name}` : ''} ${problem}`);

function text(name: string, value: unknown, shape: RegExp, what: string): string {
  if (typeof value !== 'string' || !shape.test(value)) throw fail(name)(`must be ${what}`);
  return value;
}

function onlyKeys(name: string, item: Record<string, unknown>, keys: string[]): void {
  const unknown = Object.keys(item).find((key) => !keys.includes(key));
  if (unknown !== undefined)
    throw fail(name)(`has "${unknown}", which isn't one of ${keys.join(', ')}`);
}

/**
 * A list of objects, each read by `read`; at least one when `required`.
 */
function list<T>(
  name: string,
  value: unknown,
  required: boolean,
  read: (item: Record<string, unknown>, at: string) => T,
): T[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw fail(name)(`must be a list${required ? ' of at least one' : ''}`);
  }
  return value.map((item, i) => {
    const at = `${name}[${i}]`;
    if (!isObject(item)) throw fail(at)('must be an object');
    return read(item, at);
  });
}

function sendSpec(item: Record<string, unknown>, at: string): SendSpec {
  onlyKeys(at, item, ['method', 'path', 'operation']);
  const method = text(`${at}.method`, item.method, METHOD, 'an HTTP method in capitals');
  if (method === 'GET' || method === 'HEAD') {
    throw fail(`${at}.method`)('must not be GET or HEAD, which are always sent');
  }
  return {
    method,
    path: text(`${at}.path`, item.path, PATH, 'a path from the root, such as /api/graphql'),
    ...(item.operation === undefined
      ? {}
      : {
          operation: text(`${at}.operation`, item.operation, OPERATION, 'a GraphQL operation name'),
        }),
  };
}

/**
 * The probe's settings, checked: throws an Error naming the setting
 * (`.github/ci.json: probe.<setting> …`) at the first that's wrong. `raw`
 * is the `probe` key's value.
 */
export function parseSettings(raw: unknown): ProbeSettings {
  if (!isObject(raw)) throw new Error(`${SETTINGS_FILE}: probe must be an object`);
  onlyKeys('', raw, KEYS);

  const requests = list('requests', raw.requests, true, (item, at) => {
    onlyKeys(at, item, ['name', 'path', 'method', 'operation']);
    const spec: RequestSpec = {
      name: text(`${at}.name`, item.name, NAME, 'a name of letters, digits, _ and -'),
      path: text(`${at}.path`, item.path, PATH, 'a path from the root, such as /api/graphql'),
    };
    if (item.method !== undefined) {
      spec.method = text(`${at}.method`, item.method, METHOD, 'an HTTP method in capitals');
    }
    if (item.operation !== undefined) {
      spec.operation = text(
        `${at}.operation`,
        item.operation,
        OPERATION,
        'a GraphQL operation name',
      );
    }
    return spec;
  });
  const names = requests.map((r) => r.name);
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice !== undefined) throw fail('requests')(`names "${twice}" twice`);

  const pages = list('pages', raw.pages, true, (item, at) => {
    onlyKeys(at, item, ['path', 'expect']);
    const path = text(`${at}.path`, item.path, PATH, 'a path from the root, such as /');
    const expect = item.expect;
    if (
      !Array.isArray(expect) ||
      expect.length === 0 ||
      !expect.every((name) => typeof name === 'string' && names.includes(name))
    ) {
      throw fail(`${at}.expect`)('must list at least one name from probe.requests');
    }
    const again = expect.find((name, i) => expect.indexOf(name) !== i);
    if (again !== undefined) throw fail(`${at}.expect`)(`names "${again}" twice`);
    return { path, expect: expect as string[] };
  });

  const reads = list('reads', raw.reads, false, sendSpec);
  const previewSafe = list('previewSafe', raw.previewSafe, false, sendSpec);

  const cold =
    raw.cold === undefined ? 'cold' : text('cold', raw.cold, TOKEN, 'a Server-Timing entry name');

  let repeats = 5;
  if (raw.repeats !== undefined) {
    if (
      typeof raw.repeats !== 'number' ||
      !Number.isInteger(raw.repeats) ||
      raw.repeats < 1 ||
      raw.repeats > 20
    ) {
      throw fail('repeats')('must be a whole number from 1 to 20');
    }
    repeats = raw.repeats;
  }

  let hosts: string[] = [];
  if (raw.hosts !== undefined) {
    if (
      !Array.isArray(raw.hosts) ||
      !raw.hosts.every((h) => typeof h === 'string' && HOST_GLOB.test(h))
    ) {
      throw fail('hosts')('must be a list of host globs, such as *.vercel.app');
    }
    hosts = raw.hosts;
  }

  let headers: Record<string, string> = {};
  if (raw.headers !== undefined) {
    if (
      !isObject(raw.headers) ||
      !Object.entries(raw.headers).every(
        ([name, value]) =>
          TOKEN.test(name) && typeof value === 'string' && HEADER_VALUE.test(value),
      )
    ) {
      throw fail('headers')('must map header names to one-line values');
    }
    headers = raw.headers as Record<string, string>;
  }

  let timeout = 90;
  if (raw.timeout !== undefined) {
    if (
      typeof raw.timeout !== 'number' ||
      !Number.isFinite(raw.timeout) ||
      raw.timeout <= 0 ||
      raw.timeout > 600
    ) {
      throw fail('timeout')('must be a number of seconds above 0, at most 600');
    }
    timeout = raw.timeout;
  }

  return { pages, requests, reads, previewSafe, cold, repeats, hosts, headers, timeout };
}

/**
 * The app's probe settings, or null when its `.github/ci.json` has no
 * `probe` key.
 *
 */
export function loadSettings(root: string): ProbeSettings | null {
  const raw = appSettings(root).probe;
  return raw === undefined ? null : parseSettings(raw);
}
