// Every text in a repository that can link a picture, read through the
// REST API (never search, which matches words and misses comments), and
// how to read one again and edit it (ci#33's migration):
//
//   issue           PR and issue bodies             issues?state=all
//   issue-comment   every conversation comment,     issues/comments
//                   job reports and bots' included
//   review-comment  review comments on a diff       pulls/comments
//   review          review bodies (Claude Review)   pulls/<n>/reviews, per PR
//   commit-comment  comments on commits             comments
//   release         release notes                   releases
//
// A post's author decides whether the migration edits it: the repository
// owner's and bots' (`…[bot]`) posts are edited; anyone else's are listed
// in the plan and left alone unless the run says otherwise.

/**
 * @typedef {'issue' | 'issue-comment' | 'review-comment' | 'review' | 'commit-comment' | 'release'} Kind
 */

/**
 * @typedef {object} Post
 * @property {string} key unique and safe as a file name: `<owner>__<repo>__<kind>-<id>`
 * @property {string} repo owner/name
 * @property {Kind} kind
 * @property {number} id the issue's or PR's number for an issue, else the comment's, review's or release's id
 * @property {number | null} number the PR a review belongs to, which its endpoint needs
 * @property {string} html where to read it on GitHub
 * @property {string} author its author's login
 * @property {string} updatedAt
 * @property {string} body
 */

/** @typedef {import('./github.mjs').Client} Client */

/**
 * @param {string} repo
 * @param {Kind} kind
 * @param {number} id
 */
export const postKey = (repo, kind, id) => `${repo.replace('/', '__')}__${kind}-${id}`;

/**
 * A post from an API item.
 *
 * @param {string} repo
 * @param {Kind} kind
 * @param {Record<string, unknown>} item
 * @param {number | null} [number]
 * @returns {Post}
 */
export function toPost(repo, kind, item, number = null) {
  const id = /** @type {number} */ (kind === 'issue' ? item.number : item.id);
  const user = /** @type {{ login?: string } | null} */ (item.user ?? item.author);
  return {
    key: postKey(repo, kind, id),
    repo,
    kind,
    id,
    number,
    html: String(item.html_url ?? ''),
    author: user?.login ?? '',
    updatedAt: String(item.updated_at ?? item.submitted_at ?? item.published_at ?? ''),
    body: typeof item.body === 'string' ? item.body : '',
  };
}

/**
 * The endpoint that reads and edits one post.
 *
 * @param {Pick<Post, 'repo' | 'kind' | 'id' | 'number'>} post
 * @returns {{ path: string; method: 'PATCH' | 'PUT' }}
 */
export function endpoint({ repo, kind, id, number }) {
  const at = `repos/${repo}`;
  switch (kind) {
    case 'issue':
      return { path: `${at}/issues/${id}`, method: 'PATCH' };
    case 'issue-comment':
      return { path: `${at}/issues/comments/${id}`, method: 'PATCH' };
    case 'review-comment':
      return { path: `${at}/pulls/comments/${id}`, method: 'PATCH' };
    case 'review':
      return { path: `${at}/pulls/${number}/reviews/${id}`, method: 'PUT' };
    case 'commit-comment':
      return { path: `${at}/comments/${id}`, method: 'PATCH' };
    case 'release':
      return { path: `${at}/releases/${id}`, method: 'PATCH' };
  }
}

/**
 * Every post in a repository that has a body.
 *
 * @param {Client} api
 * @param {string} repo
 * @param {(line: string) => void} [log]
 * @returns {Promise<Post[]>}
 */
export async function listPosts(api, repo, log = console.log) {
  const at = `repos/${repo}`;
  // Oldest first, so a post added while the pages are read lands on the
  // last page rather than shifting every page after it.
  const issues = await api.list(`${at}/issues?state=all&sort=created&direction=asc`);
  /** @type {Post[]} */
  const posts = issues.map((item) => toPost(repo, 'issue', item));
  /** @type {[Kind, string][]} */
  const lists = [
    ['issue-comment', `${at}/issues/comments?sort=created&direction=asc`],
    ['review-comment', `${at}/pulls/comments?sort=created&direction=asc`],
    ['commit-comment', `${at}/comments`],
    ['release', `${at}/releases`],
  ];
  for (const [kind, path] of lists) {
    for (const item of await api.list(path)) posts.push(toPost(repo, kind, item));
  }
  const prs = issues.filter((item) => item.pull_request).map((item) => Number(item.number));
  for (const pr of prs) {
    for (const item of await api.list(`${at}/pulls/${pr}/reviews`)) {
      posts.push(toPost(repo, 'review', item, pr));
    }
  }
  const withText = posts.filter((post) => post.body !== '');
  log(
    `${repo}: ${withText.length} posts with text, from ${issues.length} issues and PRs, their comments and ${prs.length} PRs' reviews`,
  );
  return withText;
}

/**
 * Reads one post as it is now.
 *
 * @param {Client} api
 * @param {Post} post
 * @returns {Promise<Post>}
 */
export async function readPost(api, post) {
  const item = /** @type {Record<string, unknown>} */ (await api.get(endpoint(post).path));
  return toPost(post.repo, post.kind, item, post.number);
}

/**
 * Replaces one post's body; returns the post as GitHub then holds it.
 *
 * @param {Client} api
 * @param {Post} post
 * @param {string} body
 * @returns {Promise<Post>}
 */
export async function editPost(api, post, body) {
  const { path, method } = endpoint(post);
  const item = /** @type {Record<string, unknown>} */ (await api.write(method, path, { body }));
  return toPost(post.repo, post.kind, item, post.number);
}

/**
 * Whether the migration edits a post by this author in this repository
 * without being told to: the repository owner's and bots'.
 *
 * @param {string} author
 * @param {string} repo
 */
export function ownOrBot(author, repo) {
  return author.toLowerCase() === repo.split('/')[0].toLowerCase() || author.endsWith('[bot]');
}
