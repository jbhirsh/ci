// The migration's plan, from the inventory, and the report the owner reads
// before anything is uploaded or edited (ci#33). Pure.
//
// Each picture is one blob: the same file at several commits, or under
// several names, goes up once, and two different files that share a name
// (every PR folder's `before.png`) go up apart. A picture is attachable if
// its extension is one GitHub takes and it's within the 10 MB GitHub
// attaches; any other is listed and not uploaded, and every link to it
// stays (so its branch can't be deleted until the owner decides).
//
// A post is rewritten if it has a link to an attachable picture and its
// author is the repository owner or a bot (posts.mjs's ownOrBot), or the
// run says to include others'. Every other post with a picture link is
// listed with its author.

import { ownOrBot } from './posts.mjs';

/** @typedef {import('./posts.mjs').Post} Post */
/** @typedef {import('./pictures.mjs').Resolved} Resolved */
/** @typedef {import('./pictures.mjs').BranchFile} BranchFile */
/** @typedef {import('./links.mjs').Link & Resolved} FoundLink */
/** @typedef {Post & { links: FoundLink[] }} LinkedPost */

/**
 * @typedef {object} Inventory
 * @property {string} repo the app, whose picture branch this is
 * @property {string} branch
 * @property {string} legacy the legacy picture branches' prefix (`pr-screenshots`)
 * @property {string} tip the branch's commit when read
 * @property {string[]} legacyBranches legacy picture branches still on GitHub
 * @property {string[]} repos the repositories whose posts were read
 * @property {Record<string, number>} scanned posts read, by repository
 * @property {LinkedPost[]} posts the posts with a link into picture history
 * @property {Record<string, number>} kept links left alone, by ref
 * @property {BranchFile[]} files the branch tip's files
 */

/** The largest picture GitHub attaches (its docs: 10 MB for images, and for videos on a free plan). */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;

/** The extensions GitHub takes as attachments that a picture branch holds. */
export const ATTACHABLE = ['png', 'gif', 'jpg', 'jpeg', 'svg', 'mp4', 'mov', 'webm'];

/**
 * @typedef {object} Picture
 * @property {string} blob
 * @property {number} size
 * @property {string} ext
 * @property {string[]} at where it was read (`<commit>:<path>`), each once
 * @property {string[]} posts the keys of the posts linking it
 * @property {'ok' | 'too-big' | 'not-a-picture'} attach
 */

/**
 * @typedef {object} Plan
 * @property {string} repo
 * @property {number | null} host the PR the pictures are attached to
 * @property {Picture[]} pictures sorted by blob
 * @property {string[]} rewrite keys of the posts to rewrite
 * @property {string[]} others keys of others' posts left alone
 * @property {boolean} includeOthers
 */

/**
 * A file's extension, lower case.
 *
 * @param {string} path
 */
export const extOf = (path) => /\.([\w]+)$/.exec(path)?.[1].toLowerCase() ?? '';

/**
 * @param {number} size
 * @param {string} ext
 * @returns {Picture['attach']}
 */
export function attachable(size, ext) {
  if (!ATTACHABLE.includes(ext)) return 'not-a-picture';
  return size > ATTACH_MAX_BYTES ? 'too-big' : 'ok';
}

/**
 * The plan for an inventory.
 *
 * @param {Inventory} inventory
 * @param {{ host?: number | null; includeOthers?: boolean }} [options]
 * @returns {Plan}
 */
export function makePlan(inventory, { host = null, includeOthers = false } = {}) {
  /** @type {Map<string, Picture>} */
  const pictures = new Map();
  for (const post of inventory.posts) {
    for (const link of post.links) {
      if (link.status !== 'migrate' || !link.blob) continue;
      let picture = pictures.get(link.blob);
      if (!picture) {
        const ext = extOf(link.path);
        const size = /** @type {number} */ (link.size);
        picture = { blob: link.blob, size, ext, at: [], posts: [], attach: attachable(size, ext) };
        pictures.set(link.blob, picture);
      }
      if (link.at && !picture.at.includes(link.at)) picture.at.push(link.at);
      if (!picture.posts.includes(post.key)) picture.posts.push(post.key);
    }
  }
  /** @type {string[]} */
  const rewrite = [];
  /** @type {string[]} */
  const others = [];
  for (const post of inventory.posts) {
    const movable = post.links.some(
      (link) =>
        link.status === 'migrate' &&
        pictures.get(/** @type {string} */ (link.blob))?.attach === 'ok',
    );
    if (!ownOrBot(post.author, post.repo)) others.push(post.key);
    if (movable && (includeOthers || ownOrBot(post.author, post.repo))) rewrite.push(post.key);
  }
  return {
    repo: inventory.repo,
    host,
    pictures: [...pictures.values()].sort((a, b) => a.blob.localeCompare(b.blob)),
    rewrite,
    others,
    includeOthers,
  };
}

/**
 * A size to read: KB under a megabyte, else MB.
 *
 * @param {number} bytes
 */
const mb = (bytes) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * A post as a markdown link, by where it is.
 *
 * @param {Post} post
 */
export function postLabel(post) {
  const what = {
    issue: 'body',
    'issue-comment': 'comment',
    'review-comment': 'review comment',
    review: 'review',
    'commit-comment': 'commit comment',
    release: 'release',
  }[post.kind];
  const where = post.kind === 'issue' ? `#${post.id}` : post.number ? `#${post.number}` : '';
  return `[${post.repo.split('/')[1]}${where} ${what}](${post.html})`;
}

/**
 * The report the owner reads before the upload: counts, then each list.
 *
 * @param {Inventory} inventory
 * @param {Plan} plan
 * @param {{ batch: number }} options batch: pictures attached a command
 */
export function planReport(inventory, plan, { batch }) {
  const byKey = new Map(inventory.posts.map((post) => [post.key, post]));
  const links = inventory.posts.flatMap((post) => post.links.map((link) => ({ post, link })));
  /** @param {FoundLink['status']} status */
  const count = (status) => links.filter(({ link }) => link.status === status).length;
  const ok = plan.pictures.filter((p) => p.attach === 'ok');
  const linkedBlobs = new Set(plan.pictures.map((p) => p.blob));
  const unlinked = inventory.files.filter((file) => !linkedBlobs.has(file.blob));
  const repaired = links.filter(({ link }) => link.repaired && link.status === 'migrate').length;
  const keptRefs = Object.entries(inventory.kept).sort((a, b) => b[1] - a[1]);
  const lines = [
    `## Picture migration plan: ${plan.repo}`,
    '',
    `The \`${inventory.branch}\` branch at \`${inventory.tip.slice(0, 12)}\` (${inventory.files.length} files, ${mb(inventory.files.reduce((n, f) => n + f.size, 0))}), and the posts of ${inventory.repos.map((r) => `\`${r}\``).join(', ')}. Nothing has been uploaded or edited.`,
    '',
    '| | |',
    '|---|---|',
    ...Object.entries(inventory.scanned).map(([repo, n]) => `| Posts read in ${repo} | ${n} |`),
    `| Posts linking picture history | ${inventory.posts.length} |`,
    `| Links to a picture file | ${count('migrate')}${repaired ? ` (${repaired} of them \`${inventory.legacy}/…\` links, broken today, which this repairs)` : ''} |`,
    `| Distinct pictures to upload | ${ok.length} (${mb(ok.reduce((n, p) => n + p.size, 0))}), in ${Math.ceil(ok.length / batch)} attach command(s) of up to ${batch} |`,
    `| Pictures not uploaded (too big, or not a picture) | ${plan.pictures.length - ok.length} |`,
    `| Folder and commit links (your call) | ${count('listed')} |`,
    `| Links whose file can't be found | ${count('unresolved')} |`,
    `| Links left alone (main's, PR heads' and other commits) | ${keptRefs.reduce((n, [, c]) => n + c, 0)} |`,
    `| Posts to rewrite | ${plan.rewrite.length} |`,
    `| Others' posts with picture links${plan.includeOthers ? ' (rewritten: include-others)' : ' (left alone)'} | ${plan.others.length} |`,
    `| Branch files no post links (kept only in the bundle) | ${unlinked.length} |`,
    `| Legacy picture branches still on GitHub | ${inventory.legacyBranches.length ? inventory.legacyBranches.join(', ') : 'none'} |`,
    '',
    `Attached to: ${plan.host ? `#${plan.host}'s description, rewritten each batch` : 'the PR passed as `host-pr` to the upload step'}.`,
  ];
  /**
   * @param {string} title
   * @param {string[]} rows
   */
  const section = (title, rows) => {
    if (rows.length === 0) return;
    lines.push(
      '',
      `<details><summary>${title} (${rows.length})</summary>`,
      '',
      ...rows,
      '',
      '</details>',
    );
  };
  section(
    'Not uploaded: every link to these stays',
    plan.pictures
      .filter((p) => p.attach !== 'ok')
      .map(
        (p) =>
          `- \`${p.at[0]}\`: ${p.attach === 'too-big' ? `${mb(p.size)}, over GitHub's 10 MB` : `.${p.ext} isn't a picture GitHub attaches`}`,
      ),
  );
  section(
    "Folder and commit links: drop each, or point it at its post's pictures, by hand",
    links
      .filter(({ link }) => link.status === 'listed')
      .map(({ post, link }) => `- ${postLabel(post)}: \`${link.url}\``),
  );
  section(
    "Links whose file can't be found: left as they are",
    links
      .filter(({ link }) => link.status === 'unresolved')
      .map(({ post, link }) => `- ${postLabel(post)}: \`${link.url}\``),
  );
  section(
    plan.includeOthers
      ? "Others' posts, rewritten as asked"
      : "Others' posts, left alone (rerun the plan with include-others to rewrite them)",
    plan.others.map((key) => {
      const post = /** @type {LinkedPost} */ (byKey.get(key));
      return `- ${postLabel(post)} by \`${post.author}\`: ${post.links.length} link(s)`;
    }),
  );
  section(
    'Refs left alone, with their links',
    keptRefs.map(([ref, n]) => `- \`${ref}\`: ${n}`),
  );
  section(
    'Each picture, its batch, and the posts that change',
    ok.map((p, i) => {
      const posts = p.posts.map((key) => postLabel(/** @type {LinkedPost} */ (byKey.get(key))));
      return `- \`${p.at[0]}\` (${mb(p.size)}${p.at.length > 1 ? `, also ${p.at.length - 1} other place(s)` : ''}) → batch ${Math.floor(i / batch) + 1} → ${posts.join(', ')}`;
    }),
  );
  section(
    'Each post to rewrite, and how many links in it change',
    plan.rewrite.map((key) => {
      const post = /** @type {LinkedPost} */ (byKey.get(key));
      const n = post.links.filter((l) => l.status === 'migrate').length;
      return `- ${postLabel(post)} by \`${post.author}\`: ${n}`;
    }),
  );
  return `${lines.join('\n')}\n`;
}
