// The review's guard (sdk.ts runs it as a PreToolUse and PostToolUse
// hook): every tool call the reviewer makes passes through it before it
// runs, whatever the permission mode or any settings file says, since
// hooks run ahead of every other permission check. It allows:
//   - the in-process tools (tools.ts), which check their own inputs;
//   - Read, Grep and Glob only inside the allowed roots: the PR's checkout,
//     this repo's tree (SHARED_CI) and the folder the SDK saves long tool
//     output to. Paths are resolved, symlinks included, so a link in the PR
//     pointing at /proc/self/environ or ~/.ssh reads nothing;
//   - WebSearch up to a cap per pass, and WebFetch only for a URL the
//     reviewer has already been shown: in a search result, the PR's text
//     or threads (the pr tool), or the diff. A page can't send it to an
//     address of its own making, carrying data in the URL;
//   - ToolSearch, which only loads tools' descriptions.
// Everything else is refused, Bash and Edit included.

import { realpathSync } from 'node:fs';
import path from 'node:path';

/** The in-process tools' names (sdk.ts's two MCP servers). */
const OWN_TOOLS = /^mcp__(review__[a-z_]+|github_inline_comment__create_inline_comment)$/;
/** Tools whose output may hold URLs the reviewer may then open. */
const URL_SOURCES = /^(WebSearch|mcp__review__(pr|diff))$/;
const URL = /https?:\/\/[^\s"'<>()[\]{}`\\]+/g;

export type Decision = { allow: true } | { allow: false; reason: string };

/**
 * A path made absolute and resolved through any symlinks, as far as it
 * exists (a file that isn't there yet resolves by its folder).
 */
export function resolved(file: string, cwd: string): string {
  const absolute = path.resolve(cwd, file);
  let probe = absolute;
  const rest = [];
  for (;;) {
    try {
      return path.join(realpathSync(probe), ...rest);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return absolute;
      rest.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * @param file
 * @param roots resolved already
 */
function inside(file: string, roots: string[]): boolean {
  return roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`));
}

/**
 * A URL as compared: no fragment, no trailing slash.
 */
export function normalUrl(url: string): string {
  return url
    .replace(/#.*$/, '')
    .replace(/[.,;:!?]+$/, '')
    .replace(/\/+$/, '');
}

export function createGuard({
  roots,
  cwd,
  maxSearches = 5,
}: {
  roots: string[];
  cwd: string;
  maxSearches?: number;
}) {
  const allowedRoots = roots.map((r) => resolved(r, cwd));
  const seen: Set<string> = new Set();
  let searches = 0;

  const pathAllowed = (value: unknown): Decision => {
    if (value === undefined) return { allow: true };
    if (typeof value !== 'string' || value === '') return { allow: false, reason: 'not a path' };
    return inside(resolved(value, cwd), allowedRoots)
      ? { allow: true }
      : { allow: false, reason: `${value} is outside the checkout and this repo's tree` };
  };

  /**
   * Whether this tool call may run.
   */
  const before = (tool: string, input: unknown): Decision => {
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (OWN_TOOLS.test(tool) || tool === 'ToolSearch') return { allow: true };
    if (tool === 'Read') {
      return args.file_path === undefined
        ? { allow: false, reason: 'not a path' }
        : pathAllowed(args.file_path);
    }
    if (tool === 'Grep') return pathAllowed(args.path);
    if (tool === 'Glob') {
      const where = pathAllowed(args.path);
      if (!where.allow) return where;
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      // An absolute pattern, or one climbing out, names its own folder.
      // `..` anywhere, braces included (`{..,x}/f`), would climb out.
      if (path.isAbsolute(pattern) || pattern.includes('..')) {
        return { allow: false, reason: 'a Glob pattern stays inside its folder' };
      }
      return { allow: true };
    }
    if (tool === 'WebSearch') {
      if (searches >= maxSearches)
        return { allow: false, reason: `at most ${maxSearches} searches a pass` };
      searches += 1;
      return { allow: true };
    }
    if (tool === 'WebFetch') {
      const url = typeof args.url === 'string' ? args.url : '';
      if (!/^https?:\/\//.test(url)) return { allow: false, reason: 'only http(s) URLs' };
      return seen.has(normalUrl(url))
        ? { allow: true }
        : {
            allow: false,
            reason: 'open only a URL from a search result, the PR (the pr tool) or the diff',
          };
    }
    return { allow: false, reason: `${tool} is not one of the review's tools` };
  };

  /**
   * Notes the URLs a tool's output showed, which WebFetch may then open.
   */
  const after = (tool: string, response: unknown) => {
    if (!URL_SOURCES.test(tool)) return;
    const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
    for (const match of text.matchAll(URL)) seen.add(normalUrl(match[0]));
  };

  return { before, after };
}
