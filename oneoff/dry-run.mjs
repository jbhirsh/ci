// One-off (ci#144, the cleanup's step 2: the dry run), on this throwaway
// branch only: never on main. It deletes and edits nothing. In one repo it
// lists every upload comment describe's parseUpload counts (BOT_PR_TOKEN's
// account, the marker, a section linking only attachments and commits), on
// PRs (open, closed, merged) and mockup issues, hidden ones included; lists
// every other comment that mentions the marker as "not touched", with why;
// searches each picture's asset id in every issue and PR body and every
// comment in the repo (issue, review, review-body and commit comments); and
// fetches each picture signed out. Everything goes to OUT for the artifact:
// each picture's bytes, each comment's body, id and URL, where each id is
// linked, and a copy of each description that links one (or owns a comment).
//
//   REPO=owner/name GH_TOKEN=<Actions token> LOGIN=<BOT_PR_TOKEN's login> OUT=dir node oneoff/dry-run.mjs

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseUpload, SECTION } from '../describe/describe.mjs';

const REPO = /** @type {string} */ (process.env.REPO);
const TOKEN = /** @type {string} */ (process.env.GH_TOKEN);
const LOGIN = /** @type {string} */ (process.env.LOGIN);
const OUT = /** @type {string} */ (process.env.OUT);
if (!REPO || !TOKEN || !LOGIN || !OUT) throw new Error('REPO, GH_TOKEN, LOGIN and OUT are all needed');

const API = 'https://api.github.com';
const headers = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
};

/**
 * Every page of a REST list.
 *
 * @param {string} route
 * @returns {Promise<any[]>}
 */
async function all(route) {
  /** @type {any[]} */
  const items = [];
  /** @type {string | null} */
  let url = `${API}/${route}${route.includes('?') ? '&' : '?'}per_page=100`;
  while (url) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${await res.text()}`);
    items.push(...(await res.json()));
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
  }
  return items;
}

/**
 * @param {string} query
 * @param {Record<string, unknown>} variables
 */
async function graphql(query, variables) {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GraphQL: ${res.status} ${JSON.stringify(json.errors ?? json)}`);
  return json.data;
}

const ID = /user-attachments\/assets\/([0-9a-f][0-9a-f-]{7,63})/g;
const idsIn = (/** @type {string} */ text) => [...new Set([...text.matchAll(ID)].map((m) => m[1]))];
const MARK = 'describe-upload';

/**
 * Why a comment that mentions the marker isn't one parseUpload counts.
 *
 * @param {any} c
 */
function whyNot(c) {
  const body = String(c.body ?? '');
  if (!body.startsWith(`<!-- ${MARK}:`)) return "mentions the marker but doesn't start with it";
  if (c.user?.login !== LOGIN) return `written by ${c.user?.login}, not BOT_PR_TOKEN's account (${LOGIN})`;
  if (!/^<!-- describe-upload:([a-z][a-z0-9-]{0,39}):([0-9a-f]{40}) -->/.test(body)) return 'its marker names no bot and full commit';
  if (!body.includes(SECTION)) return 'no `<!-- describe-section -->`';
  return 'its section holds a describe marker, or a link other than attachments and commits';
}

mkdirSync(path.join(OUT, 'pictures'), { recursive: true });
mkdirSync(path.join(OUT, 'comments'), { recursive: true });
mkdirSync(path.join(OUT, 'descriptions'), { recursive: true });

console.log(`${REPO}: reading issues and PRs`);
const issues = await all(`repos/${REPO}/issues?state=all`);
/** @type {Map<number, any>} */
const byNumber = new Map(issues.map((i) => [i.number, i]));
console.log(`${issues.length} issues and PRs; reading comments`);
const comments = await all(`repos/${REPO}/issues/comments`);
const reviewComments = await all(`repos/${REPO}/pulls/comments`);
const commitComments = await all(`repos/${REPO}/comments`);
/** @type {any[]} */
const reviews = [];
for (const i of issues.filter((x) => x.pull_request)) {
  for (const r of await all(`repos/${REPO}/pulls/${i.number}/reviews`)) {
    if (r.body) reviews.push({ ...r, number: i.number });
  }
}
console.log(
  `${comments.length} issue comments, ${reviewComments.length} review comments, ${reviews.length} review bodies, ${commitComments.length} commit comments`,
);

const numberOf = (/** @type {any} */ c) => Number(String(c.issue_url).split('/').pop());
/** @param {any} i */
const kindOf = (i) =>
  i.pull_request
    ? `PR, ${i.pull_request.merged_at ? 'merged' : i.state === 'open' ? 'open' : 'closed unmerged'}`
    : `issue (${i.state})`;

const mentions = comments.filter((c) => String(c.body ?? '').includes(MARK));
/** @type {Map<string, { isMinimized: boolean, minimizedReason: string | null }>} */
const hidden = new Map();
for (let k = 0; k < mentions.length; k += 100) {
  const data = await graphql(
    'query($ids: [ID!]!) { nodes(ids: $ids) { ... on IssueComment { id isMinimized minimizedReason } } }',
    { ids: mentions.slice(k, k + 100).map((c) => c.node_id) },
  );
  for (const n of data.nodes) if (n) hidden.set(n.id, n);
}

const found = [];
const notTouched = [];
for (const c of mentions) {
  const issue = byNumber.get(numberOf(c));
  const base = {
    id: c.id,
    url: c.html_url,
    number: numberOf(c),
    kind: issue ? kindOf(issue) : 'unknown',
    author: c.user?.login,
    created: c.created_at,
    hidden: hidden.get(c.node_id)?.isMinimized ?? null,
    hiddenReason: hidden.get(c.node_id)?.minimizedReason ?? null,
  };
  const upload = parseUpload(c, LOGIN);
  if (upload) found.push({ ...base, bot: upload.bot, sha: upload.sha, ids: idsIn(String(c.body)), body: c.body });
  else notTouched.push({ ...base, why: whyNot(c) });
}

// Every place text lives in the repo, but the upload comments themselves.
const uploadIds = new Set(found.map((f) => f.id));
/** @type {{ where: string, url: string, number?: number, text: string }[]} */
const corpus = [
  ...issues.map((i) => ({
    where: `${i.pull_request ? 'PR' : 'issue'} #${i.number}'s description`,
    url: i.html_url,
    number: i.number,
    text: String(i.body ?? ''),
  })),
  ...comments.map((c) => ({
    where: `${uploadIds.has(c.id) ? 'upload comment' : 'comment'} ${c.id} on #${numberOf(c)}`,
    url: c.html_url,
    number: numberOf(c),
    text: String(c.body ?? ''),
    self: c.id,
  })),
  ...reviewComments.map((c) => ({ where: `review comment ${c.id}`, url: c.html_url, text: String(c.body ?? '') })),
  ...reviews.map((r) => ({ where: `review ${r.id} on #${r.number}`, url: r.html_url, text: String(r.body ?? '') })),
  ...commitComments.map((c) => ({ where: `commit comment ${c.id}`, url: c.html_url, text: String(c.body ?? '') })),
];

/** @type {Record<string, { where: string, url: string }[]>} */
const places = {};
/** @type {Record<string, { status: number | string, type?: string, bytes?: number, sha256?: string, file?: string }>} */
const pictures = {};
/** @type {Set<number>} */
const describedNumbers = new Set();
for (const f of found) {
  describedNumbers.add(f.number);
  writeFileSync(path.join(OUT, 'comments', `${f.id}.md`), String(f.body));
  for (const id of f.ids) {
    places[id] ??= corpus
      .filter((p) => /** @type {any} */ (p).self !== f.id && p.text.includes(id))
      .map(({ where, url, number }) => {
        if (number && where.endsWith('description')) describedNumbers.add(number);
        return { where, url };
      });
    if (pictures[id]) continue;
    try {
      // Signed out: no header, the redirect followed.
      const res = await fetch(`https://github.com/user-attachments/assets/${id}`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(60_000),
      });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok) {
        pictures[id] = { status: res.status, type };
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      const ext = type.includes('png') ? 'png' : type.includes('gif') ? 'gif' : type.includes('jpeg') ? 'jpg' : 'bin';
      const file = `pictures/${id}.${ext}`;
      writeFileSync(path.join(OUT, file), bytes);
      pictures[id] = { status: res.status, type, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), file };
    } catch (e) {
      pictures[id] = { status: String(e) };
    }
  }
}
for (const n of describedNumbers) {
  writeFileSync(path.join(OUT, 'descriptions', `${n}.md`), String(byNumber.get(n)?.body ?? ''));
}

/** A place that keeps a picture once its upload comment goes: anything but another upload comment. */
const keeps = (/** @type {{ where: string }} */ p) => !p.where.startsWith('upload comment');
const rows = found.map((f) => {
  const linked = f.ids.filter((id) => places[id].some(keeps));
  const ownDescription = f.ids.filter((id) => places[id].some((p) => p.where === `${f.kind.startsWith('PR') ? 'PR' : 'issue'} #${f.number}'s description`));
  return {
    ...f,
    body: undefined,
    pictures: f.ids.length,
    linked: linked.length,
    linkedInOwnDescription: ownDescription.length,
    unlinked: f.ids.filter((id) => !places[id].some(keeps)),
    linkedOnlyByUploadComments: f.ids.filter((id) => places[id].length > 0 && !places[id].some(keeps)),
    elsewhere: [...new Set(f.ids.flatMap((id) => places[id].filter(keeps).map((p) => p.where)))],
    loads: f.ids.filter((id) => pictures[id].status === 200).length,
  };
});

writeFileSync(
  path.join(OUT, 'dry-run.json'),
  JSON.stringify({ repo: REPO, login: LOGIN, at: new Date().toISOString(), found: rows, notTouched, places, pictures }, null, 2),
);

const s = [
  `## ${REPO}: upload comments (dry run, nothing deleted)`,
  '',
  `- Read: ${issues.length} issues and PRs, ${comments.length} issue comments, ${reviewComments.length} review comments, ${reviews.length} review bodies, ${commitComments.length} commit comments.`,
  `- Found: **${rows.length}** upload comments by \`${LOGIN}\` that \`parseUpload\` counts, holding ${rows.reduce((a, r) => a + r.pictures, 0)} pictures (${rows.reduce((a, r) => a + r.loads, 0)} load signed out).`,
  `- Not touched: ${notTouched.length}.`,
  '',
  '| # | Kind | Comment | Hidden | Pictures | Linked elsewhere | In its own description | Unlinked | Loads | Where |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| #${r.number} | ${r.kind} | [${r.id}](${r.url}) | ${r.hidden ? `yes (${r.hiddenReason})` : 'no'} | ${r.pictures} | ${r.linked} | ${r.linkedInOwnDescription} | ${r.unlinked.length} | ${r.loads} | ${r.elsewhere.join('; ') || '-'} |`,
  ),
  '',
  '**Not touched**',
  '',
  '| # | Kind | Comment | Author | Why |',
  '|---|---|---|---|---|',
  ...notTouched.map((n) => `| #${n.number} | ${n.kind} | [${n.id}](${n.url}) | ${n.author} | ${n.why} |`),
  '',
];
console.log(s.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, s.join('\n'));
writeFileSync(path.join(OUT, 'summary.md'), s.join('\n'));
