// One-off (ci#144, the cleanup's step 1: P1 and P3), on this throwaway
// branch only: never on main. On two throwaway PRs (one to be closed
// unmerged, one merged into a scratch base), it posts an upload comment as
// visual review did before ci#144 (BOT_PR_TOKEN, `gh pr comment --attach`,
// then the section edited in), copies the section into the description as
// describe did (Actions token), closes or merges the PR, deletes the comment
// (the Actions token first, P3; BOT_PR_TOKEN only if that is refused), and
// fetches each link signed out, comparing sha256 with the file uploaded.
// Every fetch is a step of its own, tied to the step before it: no wait.
//
//   node oneoff/p1.mjs <command> <state.json>
//   commands: upload, fetch <label>, describe, finish, delete, report

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseUpload, SECTION, uploadMarker } from '../describe/describe.mjs';

const REPO = /** @type {string} */ (process.env.REPO);
const FILES = ['oneoff/p1-before.png', 'oneoff/p1-after.png'];
const [cmd, statePath, label] = process.argv.slice(2);

/** @typedef {{ pr: number, role: string, comment?: number, url?: string, links?: string[], deleted?: string }} Target */
/** @typedef {{ login?: string, targets: Target[], sha: Record<string, string>, fetches: { label: string, at: string, link: string, pr: number, status: number | string, sha256?: string, match?: boolean }[], log: string[] }} State */

/** @returns {State} */
const load = () => JSON.parse(readFileSync(statePath, 'utf8'));
const save = (/** @type {State} */ s) => writeFileSync(statePath, JSON.stringify(s, null, 2));

/**
 * gh with a given token; returns stdout, or throws with gh's stderr.
 *
 * @param {string} token
 * @param {string[]} args
 */
function gh(token, args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const sha256 = (/** @type {Buffer} */ b) => createHash('sha256').update(b).digest('hex');
const note = (/** @type {State} */ s, /** @type {string} */ line) => {
  console.log(line);
  s.log.push(`${new Date().toISOString()} ${line}`);
};

const actions = /** @type {string} */ (process.env.ACTIONS_TOKEN);
const bot = /** @type {string} */ (process.env.UPLOAD_TOKEN);

if (cmd === 'upload') {
  /** @type {State} */
  const s = {
    login: gh(bot, ['api', 'user', '--jq', '.login']).trim(),
    targets: [
      { pr: Number(process.env.CLOSED_PR), role: 'closed unmerged' },
      { pr: Number(process.env.MERGED_PR), role: 'merged into a scratch base' },
    ],
    sha: Object.fromEntries(FILES.map((f) => [f, sha256(readFileSync(f))])),
    fetches: [],
    log: [],
  };
  for (const t of s.targets) {
    const head = gh(actions, ['api', `repos/${REPO}/pulls/${t.pr}`, '--jq', '.head.sha']).trim();
    const body = [
      uploadMarker('visual-review', head),
      "Pictures for this PR's visual-review table (ci#144 P1 throwaway).",
      '',
      ...FILES.map((f, i) => `![p1-${i + 1}](./${f})`),
    ].join('\n');
    const url = gh(bot, [
      'pr',
      'comment',
      String(t.pr),
      '--repo',
      REPO,
      '--body',
      body,
      ...FILES.flatMap((f) => ['--attach', `./${f}`]),
    ]).trim();
    t.url = url;
    t.comment = Number(/#issuecomment-(\d+)$/.exec(url)?.[1]);
    const posted = JSON.parse(gh(actions, ['api', `repos/${REPO}/issues/comments/${t.comment}`]));
    t.links = [...String(posted.body).matchAll(/https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+/g)].map((m) => m[0]);
    if (t.links.length !== FILES.length) throw new Error(`PR ${t.pr}: ${t.links.length} links in ${url}`);
    const section = [
      '| Before | After |',
      '|---|---|',
      `| <img src="${t.links[0]}" width="64"> | <img src="${t.links[1]}" width="64"> |`,
    ].join('\n');
    gh(bot, ['api', '-X', 'PATCH', `repos/${REPO}/issues/comments/${t.comment}`, '-f', `body=${String(posted.body).trimEnd()}\n\n${SECTION}\n${section}`]);
    const final = JSON.parse(gh(actions, ['api', `repos/${REPO}/issues/comments/${t.comment}`]));
    const upload = parseUpload(final, /** @type {string} */ (s.login));
    if (!upload) throw new Error(`PR ${t.pr}: parseUpload refuses comment ${t.comment}`);
    note(s, `PR ${t.pr} (${t.role}): comment ${t.comment} by ${final.user.login}, parseUpload counts it, links ${t.links.join(' ')}`);
  }
  save(s);
} else if (cmd === 'fetch') {
  const s = load();
  for (const t of s.targets) {
    for (const [i, link] of (t.links ?? []).entries()) {
      /** @type {State['fetches'][number]} */
      const row = { label, at: new Date().toISOString(), link, pr: t.pr, status: 0 };
      try {
        // Signed out: no header at all, and the redirect followed.
        const res = await fetch(link, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
        row.status = res.status;
        if (res.ok) {
          row.sha256 = sha256(Buffer.from(await res.arrayBuffer()));
          row.match = row.sha256 === s.sha[FILES[i]];
        }
      } catch (e) {
        row.status = String(e);
      }
      s.fetches.push(row);
      note(s, `fetch ${label}: PR ${t.pr} ${link} -> ${row.status}${row.sha256 ? ` sha256 ${row.match ? 'matches' : 'DIFFERS'}` : ''}`);
    }
  }
  save(s);
} else if (cmd === 'describe') {
  const s = load();
  for (const t of s.targets) {
    const c = JSON.parse(gh(actions, ['api', `repos/${REPO}/issues/comments/${t.comment}`]));
    const section = String(c.body).slice(String(c.body).indexOf(SECTION) + SECTION.length).trim();
    const body = gh(actions, ['api', `repos/${REPO}/pulls/${t.pr}`, '--jq', '.body // ""']).trimEnd();
    const next = `${body}\n\n<!-- describe:visual-review -->\n${section}\n<!-- /describe:visual-review -->\n`;
    gh(actions, ['api', '-X', 'PATCH', `repos/${REPO}/pulls/${t.pr}`, '-f', `body=${next}`]);
    note(s, `PR ${t.pr}: description now links ${t.links?.length} pictures (Actions token)`);
  }
  save(s);
} else if (cmd === 'finish') {
  const s = load();
  const [closed, merged] = s.targets;
  gh(actions, ['api', '-X', 'PATCH', `repos/${REPO}/pulls/${closed.pr}`, '-f', 'state=closed']);
  note(s, `PR ${closed.pr}: closed unmerged`);
  gh(actions, ['api', '-X', 'PUT', `repos/${REPO}/pulls/${merged.pr}/merge`, '-f', 'merge_method=squash']);
  const m = gh(actions, ['api', `repos/${REPO}/pulls/${merged.pr}`, '--jq', '.merged,.base.ref']).trim();
  note(s, `PR ${merged.pr}: squash-merged into its scratch base (${m.replace('\n', ', base ')})`);
  save(s);
} else if (cmd === 'delete') {
  const s = load();
  for (const t of s.targets) {
    try {
      gh(actions, ['api', '-X', 'DELETE', `repos/${REPO}/issues/comments/${t.comment}`]);
      t.deleted = 'Actions token';
    } catch (e) {
      note(s, `P3: Actions token refused to delete comment ${t.comment}: ${/** @type {{ stderr?: string }} */ (e).stderr?.trim()}`);
      gh(bot, ['api', '-X', 'DELETE', `repos/${REPO}/issues/comments/${t.comment}`]);
      t.deleted = 'BOT_PR_TOKEN';
    }
    let gone = false;
    try {
      gh(actions, ['api', `repos/${REPO}/issues/comments/${t.comment}`]);
    } catch (e) {
      gone = /HTTP 404/.test(String(/** @type {{ stderr?: string }} */ (e).stderr));
    }
    if (!gone) throw new Error(`comment ${t.comment} still answers after its delete`);
    note(s, `PR ${t.pr}: comment ${t.comment} deleted with the ${t.deleted}; it now answers 404`);
  }
  save(s);
} else if (cmd === 'bodies') {
  const s = load();
  for (const t of s.targets) {
    const body = gh(actions, ['api', `repos/${REPO}/pulls/${t.pr}`, '--jq', '.body // ""']);
    const all = (t.links ?? []).every((l) => body.includes(l));
    note(s, `PR ${t.pr}: description ${all ? 'still links' : 'LOST'} its ${t.links?.length} pictures`);
    if (!all) process.exitCode = 1;
  }
  save(s);
} else if (cmd === 'report') {
  const s = load();
  const lines = ['## ci#144 P1 and P3', '', '| Fetch | PR | Link | Status | sha256 |', '|---|---|---|---|---|'];
  for (const f of s.fetches) {
    lines.push(`| ${f.label} (${f.at}) | #${f.pr} | ${f.link} | ${f.status} | ${f.sha256 ? (f.match ? 'matches' : 'differs') : ''} |`);
  }
  lines.push('', '```text', ...s.log, '```', '');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
  console.log(lines.join('\n'));
  // The last fetch decides: every link 200 and byte for byte.
  const last = s.fetches.at(-1)?.label;
  const bad = s.fetches.filter((f) => f.label === last && !(f.status === 200 && f.match));
  if (bad.length > 0) {
    console.error(`${bad.length} link(s) failed at "${last}"`);
    process.exitCode = 1;
  }
} else {
  throw new Error(`unknown command ${cmd}; state ${existsSync(statePath ?? '') ? 'exists' : 'missing'}`);
}
