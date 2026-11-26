// One-off (ci#144, V2 to V9): drives visual-review/attach against a throwaway
// PR and issue from a workflow on its own branch. Never on main.
//
//   node oneoff/vr-live.mjs <step> <out dir>   (env: GH_TOKEN, REPO, PR, ISSUE, HEAD, RUN)

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { attachToDescription } from '../lib/attach.mjs';
import { ghApi } from '../lib/comment.mjs';
import { commandIn } from '../lib/gh.mjs';
import { testPng } from '../lib/test-pixels.mjs';
import { blocks as describeBlocks, partMarker } from '../describe/describe.mjs';
import { blocksFor } from '../lib/blocks.mjs';
import { assetLink, parseRecord } from '../visual-review/record.mjs';

const [step, out] = process.argv.slice(2);
const { REPO = '', PR = '', ISSUE = '', HEAD = '', RUN = '' } = process.env;
const summary = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
};
/** The two pictures, made the same way each time, so their sha256 can be compared. */
export const PNGS = { '01.png': testPng(40, 30, 7), '02.png': testPng(30, 40, 11) };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const section = (link) =>
  [
    partMarker('head'),
    'Visual changes: 2 screens changed (throwaway, ci#144)',
    partMarker('screen:trips'),
    `<img src="${link('01.png')}" alt="trips, after" width="200">`,
    partMarker('rest'),
    `<img src="${link('02.png')}" alt="cards, after" width="200">`,
  ].join('\n');
const record = (run) => ({
  sha: HEAD,
  fingerprint: 'a1b2c3d4',
  format: 4,
  layout: 'e5f6a7b8',
  run: Number(run),
});
const write = (dir, handoff, files = {}) => {
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(dir, name), bytes);
  writeFileSync(path.join(dir, 'attach.json'), JSON.stringify(handoff));
};
const body = (n) => String(ghApi('GET', `repos/${REPO}/issues/${n}`).body ?? '');

if (step === 'prep') {
  // An upload for the PR, and one for the issue (its own fake run number).
  const pics = Object.keys(PNGS);
  write(
    path.join(out, 'pr'),
    {
      version: 1,
      kind: 'pr',
      number: Number(PR),
      head: HEAD,
      run: Number(RUN),
      record: record(RUN),
      section: section((f) => `./${f}`),
      pictures: pics,
      assets: [],
      legacy: [],
    },
    PNGS,
  );
  write(
    path.join(out, 'issue'),
    {
      version: 1,
      kind: 'issue',
      number: Number(ISSUE),
      head: HEAD,
      run: 2,
      record: record(2),
      section: section((f) => `./${f}`),
      pictures: pics,
      assets: [],
      legacy: [],
    },
    PNGS,
  );
  summary(`prep: handoffs for #${PR} (run ${RUN}) and #${ISSUE} (run 2)`);
} else if (step === 'later') {
  // The same result again (a re-render from the record's links, no upload), a
  // stale one (a head the PR never had), and an older mockup run for the issue.
  const r = parseRecord(body(PR));
  if (!r || r.assets.length !== 2)
    throw new Error(`no record with two assets on #${PR}: ${JSON.stringify(r)}`);
  const links = { '01.png': assetLink(r.assets[0]), '02.png': assetLink(r.assets[1]) };
  const { assets, ...kept } = r;
  write(path.join(out, 'rerender'), {
    version: 1,
    kind: 'pr',
    number: Number(PR),
    head: HEAD,
    run: Number(RUN),
    record: kept,
    section: section((f) => links[f]),
    pictures: [],
    assets,
    legacy: [],
  });
  write(path.join(out, 'stale'), {
    version: 1,
    kind: 'pr',
    number: Number(PR),
    head: 'f'.repeat(40),
    run: Number(RUN),
    record: { ...kept, fingerprint: '99999999' },
    section: 'STALE',
    pictures: [],
    assets: [],
    legacy: [],
  });
  write(path.join(out, 'older'), {
    version: 1,
    kind: 'issue',
    number: Number(ISSUE),
    head: HEAD,
    run: 1,
    record: record(1),
    section: 'OLDER',
    pictures: [],
    assets: [],
    legacy: [],
  });
  summary(`later: re-render with ${assets.join(', ')}`);
} else if (step === 'gif') {
  // Stands in for PR GIFs' attach: its own block, one picture, BOT_PR_TOKEN.
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'demo.png'), testPng(20, 20, 3));
  const gifs = blocksFor('pr-gif', {});
  const read = () => body(PR);
  const was = read();
  const gh = commandIn('gh', out);
  attachToDescription({
    repo: REPO,
    pr: PR,
    cwd: out,
    files: ['demo.png'],
    was,
    body: gifs.write(
      was,
      'demo',
      'Recorded automatically (throwaway)\n\n![GIF: demo after](./demo.png)',
    ),
    view: read,
    gh: (a, o) => gh(a, { ...o, env: { ...process.env, GH_TOKEN: process.env.UPLOAD_TOKEN } }),
    prefix: 'pr-gif',
    noun: 'GIF',
    log: console.log,
  });
  summary('gif: wrote the pr-gif:demo block');
} else if (step === 'verify') {
  const pr = body(PR);
  const issue = body(ISSUE);
  const checks = [];
  const check = (what, ok) => {
    checks.push(ok);
    summary(`- [${ok ? 'x' : ' '}] ${what}`);
  };
  const r = parseRecord(pr);
  check(`PR record has two assets: ${r?.assets.join(', ')}`, r?.assets.length === 2);
  const slot = describeBlocks.find(pr, 'visual-review:trips');
  check(
    'the trips screen is in its slot, linked',
    !!slot && pr.slice(slot.from, slot.to).includes(assetLink(r?.assets[0] ?? 'x')),
  );
  check('no local path is left', !pr.includes('"./0') && !pr.includes('](./'));
  check('no staged Markdown image is left in the block', !/!\[0\d\]\(/.test(pr));
  check(
    'the pr-gif:demo block survived',
    blocksFor('pr-gif', {}).find(pr, 'demo') !== null && pr.includes('GIF: demo after'),
  );
  check('the stale hand-off wrote nothing', !pr.includes('STALE'));
  check(
    'nothing appended after the blocks',
    !/\n!\[[^\]]*\]\(https:\/\/github\.com\/user-attachments\/assets\/[^)]+\)\s*$/.test(
      pr.split('<!-- /describe:visual-review -->').at(-1) ?? '',
    ),
  );
  const ir = parseRecord(issue);
  check(
    `issue record has two assets, run 2: ${ir?.assets.join(', ')}`,
    ir?.assets.length === 2 && ir?.run === 2,
  );
  check('the older mockup run wrote nothing', !issue.includes('OLDER'));
  check(
    'the hand-written intro is kept on both',
    pr.includes('Throwaway intro.') && issue.includes('Throwaway intro.'),
  );
  summary(
    `\nsha256 01.png ${sha(PNGS['01.png'])}\nsha256 02.png ${sha(PNGS['02.png'])}\nlinks: ${[...(r?.assets ?? []), ...(ir?.assets ?? [])].map(assetLink).join(' ')}`,
  );
  if (checks.some((c) => !c)) process.exitCode = 1;
} else if (step === 'fetch') {
  // Each picture of the PR's and the issue's records, fetched signed out
  // once, now: 200 and the same bytes as uploaded (V6).
  const want = Object.values(PNGS).map(sha);
  let bad = 0;
  for (const n of [PR, ISSUE]) {
    const r = parseRecord(body(n));
    for (const [i, id] of (r?.assets ?? []).entries()) {
      const res = await fetch(assetLink(id), { redirect: 'follow' });
      const got = sha(Buffer.from(await res.arrayBuffer()));
      const ok = res.status === 200 && got === want[i];
      if (!ok) bad++;
      summary(`- [${ok ? 'x' : ' '}] #${n} ${assetLink(id)}: ${res.status}, sha256 ${got}`);
    }
  }
  if (bad > 0) process.exitCode = 1;
} else {
  throw new Error(`unknown step ${step}`);
}
