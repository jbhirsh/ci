// Finding and rewriting the links into an app's repository in a post's
// text (ci#33's migration of old pictures). Pure: no network, no git.
//
// A link is any http(s) URL, anywhere in the text (markdown, `<img src>`, a
// bare link, a reference definition, a code span), of one of these forms:
//
//   https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
//   https://github.com/<owner>/<repo>/(blob|raw|tree)/<ref>/<path>
//   https://github.com/<owner>/<repo>/commit/<sha>
//
// with the owner and repo matched without case (BoardGames and boardgames
// both occur), `refs/heads/` before the ref, and a query (`?raw=true`) or
// fragment after the path. A URL ends at a space, a quote, a bracket, `<`,
// `>`, a backtick or a table's `|`, and trailing sentence punctuation isn't
// part of it.
//
// A ref with a slash is ambiguous in a raw URL, so it's read as the
// picture branch (`screenshots/<path>`), a legacy picture branch
// (`pr-screenshots/<topic>/<path>`), a hex SHA, or else a one-segment
// branch name (`main`). Whether a ref is on the picture branch is git's to
// say (pictures.mjs); here a link only says what it names.
//
// Template placeholders aren't links and are left as written: a ref or
// path holding `<`, `>`, `{`, `}` or `…` (`<sha>`, `<PR number>`), which the
// PR templates' example tables hold, even inside an HTML comment.
//
// rewriteText replaces only whole links, found by the same scan, so a URL
// that is a prefix of another is never half-replaced, and text outside the
// links is never touched. An attachment URL isn't a link into the repo, so
// a second rewrite changes nothing.

/**
 * @typedef {object} Link
 * @property {string} url the URL exactly as the text holds it
 * @property {'raw' | 'blob' | 'tree' | 'commit'} form
 * @property {string} ref a branch name (`screenshots`, `pr-screenshots/<topic>`, `main`) or a SHA
 * @property {string} path the file or folder in the ref, %-decoded ('' for a commit, or a tree's root)
 */

/** @param {string} text */
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The scan for links into one repository.
 *
 * @param {string} repo owner/name
 */
function linkPattern(repo) {
  const [owner, name] = repo.split('/').map(escape);
  return new RegExp(
    `https?://(?:raw\\.githubusercontent\\.com/${owner}/${name}/|github\\.com/${owner}/${name}/(?:blob|raw|tree|commit)/)[^\\s()<>"'\\[\\]\`|]+`,
    'gi',
  );
}

const TRAILING = /[.,;:!?*_~]+$/;
const PLACEHOLDER = /[<>{}…]/;
const HEX = /^[0-9a-f]{7,40}$/i;

/**
 * %-decodes one path, keeping a malformed escape as written.
 *
 * @param {string} text
 */
function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * What one URL names, or null for a placeholder or a URL with no ref.
 *
 * @param {string} url a match of linkPattern
 * @param {{ branch: string; legacy: string }} names the picture branch and the legacy branches' prefix (`pr-screenshots`)
 * @returns {Link | null}
 */
export function parseLink(url, { branch, legacy }) {
  const bare = url.replace(/[?#].*$/, '');
  const raw = /^https?:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/(.*)$/i.exec(bare);
  const page = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/(blob|raw|tree|commit)\/(.*)$/i.exec(bare);
  const form = /** @type {Link['form']} */ (raw ? 'raw' : /** @type {string[]} */ (page)[1]);
  let rest = raw ? raw[1] : /** @type {string[]} */ (page)[2];
  if (PLACEHOLDER.test(decode(rest))) return null;
  if (form === 'commit') {
    const sha = rest.replace(/\/$/, '');
    return HEX.test(sha) ? { url, form, ref: sha.toLowerCase(), path: '' } : null;
  }
  rest = rest.replace(/^refs\/heads\//, '');
  const parts = rest.split('/');
  let take = 1;
  if (parts[0] === legacy && parts.length > 1) take = 2;
  const ref = parts.slice(0, take).join('/');
  const path = decode(parts.slice(take).join('/').replace(/\/$/, ''));
  if (!/^[\w.-]+(?:\/[\w.-]+)?$/.test(ref)) return null;
  if (form !== 'tree' && path === '') return null;
  return { url, form, ref: HEX.test(ref) && ref !== branch ? ref.toLowerCase() : ref, path };
}

/**
 * Every link into `repo` in the text, in order, repeats included.
 *
 * @param {string} text
 * @param {string} repo owner/name
 * @param {{ branch: string; legacy: string }} names
 * @returns {Link[]}
 */
export function findLinks(text, repo, names) {
  /** @type {Link[]} */
  const found = [];
  for (const match of text.matchAll(linkPattern(repo))) {
    const link = parseLink(match[0].replace(TRAILING, ''), names);
    if (link) found.push(link);
  }
  return found;
}

/**
 * The text with each link into `repo` that `replace` gives a new URL for
 * swapped for it, and nothing else changed.
 *
 * @param {string} text
 * @param {string} repo owner/name
 * @param {(url: string) => string | undefined} replace the new URL for a link's exact text, or undefined to keep it
 */
export function rewriteText(text, repo, replace) {
  return text.replace(linkPattern(repo), (match) => {
    const tail = TRAILING.exec(match)?.[0] ?? '';
    const url = match.slice(0, match.length - tail.length);
    return (replace(url) ?? url) + tail;
  });
}
