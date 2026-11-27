// Serving a page a repo builds itself (the `gif.page` setting, settings.ts)
// to a recording, with no server: the recording's browser context routes a
// fixed origin, http://gif.test, to the files under the side's build folder
// (build.ts writes it), so a scenario's `path` and the page's own links work
// as they would on a site, nothing listens on a port, and nothing waits for
// a server to say it's up. `.test` is reserved (RFC 2606) and never
// registrable, so no browser knows it for HTTPS only (as it does `.page`,
// whose every name is preloaded for HSTS) and upgrades it before the route
// sees it.
//
// The page loads nothing from anywhere else, and the route makes sure of it:
// a request to any other origin is aborted. (A scenario's or setup module's
// own page.route still answers first: page routes win over the context's.)
//
// A request whose path resolves outside the folder, `..`, an encoded slash
// or a symlink included, gets a 404, as does one for a file that isn't
// there. A folder is its index.html, and one asked for without its trailing
// slash is a 301 to it, as `vite preview` answers, so the page's relative
// links resolve inside it.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright';

/** The origin the built page is served at. */
export const PAGE_ORIGIN = 'http://gif.test';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

/**
 * The content type a file is served with, by its extension.
 */
export function contentType(file: string) {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Where a path leads once every symlink on the way is followed, or null. */
function real(file: string) {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * The file under `dir` that a request's URL path names, resolved through
 * any symlinks, and whether the path named a folder (the file is then its
 * index.html); or null for one that isn't there, isn't a file, or resolves
 * anywhere outside `dir`.
 */
export function pageFile(dir: string, pathname: string): { file: string; folder: boolean } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const top = realpathSync(dir);
  const named = real(path.join(top, decoded));
  const folder = named !== null && statSync(named).isDirectory();
  const file = folder ? real(path.join(named, 'index.html')) : named;
  if (file === null || !statSync(file).isFile()) return null;
  const relative = path.relative(top, file);
  if (path.isAbsolute(relative) || relative.split(path.sep)[0] === '..') return null;
  return { file, folder };
}

/**
 * Routes PAGE_ORIGIN in `context` to the files under `dir`, and aborts every
 * request to any other origin.
 */
export async function routePage(context: BrowserContext, dir: string) {
  await context.route(
    () => true,
    (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== PAGE_ORIGIN) return route.abort('blockedbyclient');
      const found = pageFile(dir, url.pathname);
      if (!found) {
        return route.fulfill({
          status: 404,
          contentType: 'text/plain; charset=utf-8',
          body: 'Not found',
        });
      }
      if (found.folder && !url.pathname.endsWith('/')) {
        return route.fulfill({
          status: 301,
          headers: { location: `${url.pathname}/${url.search}` },
        });
      }
      return route.fulfill({
        status: 200,
        contentType: contentType(found.file),
        body: readFileSync(found.file),
      });
    },
  );
}
