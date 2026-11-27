// One review (ci#64): a screenshot run's shots against main's, the table
// handed to the attach job and the `Visual changes` status set, for one PR
// or one mockup.
// It runs from main's code with the Actions token, checks nothing out, and
// reads the shots only as bytes from the runs' artifacts. Everything a PR's
// code wrote is checked where it's read: the manifest (visual-shots), the
// shots' paths and sizes (compare.ts), and the base commit, which must be
// on main and no older than the PR's merge base.
//
// For a PR, in order:
//   1. the run's `visual-shots` artifact, or why there is none: the
//      screenshot job failed, or took nothing (a docs-only PR);
//   2. main's shots of the base: its newest push run of the screenshot
//      workflow there. Still running: the status waits (main's run
//      finishing starts a review of every PR waiting on it, find.ts).
//      Finished without shots: the status says so;
//   3. the comparison, its rows and its fingerprint (status.ts);
//   4. the status, on the run's head commit;
//   5. the hand-off to the attach job (attach.ts, ci#144), an artifact: when
//      the result differs from the one the description's record names
//      (record.ts), the pictures and the table with each picture's local
//      path, for attach to upload in one BOT_PR_TOKEN edit of the
//      description; when it's the same, the table re-rendered from the
//      record's links, for attach to place with the Actions token alone, so
//      a slot added later fills with no new upload. A PR whose table came
//      from an upload comment (before ci#144) has no record: its newest
//      genuine comment stands in for it, and attach hides it;
//   6. for Dependabot's npm bump, enable.mjs, which turns auto-merge on only
//      after "No visual changes".
// A mockup does 1 to 3 and 5 on its issue, and sets no status.
//
// The result shown before, which keeps an acceptance across heads, comes
// from the Actions token's own `Visual changes` statuses on the PR's heads
// (earlierResult), never from the description or a comment, which the PR
// can edit.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newest, pages, statusFrom } from '../lib/github.mjs';
import { parseUpload } from '../describe/describe.ts';
import { parseManifest, MANIFEST } from '../visual-shots/shots.mjs';
import { compareShots } from './compare.ts';
import { BOT, assetLink, parseRecord } from './record.ts';
import { CONTEXT, fingerprint, readMark, shownAt, status } from './status.ts';
import { isMinor, keyOf, lines, pick, renderTable, summary } from './table.ts';
import { crop, enlarge, outlined, sideBySide } from './zoom.ts';
import { MAX_CHARS } from '../lib/comment.mjs';

export { BOT };

/**
 * What a review needs from GitHub and the runner.
 *
 * @typedef {object} Io
 * @property {string} repo owner/name
 * @property {string} owner the repository owner's login
 * @property {string} main the default branch
 * @property {import('../lib/comment.mjs').Api} api the Actions token's REST API
 * @property {(query: string, variables: Record<string, unknown>) => unknown} graphql
 * @property {(runId: number, dir: string) => 'ok' | 'none' | 'expired'} artifact
 *   downloads a run's visual-shots artifact into `dir`: 'none' when the run
 *   has none, 'expired' when it's gone; any other failure throws, never
 *   passing for "no shots"
 * @property {(handoff: Handoff, files: { name: string, bytes: Buffer }[]) => void}
 *   handoff writes what the attach job reads: the hand-off and the pictures
 * @property {string} uploader BOT_PR_TOKEN's account, whose upload comments
 *   (before ci#144) count
 * @property {(number: number) => string} enable enable.mjs, for one PR
 * @property {import('../lib/pixels.mjs').Pixels} pixels
 * @property {() => number} now epoch seconds
 * @property {(line: string) => void} log
 */

/**
 * One review to do: a PR's or a mockup's screenshot run.
 *
 * @typedef {{ kind: 'pr' | 'issue', number: number, run: number }} Target
 */

/**
 * What the review hands the attach job (attach.ts), as `attach.json` beside
 * the pictures.
 *
 * @typedef {object} Handoff
 * @property {1} version
 * @property {'pr' | 'issue'} kind
 * @property {number} number
 * @property {string} head the run's head, which a PR's must still be
 * @property {number} run the screenshot run
 * @property {Omit<import('./record.ts').Record, 'assets'>} record
 * @property {string} section the finished section; with pictures, each
 *   referenced by its local path (`src="./01.png"`)
 * @property {string[]} pictures the files to upload, in pick's order
 * @property {string[]} assets with no pictures, the record's attachment ids
 * @property {string[]} legacy the upload comments (node ids) attach hides
 */

/**
 * The shape of an upload's section. It goes up whenever the section's form
 * changes (table.ts, describe/describe.ts), so a PR whose last upload is
 * the old form gets one new upload in the new form, though its pictures
 * didn't change: the fingerprint alone would leave it as it was. 4: the
 * pictures in the description, no upload comment (ci#144).
 */
export const UPLOAD_FORMAT = 4;

/**
 * Whether `to` is `from` or comes after it on the history GitHub compares.
 *
 * @param {Io} io
 * @param {string} from
 * @param {string} to
 */
function reaches(io, from, to) {
  const c = /** @type {{ status?: string }} */ (
    io.api('GET', `repos/${io.repo}/compare/${from}...${to}`)
  );
  return c.status === 'identical' || c.status === 'ahead';
}

/**
 * Checks the base a PR's run says it was built on: on main, and no older
 * than the PR's merge base. Throws otherwise.
 *
 * @param {Io} io
 * @param {string} base
 * @param {string | null} head the PR's head, null for a mockup
 */
export function checkBase(io, base, head) {
  if (!reaches(io, base, io.main)) {
    throw new Error(`the shots' base ${base.slice(0, 7)} isn't on ${io.main}`);
  }
  if (head === null) return;
  const c = /** @type {{ merge_base_commit?: { sha?: string } }} */ (
    io.api('GET', `repos/${io.repo}/compare/${io.main}...${head}`)
  );
  const mergeBase = c.merge_base_commit?.sha;
  if (!mergeBase || !reaches(io, mergeBase, base)) {
    throw new Error(`the shots' base ${base.slice(0, 7)} is older than the PR's merge base`);
  }
}

/**
 * Main's shots of the base: downloaded into `dir`, or why not.
 *
 * @param {Io} io
 * @param {import('./settings.ts').Settings} s
 * @param {string} base
 * @param {string} dir
 * @returns {'ready' | 'waiting' | 'missing'}
 */
export function reference(io, s, base, dir) {
  const got = /** @type {{ workflow_runs?: { id: number, status: string }[] }} */ (
    io.api(
      'GET',
      `repos/${io.repo}/actions/workflows/${s.workflow}/runs?event=push&branch=${encodeURIComponent(io.main)}&head_sha=${base}&per_page=10`,
    )
  );
  const run = newest(got.workflow_runs ?? []);
  // No push run at all ([skip ci], or a workflow that didn't run): nothing
  // will finish to settle it, so it's missing, not waiting.
  if (!run) return 'missing';
  if (run.status !== 'completed') return 'waiting';
  return io.artifact(run.id, dir) === 'ok' ? 'ready' : 'missing';
}

/**
 * A PR as GraphQL gives it here.
 *
 * @typedef {object} PullData
 * @property {{ login: string, __typename: string } | null} author
 * @property {string} headRefName
 * @property {{ enabledAt: string, enabledBy: { login: string } | null } | null} autoMergeRequest
 */

/**
 * The PR, as the status rule reads it.
 *
 * @param {Io} io
 * @param {number} number
 */
function pullFacts(io, number) {
  const [owner, name] = io.repo.split('/');
  const data = /** @type {{ repository: { pullRequest: PullData } }} */ (
    io.graphql(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            author { login __typename } headRefName
            autoMergeRequest { enabledAt enabledBy { login } }
          }
        }
      }`,
      { owner, name, number },
    )
  );
  const pr = data.repository.pullRequest;
  const author = pr.author?.login ?? '';
  const am = pr.autoMergeRequest;
  return {
    /** @type {import('./status.ts').Pull} */
    pull: {
      author,
      bot: pr.author?.__typename === 'Bot' || pr.headRefName.startsWith('bot/'),
      autoMerge: am
        ? { by: am.enabledBy?.login ?? '', at: Math.floor(Date.parse(am.enabledAt) / 1000) }
        : null,
    },
    headRefName: pr.headRefName,
  };
}

/**
 * The upload comments that count (before ci#144), newest last.
 *
 * @param {Io} io
 * @param {number} number
 */
function uploads(io, number) {
  return pages(io.api, `repos/${io.repo}/issues/${number}/comments`).flatMap((c) => {
    const upload = parseUpload(
      /** @type {import('../describe/describe.ts').Comment} */ (c),
      io.uploader,
    );
    return upload && upload.bot === BOT ? [upload] : [];
  });
}

/**
 * The `Visual changes` status on a commit, or null: only the Actions
 * token's, since a PR's own workflow could post one under that name.
 *
 * @param {Io} io
 * @param {string} sha
 */
const statusOn = (io, sha) => statusFrom(io.api, io.repo, sha, CONTEXT);

/** How many of a PR's commits, and of the heads its force-pushes made and replaced, earlierResult looks at, at most, each. */
export const HEADS_LOOKED_AT = 30;

/**
 * A force-push, as GraphQL gives it here.
 *
 * @typedef {{ beforeCommit?: { oid: string } | null, afterCommit?: { oid: string } | null }} ForcePush
 */

/**
 * The heads a PR's force-pushes replaced and made, newest first, from
 * GraphQL: the REST timeline names only the head a force-push made, and the
 * one it replaced is where an accepted result's status sits after a rebase.
 *
 * @param {Io} io
 * @param {number} number
 * @returns {string[]}
 */
function forcePushedHeads(io, number) {
  const [owner, name] = io.repo.split('/');
  const data =
    /** @type {{ repository: { pullRequest: { timelineItems: { nodes: ForcePush[] } } } }} */ (
      io.graphql(
        `query($owner: String!, $name: String!, $number: Int!, $last: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            timelineItems(last: $last, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
              nodes { ... on HeadRefForcePushedEvent { beforeCommit { oid } afterCommit { oid } } }
            }
          }
        }
      }`,
        { owner, name, number, last: HEADS_LOOKED_AT },
      )
    );
  return data.repository.pullRequest.timelineItems.nodes
    .toReversed()
    .flatMap((n) => [n.afterCommit?.oid, n.beforeCommit?.oid])
    .filter((sha) => typeof sha === 'string');
}

/**
 * The description of the result the PR shows, or showed last: the Actions
 * token's `Visual changes` on `head`, then on the PR's earlier heads, newest
 * first (its commits, then the heads its force-pushes made and replaced, so
 * a rebase keeps an acceptance), from the first that holds a result: a mark,
 * or a success with none ("No visual changes"), so a result that went away
 * and came back is shown afresh. A pending or a failed status is no result,
 * and the walk passes it. At most HEADS_LOOKED_AT commits (of the 250
 * oldest, all the REST API lists) and as many force-pushes. A commit that
 * is also another PR's head counts too (a PR stacked on another): its mark
 * carries over only to the same fingerprint, the same pictures that PR
 * already showed.
 *
 * @param {Io} io
 * @param {number} number
 * @param {string} head
 */
export function earlierResult(io, number, head) {
  const commits = /** @type {{ sha: string }[]} */ (
    pages(io.api, `repos/${io.repo}/pulls/${number}/commits`)
  )
    .map((c) => c.sha)
    .reverse()
    .filter((sha) => sha !== head)
    .slice(0, HEADS_LOOKED_AT);
  const heads = [...new Set([head, ...commits, ...forcePushedHeads(io, number)])];
  for (const sha of heads) {
    const found = statusOn(io, sha);
    if (found && (readMark(found.description) || found.state === 'success')) {
      return found.description;
    }
  }
  return null;
}

/**
 * How many screens a table is allowed, in characters, so it fits a
 * description (MAX_CHARS) beside the text around it.
 */
const SECTION_BUDGET = MAX_CHARS - 20_000;

/**
 * How many screens `all` has that `shown` doesn't.
 *
 * @param {readonly import('./table.ts').Line[]} all
 * @param {readonly import('./table.ts').Line[]} shown
 */
const dropped = (all, shown) => {
  const count = (/** @type {readonly import('./table.ts').Line[]} */ rows) =>
    new Set(rows.map((r) => r.state ?? r.label)).size;
  return count(all) - count(shown);
};

/**
 * What decides how a result is laid out, besides its pictures: the share
 * that makes a change minor and which changes are. A `minor` setting changed
 * in an app's config re-uploads the open PRs once.
 *
 * @param {readonly import('./table.ts').Line[]} rows
 * @param {number} minor
 */
const layoutOf = (rows, minor) =>
  createHash('sha256')
    .update(
      `${minor}\n${rows.map((r) => `${r.change.file} ${isMinor(r) ? 'minor' : 'big'}`).join('\n')}`,
    )
    .digest('hex')
    .slice(0, 8);

/**
 * The section's local path for a picture, which the attach job swaps for
 * its link once it has uploaded it.
 *
 * @param {number} i
 */
export const pictureFile = (i) => `${String(i + 1).padStart(2, '0')}.png`;

/** An attachment's id, as long as GitHub's are (a UUID). */
const SAMPLE_ID = '00000000-0000-0000-0000-000000000000';

/**
 * How much longer a section with `count` pictures grows once attach has
 * uploaded them: each local path (`./01.png`) becomes a link, and the record
 * line gains each picture's id and a comma.
 *
 * @param {string} section
 * @param {number} count
 */
export function growth(section, count) {
  let n = count * (SAMPLE_ID.length + 1);
  for (let i = 0; i < count; i++) {
    const local = `./${pictureFile(i)}`;
    n += (section.split(`"${local}"`).length - 1) * (assetLink(SAMPLE_ID).length - local.length);
  }
  return n;
}

/**
 * The pictures' bytes, in pick's order.
 *
 * @param {Io} io
 * @param {{ pictures: import('./table.ts').Picture[], changes: import('./compare.ts').Change[],
 *   before: string, after: string }} input
 */
function pictureBytes(io, { pictures, changes, before, after }) {
  const byFile = new Map(changes.map((c) => [c.file, c]));
  /** @type {Map<string, import('../lib/pixels.mjs').Image>} */
  const decoded = new Map();
  /**
   * A shot's pixels, decoded once.
   *
   * @param {string} root
   * @param {string} file
   */
  const image = (root, file) => {
    const key = `${root}\0${file}`;
    if (!decoded.has(key)) decoded.set(key, io.pixels.read(readFileSync(path.join(root, file))));
    return /** @type {import('../lib/pixels.mjs').Image} */ (decoded.get(key));
  };
  /** @param {import('../lib/pixels.mjs').Image} img */
  const png = (img) => io.pixels.write(img);
  /**
   * The bytes of one picture: a shot as it is, pixelmatch's diff, or a
   * picture made from them (zoom.ts).
   *
   * @param {import('./table.ts').Picture} p
   * @param {import('./compare.ts').Change} change
   */
  const bytes = (p, change) => {
    const look = change.look;
    if (p.side === 'diff') return /** @type {Buffer} */ (change.diff);
    if (p.side === 'before' || p.side === 'after') {
      return readFileSync(path.join(p.side === 'before' ? before : after, p.file));
    }
    const l = /** @type {import('./zoom.ts').Look} */ (look);
    if (p.side === 'where') return png(outlined(image(after, p.file), l.places));
    // One picture of the three patches, side by side: the changed place in
    // main's shot, the PR's, and pixelmatch's diff, each enlarged alike.
    const patch = (/** @type {import('../lib/pixels.mjs').Image} */ img) =>
      enlarge(crop(img, l.zoom), l.scale);
    return png(
      sideBySide([
        patch(image(before, p.file)),
        patch(image(after, p.file)),
        patch(io.pixels.read(/** @type {Buffer} */ (change.diff))),
      ]),
    );
  };
  return pictures.map((p, i) => ({
    name: pictureFile(i),
    bytes: bytes(p, /** @type {import('./compare.ts').Change} */ (byFile.get(p.file))),
  }));
}

/**
 * The finished section for `links`, each picture's link by keyOf. GitHub
 * refuses a description over 65,536 characters, and the section goes in
 * beside the rest of it: a table over SECTION_BUDGET, less `slack`, drops
 * its last (smallest) screens and says how many.
 *
 * @param {Io} io
 * @param {{ rows: import('./table.ts').Line[], links: Map<string, string>, base: string,
 *   minor: number, slack: (section: string) => number }} input
 *   slack: how much longer the section will grow once written (its local
 *   paths swapped for links)
 */
function render(io, { rows, links, base, minor, slack }) {
  let shown = rows;
  /** @type {string} */
  let section;
  for (;;) {
    section =
      shown.length === 0
        ? summary({ count: 0, base, repo: io.repo })
        : renderTable({
            rows: shown,
            links,
            base,
            repo: io.repo,
            minor,
            omitted: dropped(rows, shown),
          });
    if (section.length + slack(section) <= SECTION_BUDGET || shown.length <= 1) break;
    const last = shown[shown.length - 1];
    const screen = last.state ?? last.label;
    shown = shown.filter((r) => (r.state ?? r.label) !== screen);
  }
  return section;
}

/**
 * Does one review. Returns the PR's or issue's number, or null when there
 * was nothing to do.
 *
 * @param {Target} target
 * @param {{ s: import('./settings.ts').Settings, io: Io }} context
 * @returns {number | null}
 */
export function review(target, { s, io }) {
  const run = /** @type {{ id: number, head_sha: string, conclusion: string | null }} */ (
    io.api('GET', `repos/${io.repo}/actions/runs/${target.run}`)
  );
  const mine = mkdtempSync(path.join(tmpdir(), 'shots-'));
  const got = io.artifact(run.id, mine);
  const manifest =
    got === 'ok'
      ? parseManifest(JSON.parse(readFileSync(path.join(mine, MANIFEST), 'utf8')))
      : null;
  if (manifest && manifest.sha !== run.head_sha) {
    throw new Error(`the shots say they're of ${manifest.sha.slice(0, 7)}, not the run's commit`);
  }

  const number = target.number;
  /** @type {string} */
  let body;
  if (target.kind === 'issue') {
    if (!manifest?.mockupIssue) {
      io.log('visual-review: a run by hand that is no mockup: nothing to do');
      return null;
    }
    // find read the number from the same manifest; read here, it's checked.
    if (manifest.mockupIssue !== number) {
      throw new Error(`the mockup's shots are for #${manifest.mockupIssue}, not #${number}`);
    }
    const issue = /** @type {{ state?: string, pull_request?: unknown, body?: string | null }} */ (
      io.api('GET', `repos/${io.repo}/issues/${number}`)
    );
    if (issue.state !== 'open' || issue.pull_request) {
      throw new Error(`mockup_issue #${number} isn't an open issue in ${io.repo}`);
    }
    body = issue.body ?? '';
  } else {
    // A run for a head the PR has moved on from posts nothing: that head's
    // own run follows.
    const pr = /** @type {{ head: { sha: string }, body?: string | null }} */ (
      io.api('GET', `repos/${io.repo}/pulls/${number}`)
    );
    if (pr.head.sha !== run.head_sha) {
      io.log(`visual-review: #${number} has moved on from ${run.head_sha.slice(0, 7)}`);
      return number;
    }
    body = pr.body ?? '';
  }

  const theirs = mkdtempSync(path.join(tmpdir(), 'main-'));
  /** @returns {{ result: import('./status.ts').Result, compared: { rows: import('./table.ts').Line[], changes: import('./compare.ts').Change[] } | null }} */
  const assess = () => {
    if (!manifest) {
      // No shots is a pass only from a run that succeeded; an expired
      // artifact, or a run that failed or was cancelled, isn't one.
      if (got === 'none' && run.conclusion === 'success') {
        return { result: { kind: 'no-shots' }, compared: null };
      }
      return { result: { kind: 'job-failed', job: s.job }, compared: null };
    }
    const ref = reference(io, s, manifest.base, theirs);
    if (ref === 'waiting')
      return { result: { kind: 'waiting', base: manifest.base }, compared: null };
    if (ref === 'missing') {
      return { result: { kind: 'no-reference', base: manifest.base }, compared: null };
    }
    const changes = compareShots({
      before: theirs,
      after: mine,
      ratio: s.ratio,
      minor: s.minor,
      pixels: io.pixels,
    });
    const rows = lines(changes, s.columns);
    return {
      result: {
        kind: 'compared',
        screens: rows.length,
        fingerprint: fingerprint(changes.map((c) => ({ name: c.file, after: c.after }))),
      },
      compared: { rows, changes },
    };
  };
  if (manifest) checkBase(io, manifest.base, target.kind === 'pr' ? run.head_sha : null);
  let { result, compared } = assess();

  // What the description shows now: its record, or, on a PR whose table
  // came from an upload comment, that comment.
  const record = parseRecord(body);
  const legacy = record ? [] : uploads(io, number);
  const publish = () => {
    if (result.kind !== 'compared' || !compared || !manifest) return;
    const { rows, changes } = compared;
    const layout = layoutOf(rows, s.minor);
    const pictures = pick(rows);
    /** @param {Omit<Handoff, 'version' | 'kind' | 'number' | 'head' | 'run'>} rest */
    const hand = (rest, /** @type {{ name: string, bytes: Buffer }[]} */ files = []) =>
      io.handoff(
        { version: 1, kind: target.kind, number, head: run.head_sha, run: target.run, ...rest },
        files,
      );
    // The same result as the record's: the same pictures on a new head
    // ("Update branch") upload nothing. The table is rendered again from
    // the record's links, for a slot added since.
    if (
      record &&
      record.fingerprint === result.fingerprint &&
      record.format === UPLOAD_FORMAT &&
      record.layout === layout &&
      record.assets.length === pictures.length
    ) {
      const links = new Map(pictures.map((p, i) => [keyOf(p), assetLink(record.assets[i])]));
      const { assets, ...kept } = record;
      hand({
        // A newer mockup run keeps the table: an older one never overwrites it.
        record: { ...kept, run: Math.max(kept.run, target.run) },
        // Sized as the upload was, its record's ids counted alike.
        section: render(io, {
          rows,
          links,
          base: manifest.base,
          minor: s.minor,
          slack: () => assets.length * (SAMPLE_ID.length + 1),
        }),
        pictures: [],
        assets,
        legacy: [],
      });
      return;
    }
    if (result.screens === 0 && !record && legacy.length === 0) return;
    const files = pictureBytes(io, { pictures, changes, before: theirs, after: mine });
    const links = new Map(pictures.map((p, i) => [keyOf(p), `./${files[i].name}`]));
    hand(
      {
        record: {
          sha: run.head_sha,
          fingerprint: result.fingerprint,
          format: UPLOAD_FORMAT,
          layout,
          run: target.run,
        },
        section: render(io, {
          rows,
          links,
          base: manifest.base,
          minor: s.minor,
          slack: (section) => growth(section, files.length),
        }),
        pictures: files.map((f) => f.name),
        assets: [],
        legacy: legacy.map((u) => u.nodeId),
      },
      files,
    );
  };

  if (target.kind === 'issue') {
    publish();
    io.log(`visual-review: mockup on #${number}: ${result.kind}`);
    return number;
  }

  const facts = pullFacts(io, number);
  const before = earlierResult(io, number, run.head_sha);
  const postStatus = () => {
    const shown =
      result.kind === 'compared' ? shownAt(result.fingerprint, before, io.now()) : io.now();
    const st = status({
      result,
      pull: facts.pull,
      owner: io.owner,
      shown,
    });
    io.api('POST', `repos/${io.repo}/statuses/${run.head_sha}`, {
      state: st.state,
      context: CONTEXT,
      description: st.description,
    });
    io.log(`visual-review: #${number} ${st.state}: ${st.description}`);
  };
  postStatus();
  // Main's run may have finished between reading it and posting "waiting",
  // and its own review would then have found nothing waiting: look once more.
  if (result.kind === 'waiting') {
    ({ result, compared } = assess());
    if (result.kind !== 'waiting') postStatus();
  }
  publish();
  if (facts.headRefName.startsWith('dependabot/npm_and_yarn/')) {
    try {
      io.log(io.enable(number));
    } catch (error) {
      // Auto-merge is a convenience: its status is posted, and autofix
      // tries enable.mjs again when the PR's next check completes.
      io.log(`::warning::couldn't turn auto-merge on: ${/** @type {Error} */ (error).message}`);
    }
  }
  return number;
}
