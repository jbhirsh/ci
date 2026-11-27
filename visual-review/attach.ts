// The attach job of visual review (ci#144): it puts the table a review
// handed it (review.ts's Handoff, the artifact `visual-review-attach-<run>`)
// into the PR's or the mockup issue's description, with no comment.
//
// For one target, in order:
//   1. the head check: a PR's head must still be the review's, or nothing is
//      edited (that head's own review follows); a mockup's issue must still
//      be open, and its record must name no newer mockup run than this one,
//      so an older run never overwrites a newer table;
//   2. with pictures, edit 1 (BOT_PR_TOKEN, the only kind of token GitHub
//      lets attach): visual review's block becomes the record line and one
//      Markdown image a picture, `![01](./01.png)`, and `gh pr edit
//      --attach` (`gh issue edit`) uploads each and swaps its path for its
//      link (lib/attach.mjs). gh rewrites only a Markdown image, never an
//      `<img src>`, and appends a file it found no reference to at the end
//      of the body (ci#144's V1), so each file is referenced once;
//   3. the read-back: every picture must now have its link, or the job fails;
//   4. edit 2 (the Actions token, which starts no workflow): the finished
//      table, its local paths swapped for those links, with the record line
//      and its asset ids, placed by describe.ts, each screen in its slot.
//      Anything gh appended at the end of the body after edit 1 is dropped
//      here. With no pictures (the same result re-rendered, or a summary),
//      this is the only edit;
//   (before 2) the upload comments of before ci#144 the review found are
//      hidden as outdated, with the Actions token, before the record that
//      ends their listing is written.
// Edit 1 is the one edit a new result costs the PR that starts workflows:
// PR changes and PR description run once on it, and find.ts skips it, as
// it changes only the contents of visual review's block.
//
// The job runs in PR GIFs' attach group (`pr-gif-attach-<repo>-<number>`),
// so a GIF block written meanwhile is never overwritten: each re-reads the
// description just before it writes. It checks nothing out and runs nothing
// of the PR's: the hand-off is data, checked here where it's read.
//
//   node attach.ts   (env: GH_TOKEN, the Actions token; UPLOAD_TOKEN,
//                      BOT_PR_TOKEN; GITHUB_REPOSITORY; HANDOFF_DIR, the
//                      downloaded artifact, which may be absent: a review
//                      that handed nothing off; ARTIFACT and GITHUB_RUN_ID,
//                      to tell that from a download that failed; KIND and
//                      NUMBER, the target it must be for)
//   node attach.ts pictures   prints how many pictures the hand-off has (0
//                      for none), for the action's gh check

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { attachToDescription } from '../lib/attach.mjs';
import { ghApi } from '../lib/comment.mjs';
import { commandIn } from '../lib/gh.mjs';
import { blocks, place } from '../describe/describe.ts';
import { BOT, assetLink, parseRecord, recordLine } from './record.ts';
import type { Handoff } from './review.ts';
import type { Api } from '../lib/comment.mjs';
import type { Command } from '../lib/gh.mjs';

/** A picture's file in the hand-off: `01.png` to `50.png`. */
const PICTURE = /^\d{2}\.png$/;
const SHA = /^[0-9a-f]{40}$/;
const HEX8 = /^[0-9a-f]{8}$/;
const ASSET = /^[0-9a-f][0-9a-f-]{7,63}$/;

/**
 * The hand-off in `dir`, checked, or null when the review handed none.
 *
 * @param dir
 * @param target the matrix target it must be for
 */
export function readHandoff(
  dir: string,
  target?: { kind: string; number: number },
): Handoff | null {
  const file = path.join(dir, 'attach.json');
  if (!existsSync(file)) return null;
  const h = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const r = (h.record ?? {}) as Record<string, unknown>;
  const whole = (n: unknown) => Number.isInteger(n) && Number(n) > 0;
  const strings = (v: unknown, re: RegExp) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string' && re.test(x));
  const ok =
    h.version === 1 &&
    (h.kind === 'pr' || h.kind === 'issue') &&
    whole(h.number) &&
    whole(h.run) &&
    typeof h.head === 'string' &&
    SHA.test(h.head) &&
    typeof r.sha === 'string' &&
    SHA.test(r.sha) &&
    typeof r.fingerprint === 'string' &&
    HEX8.test(r.fingerprint) &&
    typeof r.layout === 'string' &&
    HEX8.test(r.layout) &&
    whole(r.format) &&
    whole(r.run) &&
    typeof h.section === 'string' &&
    strings(h.pictures, PICTURE) &&
    strings(h.assets, ASSET) &&
    strings(h.legacy, /^\S+$/);
  if (!ok) throw new Error(`visual-review: ${file} isn't a hand-off from the review job`);
  if (target && (h.kind !== target.kind || h.number !== target.number)) {
    throw new Error(
      `visual-review: the hand-off is for ${h.kind} #${h.number}, not ${target.kind} #${target.number}`,
    );
  }
  const handoff = h as unknown as Handoff;
  for (const p of handoff.pictures) {
    if (!existsSync(path.join(dir, p))) throw new Error(`visual-review: the hand-off lacks ${p}`);
  }
  return handoff;
}

/**
 * The text of visual review's block in a description, markers included, or ''.
 */
const ownBlock = (body: string) => {
  const at = blocks.find(body, BOT);
  return at ? body.slice(at.from, at.to) : '';
};

/** An image gh rewrote, in edit 1's block: `![01](https://github.com/user-attachments/assets/<id>)`. */
const UPLOADED =
  /^!\[(\d{2})\]\(https:\/\/github\.com\/user-attachments\/assets\/([0-9a-f-]{8,64})\)$/gm;

/**
 * The description as edit 1 meant it, without what gh appended after it:
 * `body` cut where `meant` ends, when all that follows is attachment images;
 * otherwise `body` as it is (someone else's edit landed too).
 *
 * @param body as gh left it
 * @param meant what was written, its paths swapped for their links
 */
export function withoutAppended(body: string, meant: string) {
  const head = meant.trimEnd();
  if (!body.startsWith(head)) return body;
  const tail = body.slice(head.length);
  return /^(\s*!\[[^\]\n]*\]\(https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+\))+\s*$/.test(
    tail,
  )
    ? `${head}\n`
    : body;
}

/** What attach needs from GitHub. */
export type Io = {
  /** owner/name */
  repo: string;
  /** the hand-off's folder, where gh runs */
  dir: string;
  /** the Actions token's REST API */
  api: Api;
  /** gh with BOT_PR_TOKEN, in `dir` */
  gh: Command;
  /** marks a comment outdated (the Actions token) */
  hide: (nodeId: string) => void;
  log: (line: string) => void;
};

/**
 * Puts a hand-off into its description. Returns 'stale' when the head check
 * stopped it, 'written' when the description changed, 'unchanged' when not.
 */
export function attach(h: Handoff, io: Io): 'stale' | 'written' | 'unchanged' {
  const route = `repos/${io.repo}/issues/${h.number}`;
  const read = () => String((io.api('GET', route) as { body?: string | null }).body ?? '');
  if (h.kind === 'pr') {
    const pr = io.api('GET', `repos/${io.repo}/pulls/${h.number}`) as { head: { sha: string } };
    if (pr.head.sha !== h.head) {
      io.log(`visual-review: #${h.number} has moved on from ${h.head.slice(0, 7)}: edits nothing`);
      return 'stale';
    }
  } else {
    const issue = io.api('GET', route) as {
      state?: string;
      pull_request?: unknown;
      body?: string | null;
    };
    if (issue.state !== 'open' || issue.pull_request) {
      io.log(`visual-review: #${h.number} is no open issue now: edits nothing`);
      return 'stale';
    }
    const newer = parseRecord(issue.body ?? '');
    if (newer && newer.run > h.run) {
      io.log(`visual-review: #${h.number} shows mockup run ${newer.run}, newer than ${h.run}`);
      return 'stale';
    }
  }

  // First, while no record says the table is in the new form: once it is,
  // no review lists these comments again, so one that failed to hide here
  // would never be hidden.
  for (const id of h.legacy) io.hide(id);
  if (h.legacy.length > 0) {
    io.log(`visual-review: hid ${h.legacy.length} upload comment(s) from before ci#144`);
  }
  let { section, assets } = h;
  let tidy: (body: string) => string = (body) => body;
  if (h.pictures.length > 0) {
    const was = read();
    const stem = (file: string) => file.slice(0, -'.png'.length);
    const staged = blocks.write(
      was,
      BOT,
      [
        recordLine({ ...h.record, assets: [] }),
        ...h.pictures.map((p) => `![${stem(p)}](./${p})`),
      ].join('\n'),
    );
    const after = attachToDescription({
      repo: io.repo,
      pr: String(h.number),
      kind: h.kind,
      cwd: io.dir,
      files: h.pictures,
      was,
      body: staged,
      view: read,
      gh: io.gh,
      prefix: 'visual-review',
      noun: 'picture',
      log: io.log,
      span: ownBlock,
    });
    const ids: Map<string, string> = new Map();
    for (const m of ownBlock(after).matchAll(UPLOADED)) ids.set(m[1], m[2]);
    const missing = h.pictures.filter((p) => !ids.has(stem(p)));
    if (missing.length > 0) {
      throw new Error(
        `visual-review: after the upload, #${h.number}'s description has no link for ${missing.join(', ')}`,
      );
    }
    assets = h.pictures.map((p) => ids.get(stem(p)) as string);
    h.pictures.forEach((p, i) => {
      section = section.replaceAll(`"./${p}"`, `"${assetLink(assets[i])}"`);
    });
    let meant = staged;
    h.pictures.forEach((p, i) => {
      meant = meant.replace(`](./${p})`, `](${assetLink(assets[i])})`);
    });
    const tidied = withoutAppended(after, meant);
    tidy = (body) => (body === after ? tidied : body);
  }
  const written = place(
    {
      body: read,
      write: (body) => {
        io.api('PATCH', route, { body });
      },
      log: io.log,
    },
    BOT,
    `${recordLine({ ...h.record, assets })}\n${section}`,
    tidy,
  );
  return written ? 'written' : 'unchanged';
}

/** Hides a comment as outdated, through gh's GraphQL, with the job's GH_TOKEN. */
function minimize(nodeId: string) {
  execFileSync(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      'query=mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { clientMutationId } }',
      '-f',
      `id=${nodeId}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], timeout: 30_000 },
  );
}

/**
 * @param env
 * @param seams for the tests
 */
export function main(
  env: Record<string, string | undefined>,
  { api = ghApi, hide = minimize }: { api?: Api; hide?: (nodeId: string) => void } = {},
) {
  const dir = env.HANDOFF_DIR ?? '';
  const repo = env.GITHUB_REPOSITORY ?? '';
  if (!dir || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('visual-review attach needs HANDOFF_DIR and GITHUB_REPOSITORY');
  }
  const target = { kind: env.KIND ?? '', number: Number(env.NUMBER) };
  const h = existsSync(dir) ? readHandoff(dir, target) : null;
  if (!h) {
    // The download step can't fail (a review with nothing to write uploads
    // no artifact), so a failed download is told apart here.
    const found = api(
      'GET',
      `repos/${repo}/actions/runs/${env.GITHUB_RUN_ID}/artifacts?name=${encodeURIComponent(env.ARTIFACT ?? '')}`,
    ) as { total_count?: number };
    if ((found.total_count ?? 0) > 0) {
      throw new Error(
        `visual-review: the review handed off ${env.ARTIFACT}, but it didn't download: run this job again`,
      );
    }
    console.log('visual-review: the review handed nothing off: nothing to attach');
    return null;
  }
  const upload = env.UPLOAD_TOKEN ?? '';
  if (!upload && h.pictures.length > 0) {
    throw new Error('BOT_PR_TOKEN is missing: visual review uploads its pictures with it');
  }
  const inDir = commandIn('gh', dir);
  return attach(h, {
    repo,
    dir,
    api,
    gh: (args, options) => inDir(args, { ...options, env: { ...process.env, GH_TOKEN: upload } }),
    hide,
    log: console.log,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'pictures') {
    const dir = process.env.HANDOFF_DIR ?? '';
    console.log(existsSync(dir) ? (readHandoff(dir)?.pictures.length ?? 0) : 0);
  } else {
    main(process.env);
  }
}
