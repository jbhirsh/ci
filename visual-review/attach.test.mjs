import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { blocks, partMarker } from '../describe/describe.ts';
import { attach, main, readHandoff, withoutAppended } from './attach.mjs';
import { parseRecord, recordLine } from './record.mjs';

const REPO = 'jbhirsh/app';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const LINK = (/** @type {number} */ i) =>
  `https://github.com/user-attachments/assets/0000000${i}-aaaa-bbbb-cccc-dddddddddddd`;

/** @type {import('./review.mjs').Handoff['record']} */
const RECORD = { sha: HEAD, fingerprint: '1234abcd', format: 4, layout: 'abcd1234', run: 7 };

/**
 * A hand-off with two pictures, in a folder of its own.
 *
 * @param {Partial<import('./review.mjs').Handoff>} [over]
 */
function handoff(over = {}) {
  /** @type {import('./review.mjs').Handoff} */
  const h = {
    version: 1,
    kind: 'pr',
    number: 5,
    head: HEAD,
    run: 7,
    record: RECORD,
    section: [
      partMarker('head'),
      'Visual changes: 1 screen changed',
      partMarker('screen:trips'),
      '<img src="./01.png" alt="trips, before" width="300"> <img src="./02.png" alt="trips, after" width="300">',
    ].join('\n'),
    pictures: ['01.png', '02.png'],
    assets: [],
    legacy: [],
    ...over,
  };
  const dir = mkdtempSync(path.join(tmpdir(), 'vr-attach-'));
  for (const p of h.pictures) writeFileSync(path.join(dir, p), 'png');
  writeFileSync(path.join(dir, 'attach.json'), JSON.stringify(h));
  return { h, dir };
}

/**
 * A fake GitHub: one description, a PR's head or an issue's state, and a
 * gh that uploads as gh does, rewriting each Markdown image's local path.
 *
 * @param {{ body?: string, head?: string, state?: string, pull?: boolean,
 *   gh?: (body: string, files: string[]) => string }} [o]
 *   gh: what gh leaves of the body it's given, with the files attached
 */
function github(o = {}) {
  let body = o.body ?? 'Goal.';
  /** @type {{ token: string, body: string }[]} */
  const edits = [];
  /** @type {string[][]} */
  const ghCalls = [];
  /** @type {string[]} */
  const hidden = [];
  /** @type {string[]} */
  const logs = [];
  const upload =
    o.gh ??
    ((/** @type {string} */ text, /** @type {string[]} */ files) => {
      let next = text;
      files.forEach((f, i) => {
        next = next.replaceAll(`](${f})`, `](${LINK(i + 1)})`);
      });
      return next;
    });
  /** @type {import('./attach.mjs').Io} */
  const io = {
    repo: REPO,
    dir: '',
    api: (method, route, data) => {
      if (method === 'GET' && route === `repos/${REPO}/pulls/5`) {
        return { head: { sha: o.head ?? HEAD } };
      }
      if (route === `repos/${REPO}/issues/5` || route === `repos/${REPO}/issues/9`) {
        if (method === 'GET') {
          return { body, state: o.state ?? 'open', ...(o.pull ? { pull_request: {} } : {}) };
        }
        if (method === 'PATCH') {
          body = /** @type {{ body: string }} */ (data).body;
          edits.push({ token: 'actions', body });
          return {};
        }
      }
      throw new Error(`unexpected ${method} ${route}`);
    },
    gh: (args) => {
      ghCalls.push(args);
      const text = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      const files = args.filter((_, i) => args[i - 1] === '--attach');
      body = upload(text, files);
      edits.push({ token: 'bot', body });
      return { status: 0, stdout: '', stderr: '' };
    },
    hide: (id) => hidden.push(id),
    log: (line) => logs.push(line),
  };
  return { io, edits, ghCalls, hidden, logs, body: () => body };
}

describe('attach', () => {
  it('uploads in one BOT_PR_TOKEN edit, then writes the finished table with the Actions token', () => {
    const { h, dir } = handoff({ legacy: ['N1'] });
    const g = github({
      body: 'Goal.\n\n<!-- describe:visual-review:trips -->\n<!-- /describe:visual-review:trips -->',
    });
    g.io.dir = dir;
    expect(attach(h, g.io)).toBe('written');
    expect(g.edits.map((e) => e.token)).toEqual(['bot', 'actions']);
    expect(g.ghCalls[0].slice(0, 3)).toEqual(['pr', 'edit', '5']);
    // Edit 1: the record line and one Markdown image a picture.
    expect(g.edits[0].body).toContain(`![01](${LINK(1)})\n![02](${LINK(2)})`);
    // Edit 2: the table, its pictures linked, the screen in its slot, the record with the ids.
    const done = g.body();
    expect(done).toContain(`<img src="${LINK(1)}" alt="trips, before"`);
    expect(done).not.toContain('./0');
    expect(done).not.toContain('![01]');
    const slot = blocks.find(done, 'visual-review:trips');
    expect(done.slice(slot?.from, slot?.to)).toContain(LINK(2));
    expect(parseRecord(done)).toEqual({
      ...RECORD,
      assets: ['00000001-aaaa-bbbb-cccc-dddddddddddd', '00000002-aaaa-bbbb-cccc-dddddddddddd'],
    });
    expect(g.hidden).toEqual(['N1']);
  });

  it('hides the old upload comments before it uploads, so a failed upload leaves none to find', () => {
    const { h, dir } = handoff({ legacy: ['N1'] });
    const g = github();
    g.io.dir = dir;
    g.io.gh = () => {
      throw new Error('HTTP 502');
    };
    expect(() => attach(h, g.io)).toThrow(/stopped after 0 of 2 pictures/);
    expect(g.hidden).toEqual(['N1']);
  });

  it('edits nothing for a head the PR has moved on from', () => {
    const { h, dir } = handoff();
    const g = github({ head: OTHER });
    g.io.dir = dir;
    expect(attach(h, g.io)).toBe('stale');
    expect(g.edits).toEqual([]);
    expect(g.ghCalls).toEqual([]);
  });

  it('writes a hand-off with no pictures with the Actions token alone, and nothing twice', () => {
    const { h, dir } = handoff({
      pictures: [],
      assets: ['0000000a-1111'],
      section: 'Visual changes: none',
    });
    const g = github();
    g.io.dir = dir;
    expect(attach(h, g.io)).toBe('written');
    expect(g.edits.map((e) => e.token)).toEqual(['actions']);
    expect(parseRecord(g.body())?.assets).toEqual(['0000000a-1111']);
    expect(attach(h, g.io)).toBe('unchanged');
  });

  it("uploads to a mockup's issue, unless it closed or shows a newer run's table", () => {
    const issue = /** @type {const} */ ({ kind: 'issue', number: 9 });
    const { h, dir } = handoff(issue);
    const g = github();
    g.io.dir = dir;
    expect(attach(h, g.io)).toBe('written');
    expect(g.ghCalls[0].slice(0, 3)).toEqual(['issue', 'edit', '9']);
    for (const o of [{ state: 'closed' }, { pull: true }]) {
      const closed = github(o);
      closed.io.dir = dir;
      expect(attach(h, closed.io)).toBe('stale');
    }
    const newer = blocks.write(
      'Plan.',
      'visual-review',
      recordLine({ ...RECORD, run: 8, assets: [] }),
    );
    const n = github({ body: newer });
    n.io.dir = dir;
    expect(attach(h, n.io)).toBe('stale');
    expect(n.edits).toEqual([]);
    // The same run again, or an older record, is written.
    const same = github({
      body: blocks.write('Plan.', 'visual-review', recordLine({ ...RECORD, assets: [] })),
    });
    same.io.dir = dir;
    expect(attach(h, same.io)).toBe('written');
  });

  it('fails when a picture has no link after the upload', () => {
    const { h, dir } = handoff();
    // gh kept the first picture's path local.
    const local = github({
      gh: (text) => text.replace('](./02.png)', `](${LINK(2)})`),
    });
    local.io.dir = dir;
    expect(() => attach(h, local.io)).toThrow(/left 01\.png referenced locally/);
    // gh rewrote both, but a line was lost.
    const lost = github({
      gh: (text) =>
        text.replace(/\n!\[02\]\(\.\/02\.png\)/, '').replace('](./01.png)', `](${LINK(1)})`),
    });
    lost.io.dir = dir;
    expect(() => attach(h, lost.io)).toThrow(/no link for 02\.png/);
    expect(lost.edits.map((e) => e.token)).toEqual(['bot']);
  });

  it('drops an image gh appended at the end of the body, in edit 2', () => {
    const { h, dir } = handoff();
    const g = github({
      gh: (text, files) => {
        let next = text;
        files.forEach((f, i) => {
          next = next.replaceAll(`](${f})`, `](${LINK(i + 1)})`);
        });
        return `${next}\n![Blue](${LINK(9)})`;
      },
    });
    g.io.dir = dir;
    attach(h, g.io);
    expect(g.edits[0].body).toContain(LINK(9));
    expect(g.body()).not.toContain(LINK(9));
  });
});

describe('withoutAppended', () => {
  it('cuts only images after what was meant, and leaves anyone else’s text', () => {
    expect(withoutAppended(`A\nB\n![x](${LINK(1)})\n`, 'A\nB\n')).toBe('A\nB\n');
    // Nothing appended: the body as gh left it.
    expect(withoutAppended('A\nB', 'A\nB\n')).toBe('A\nB');
    expect(withoutAppended(`A\nB\nmine\n![x](${LINK(1)})`, 'A\nB\n')).toBe(
      `A\nB\nmine\n![x](${LINK(1)})`,
    );
    expect(withoutAppended('Edited A\nB', 'A\nB')).toBe('Edited A\nB');
  });
});

describe('readHandoff', () => {
  it('reads what the review wrote, and none when it wrote nothing', () => {
    const { h, dir } = handoff();
    expect(readHandoff(dir)).toEqual(h);
    expect(readHandoff(dir, { kind: 'pr', number: 5 })).toEqual(h);
    // Another target's hand-off is refused.
    expect(() => readHandoff(dir, { kind: 'pr', number: 6 })).toThrow(/is for pr #5, not pr #6/);
    expect(() => readHandoff(dir, { kind: 'issue', number: 5 })).toThrow(/not issue #5/);
    expect(readHandoff(mkdtempSync(path.join(tmpdir(), 'vr-none-')))).toBeNull();
  });

  it("refuses one that isn't a review's, or lacks a picture", () => {
    for (const bad of [
      { kind: 'x' },
      { number: 0 },
      { head: 'abc' },
      { pictures: ['../x.png'] },
      { assets: ['not an id'] },
      { record: { ...RECORD, fingerprint: 'zz' } },
      { section: 3 },
    ]) {
      const { dir } = handoff(/** @type {never} */ (bad));
      expect(() => readHandoff(dir)).toThrow(/isn't a hand-off/);
    }
    const { dir } = handoff();
    writeFileSync(
      path.join(dir, 'attach.json'),
      JSON.stringify({ ...handoff().h, pictures: ['01.png', '03.png'] }),
    );
    expect(() => readHandoff(dir)).toThrow(/lacks 03\.png/);
  });
});

describe('main', () => {
  it('needs its folder and repository, and attaches nothing when the review handed nothing off', () => {
    expect(() => main({})).toThrow(/needs HANDOFF_DIR/);
    const none = path.join(tmpdir(), 'vr-absent-never-made');
    /** @type {string[]} */
    const asked = [];
    /** @param {number} count */
    const api = (count) => (/** @type {string} */ _m, /** @type {string} */ route) => {
      asked.push(route);
      return { total_count: count };
    };
    const env = {
      HANDOFF_DIR: none,
      GITHUB_REPOSITORY: REPO,
      GITHUB_RUN_ID: '42',
      ARTIFACT: 'visual-review-attach-7',
    };
    expect(main(env, { api: api(0) })).toBeNull();
    expect(asked).toEqual([`repos/${REPO}/actions/runs/42/artifacts?name=visual-review-attach-7`]);
    // A hand-off this run holds but the download lost fails the job.
    expect(() => main(env, { api: api(1) })).toThrow(
      /handed off visual-review-attach-7, but it didn't download/,
    );
  });

  it('needs BOT_PR_TOKEN to upload, and wires the Actions token for the rest', () => {
    const { dir } = handoff();
    expect(() =>
      main({ HANDOFF_DIR: dir, GITHUB_REPOSITORY: REPO, KIND: 'pr', NUMBER: '5' }),
    ).toThrow(/BOT_PR_TOKEN is missing/);
    const { dir: plain } = handoff({ pictures: [], section: 'none' });
    const g = github();
    expect(
      main(
        { HANDOFF_DIR: plain, GITHUB_REPOSITORY: REPO, KIND: 'pr', NUMBER: '5' },
        { api: g.io.api, hide: g.io.hide },
      ),
    ).toBe('written');
    expect(g.edits.map((e) => e.token)).toEqual(['actions']);
  });
});
