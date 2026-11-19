// One review (ci#64): a screenshot run's shots against main's, the table
// uploaded and the `Visual changes` status set, for one PR or one mockup.
// It runs from main's code with the Actions token, checks nothing out, and
// reads the shots only as bytes from the runs' artifacts. Everything a PR's
// code wrote is checked where it's read: the manifest (visual-shots), the
// shots' paths and sizes (compare.mjs), and the base commit, which must be
// on main and no older than the PR's merge base.
//
// For a PR, in order:
//   1. the run's `visual-shots` artifact, or why there is none: the
//      screenshot job failed, or took nothing (a docs-only PR);
//   2. main's shots of the base: its newest push run of the screenshot
//      workflow there. Still running: the status waits (main's run
//      finishing starts a review of every PR waiting on it, find.mjs).
//      Finished without shots: the status says so;
//   3. the comparison, its rows and its fingerprint (status.mjs);
//   4. when the result differs from the last upload's, a new upload
//      comment with BOT_PR_TOKEN: the pictures, then the finished table
//      after describe's marker. describe (its own job) copies it into the
//      description;
//   5. the status, on the run's head commit; then, for Dependabot's npm
//      bump, enable.mjs, which turns auto-merge on only after "No visual
//      changes".
// A mockup does 1 to 4 on its issue, and sets no status.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newest, pages, statusFrom } from '../lib/github.mjs';
import { checkPrVisuals } from '../visuals/check.mjs';
import { parseUpload, SECTION, uploadMarker } from '../describe/describe.mjs';
import { parseManifest, MANIFEST } from '../visual-shots/shots.mjs';
import { compareShots } from './compare.mjs';
import { CONTEXT, fingerprint, shownAt, status } from './status.mjs';
import { isMinor, keyOf, lines, pick, renderTable, summary } from './table.mjs';
import { crop, enlarge, outlined, sideBySide } from './zoom.mjs';
import { MAX_CHARS } from '../lib/comment.mjs';

/** The bot's name in its upload comments and its description block. */
export const BOT = 'visual-review';

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
 * @property {(kind: 'pr' | 'issue', number: number, body: string, files: string[]) => number}
 *   upload posts a comment with BOT_PR_TOKEN, attaching the files, and
 *   returns its id
 * @property {(id: number, body: string) => void} editComment with BOT_PR_TOKEN
 * @property {string} uploader BOT_PR_TOKEN's account
 * @property {(number: number) => string} enable enable.mjs, for one PR
 * @property {import('../lib/pixels.mjs').Pixels} pixels
 * @property {() => number} now epoch seconds
 * @property {(line: string) => void} log
 */

/**
 * One review to do: a PR's or a mockup's screenshot run.
 *
 * @typedef {{ kind: 'pr', number: number, run: number } | { kind: 'issue', run: number }} Target
 */

/**
 * The fingerprint an upload comment records, or null.
 *
 * @param {string} body
 */
const fingerprintIn = (body) => /^fingerprint: ([0-9a-f]{8})$/m.exec(body)?.[1] ?? null;

/**
 * The shape of an upload's section. It goes up whenever the section's form
 * changes (table.mjs, describe/describe.mjs), so a PR whose last upload is
 * the old form gets one new upload in the new form, though its pictures
 * didn't change: the fingerprint alone would leave it as it was.
 */
const UPLOAD_FORMAT = 3;

/**
 * The format an upload comment records: 1 for one without the line.
 *
 * @param {string} body
 */
const formatIn = (body) => Number(/^format: (\d+)$/m.exec(body)?.[1] ?? 1);

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
 * @param {import('./settings.mjs').Settings} s
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
 * @property {string} body
 * @property {{ enabledAt: string, enabledBy: { login: string } | null } | null} autoMergeRequest
 */

/**
 * The PR, as the status rule and the UI rule read it.
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
            author { login __typename } headRefName body
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
    /** @type {import('./status.mjs').Pull} */
    pull: {
      author,
      bot: pr.author?.__typename === 'Bot' || pr.headRefName.startsWith('bot/'),
      autoMerge: am
        ? { by: am.enabledBy?.login ?? '', at: Math.floor(Date.parse(am.enabledAt) / 1000) }
        : null,
    },
    headRefName: pr.headRefName,
    body: pr.body,
    author,
  };
}

/**
 * The upload comments that count, newest last.
 *
 * @param {Io} io
 * @param {number} number
 */
function uploads(io, number) {
  return pages(io.api, `repos/${io.repo}/issues/${number}/comments`)
    .map((c) => {
      const comment = /** @type {import('../describe/describe.mjs').Comment} */ (c);
      const upload = parseUpload(comment, io.uploader);
      return upload && upload.bot === BOT ? { ...upload, body: String(comment.body) } : null;
    })
    .filter((u) => u !== null);
}

/**
 * The `Visual changes` description on a commit, or null: only the Actions
 * token's, since a PR's own workflow could post one under that name.
 *
 * @param {Io} io
 * @param {string} sha
 */
function statusOn(io, sha) {
  return statusFrom(io.api, io.repo, sha, CONTEXT)?.description ?? null;
}

/**
 * How many screens a table is allowed, in characters, so it fits a
 * description (MAX_CHARS) beside the text around it.
 */
const SECTION_BUDGET = MAX_CHARS - 20_000;

/**
 * How many screens `all` has that `shown` doesn't.
 *
 * @param {readonly import('./table.mjs').Line[]} all
 * @param {readonly import('./table.mjs').Line[]} shown
 */
const dropped = (all, shown) => {
  const count = (/** @type {readonly import('./table.mjs').Line[]} */ rows) =>
    new Set(rows.map((r) => r.state ?? r.label)).size;
  return count(all) - count(shown);
};

/**
 * What decides how a result is laid out, besides its pictures: the share
 * that makes a change minor and which changes are. A `minor` setting changed
 * in an app's config re-uploads the open PRs once.
 *
 * @param {readonly import('./table.mjs').Line[]} rows
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
 * The layout an upload comment records, or null.
 *
 * @param {string} body
 */
const layoutIn = (body) => /^layout: ([0-9a-f]{8})$/m.exec(body)?.[1] ?? null;

/**
 * Posts the upload comment: the pictures, then the finished section.
 *
 * @param {Io} io
 * @param {{ kind: 'pr' | 'issue', number: number, sha: string, hash: string,
 *   rows: import('./table.mjs').Line[], changes: import('./compare.mjs').Change[],
 *   before: string, after: string, base: string, minor: number }} upload
 */
function post(io, { kind, number, sha, hash, rows, changes, before, after, base, minor }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'upload-'));
  const pictures = pick(rows);
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
   * picture made from them (zoom.mjs).
   *
   * @param {import('./table.mjs').Picture} p
   * @param {import('./compare.mjs').Change} change
   */
  const bytes = (p, change) => {
    const look = change.look;
    if (p.side === 'diff') return /** @type {Buffer} */ (change.diff);
    if (p.side === 'before' || p.side === 'after') {
      return readFileSync(path.join(p.side === 'before' ? before : after, p.file));
    }
    const l = /** @type {import('./zoom.mjs').Look} */ (look);
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
  const files = pictures.map((p, i) => {
    const file = path.join(dir, `${String(i + 1).padStart(2, '0')}.png`);
    writeFileSync(
      file,
      bytes(p, /** @type {import('./compare.mjs').Change} */ (byFile.get(p.file))),
    );
    return file;
  });
  const head = [
    uploadMarker(BOT, sha),
    "Pictures for this PR's visual-review table. A newer one hides this comment as outdated.",
    '',
    `fingerprint: ${hash}`,
    `format: ${UPLOAD_FORMAT}`,
    `layout: ${layoutOf(rows, minor)}`,
    '',
  ];
  const id = io.upload(
    kind,
    number,
    [...head, ...files.map((f, i) => `![${keyOf(pictures[i])}](${f})`)].join('\n'),
    files,
  );
  const posted = String(
    /** @type {{ body?: string }} */ (io.api('GET', `repos/${io.repo}/issues/comments/${id}`)).body,
  );
  /** @type {Map<string, string>} */
  const links = new Map();
  for (const m of posted.matchAll(
    /!\[([^\]]+)\]\((https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+)\)/g,
  )) {
    links.set(m[1], m[2]);
  }
  // GitHub refuses a description over 65,536 characters, and describe adds
  // the section to the rest of it. A table over SECTION_BUDGET drops its last
  // (smallest) screens and says how many.
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
    if (section.length <= SECTION_BUDGET || shown.length <= 1) break;
    const last = shown[shown.length - 1];
    const screen = last.state ?? last.label;
    shown = shown.filter((r) => (r.state ?? r.label) !== screen);
  }
  io.editComment(id, `${posted.trimEnd()}\n\n${SECTION}\n${section}`);
}

/**
 * Does one review. Returns the PR's or issue's number, for describe, or
 * null when there was nothing to do.
 *
 * @param {Target} target
 * @param {{ s: import('./settings.mjs').Settings,
 *   visuals: import('../visuals/check.mjs').Settings, io: Io }} context
 * @returns {number | null}
 */
export function review(target, { s, visuals, io }) {
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

  /** @type {number} */
  let number;
  if (target.kind === 'issue') {
    if (!manifest?.mockupIssue) {
      io.log('visual-review: a run by hand that is no mockup: nothing to do');
      return null;
    }
    number = manifest.mockupIssue;
    const issue = /** @type {{ state?: string, pull_request?: unknown }} */ (
      io.api('GET', `repos/${io.repo}/issues/${number}`)
    );
    if (issue.state !== 'open' || issue.pull_request) {
      throw new Error(`mockup_issue #${number} isn't an open issue in ${io.repo}`);
    }
  } else {
    number = target.number;
    // A run for a head the PR has moved on from posts nothing: that head's
    // own run follows.
    const pr = /** @type {{ head: { sha: string } }} */ (
      io.api('GET', `repos/${io.repo}/pulls/${number}`)
    );
    if (pr.head.sha !== run.head_sha) {
      io.log(`visual-review: #${number} has moved on from ${run.head_sha.slice(0, 7)}`);
      return number;
    }
  }

  const theirs = mkdtempSync(path.join(tmpdir(), 'main-'));
  /** @returns {{ result: import('./status.mjs').Result, compared: { rows: import('./table.mjs').Line[], changes: import('./compare.mjs').Change[] } | null }} */
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

  const previous = uploads(io, number).at(-1) ?? null;
  const publish = () => {
    if (result.kind !== 'compared' || !compared || !manifest) return;
    // Only when the result differs from the last upload's: the same
    // pictures on a new head ("Update branch") upload nothing.
    if (
      previous &&
      fingerprintIn(previous.body) === result.fingerprint &&
      formatIn(previous.body) === UPLOAD_FORMAT &&
      layoutIn(previous.body) === layoutOf(compared.rows, s.minor)
    ) {
      return;
    }
    if (result.screens === 0 && !previous) return;
    post(io, {
      kind: target.kind,
      number,
      sha: run.head_sha,
      hash: result.fingerprint,
      rows: compared.rows,
      changes: compared.changes,
      before: theirs,
      after: mine,
      base: manifest.base,
      minor: s.minor,
    });
  };

  if (target.kind === 'issue') {
    publish();
    io.log(`visual-review: mockup on #${number}: ${result.kind}`);
    return number;
  }

  const facts = pullFacts(io, number);
  const verdict = checkPrVisuals({
    files: pages(io.api, `repos/${io.repo}/pulls/${number}/files`).map((f) =>
      String(/** @type {{ filename: string }} */ (f).filename),
    ),
    body: facts.body,
    author: facts.author,
    settings: visuals,
  });
  const before = statusOn(io, run.head_sha) ?? (previous ? statusOn(io, previous.sha) : null);
  const postStatus = () => {
    const shown =
      result.kind === 'compared' ? shownAt(result.fingerprint, before, io.now()) : io.now();
    const st = status({
      result,
      pull: facts.pull,
      owner: io.owner,
      shown,
      ui: verdict.ok ? { changed: false, shown: true } : { changed: true, shown: false },
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
