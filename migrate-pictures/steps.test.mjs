import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, client, pacer } from './github.mjs';
import { inventory, plan, readMapping, rewrite, undo, upload, verify } from './steps.mjs';
import { comment, emptyRepo, fakeGitHub, issue, pictureRepo } from './test-fakes.mjs';

const APP = 'jbhirsh/app';
const raw = `https://raw.githubusercontent.com/${APP}`;
const meta = {
  repo: APP,
  repos: [APP, 'jbhirsh/ci'],
  branch: 'screenshots',
  legacy: 'pr-screenshots',
};

function fakeClock() {
  let t = 0;
  return { now: () => t, wait: async (/** @type {number} */ ms) => void (t += ms) };
}

/** @type {ReturnType<typeof pictureRepo>} */
let origin;
/** @type {Record<string, import('./test-fakes.mjs').RepoData>} */
let data;
/** @type {ReturnType<typeof fakeGitHub>} */
let github;
/** @type {string} */
let state;
/** @type {string[]} */
let lines;
/** @type {string[][]} */
let ghCalls;

/** @param {{ deadline?: number }} [options] */
function context({ deadline = Infinity } = {}) {
  const clock = fakeClock();
  const log = (/** @type {string} */ line) => void lines.push(line);
  return {
    state,
    log,
    clock,
    deadline,
    remote: origin.dir,
    fetch: github.fetch,
    api: client({ fetch: github.fetch, clock, log, pace: pacer({ clock, deadline }) }),
    /** gh's `pr edit --attach`: each `](./file)` becomes an attachment link. */
    gh: (/** @type {string[]} */ args, /** @type {string} */ cwd) => {
      ghCalls.push(args);
      const body = readFileSync(path.join(cwd, args[args.indexOf('--body-file') + 1]), 'utf8');
      const host = data[APP].issues.find((it) => it.number === Number(args[2]));
      /** @type {import('./test-fakes.mjs').Item} */ (host).body = body.replace(
        /\]\(\.\/([0-9a-f]{8})[0-9a-f]*\.\w+\)/g,
        (_, id) => `](https://github.com/user-attachments/assets/att-${id})`,
      );
    },
  };
}

beforeEach(() => {
  origin = pictureRepo();
  const short = origin.first.slice(0, 7);
  const app = emptyRepo();
  app.issues.push(
    issue(
      APP,
      1,
      `![a](${raw}/${origin.tip}/carousel/a.png)\n![b](${raw}/pr-screenshots/199/before.png)\n![readme](${raw}/${origin.main}/README.md)`,
    ),
    issue(APP, 2, `![b](${raw}/screenshots/199/before.png)`, { pr: false, author: 'someone' }),
    issue(APP, 9, 'the host', {}),
  );
  app['issues/comments'].push(
    comment(
      APP,
      10,
      `old: ${raw}/${short}/199/old.png, folder: https://github.com/${APP}/tree/${origin.tip}/carousel`,
      'github-actions[bot]',
    ),
  );
  app['pulls/comments'].push(comment(APP, 30, `${raw}/${origin.tip}/carousel/missing.png`));
  app.reviews[1] = [comment(APP, 20, `${raw}/${origin.tip}/vercel.json`), comment(APP, 21, '')];
  app.releases.push(comment(APP, 50, null));
  const ci = emptyRepo();
  ci.comments.push(comment('jbhirsh/ci', 40, `${raw}/${origin.tip}/carousel/a.png`));
  data = { [APP]: app, 'jbhirsh/ci': ci };
  github = fakeGitHub(data);
  github.refuse.add('jbhirsh/ci/comments/40');
  state = mkdtempSync(path.join(tmpdir(), 'migrate-pictures-state-'));
  lines = [];
  ghCalls = [];
});

describe('the migration, step by step', () => {
  it('inventories, plans, uploads, rewrites, verifies and undoes', async () => {
    const found = await inventory(context(), meta);
    expect(existsSync(path.join(state, 'pictures.bundle'))).toBe(true);
    expect(found.tip).toBe(origin.tip);
    expect(found.files.map((f) => f.path).sort()).toEqual([
      '199/before.png',
      'carousel/a.png',
      'vercel.json',
    ]);
    expect(found.kept).toEqual({ [origin.main]: 1 });
    const statuses = Object.fromEntries(
      found.posts.map((p) => [p.key, p.links.map((l) => l.status)]),
    );
    expect(found.posts.map((p) => p.key).sort()).toEqual(
      [
        'jbhirsh__ci__commit-comment-40',
        'jbhirsh__app__issue-1',
        'jbhirsh__app__issue-2',
        'jbhirsh__app__issue-comment-10',
        'jbhirsh__app__review-20',
        'jbhirsh__app__review-comment-30',
      ].sort(),
    );
    const one = /** @type {import('./plan.mjs').LinkedPost} */ (
      found.posts.find((p) => p.key === 'jbhirsh__app__issue-1')
    );
    expect(one.links.map((l) => [l.status, l.repaired ?? false])).toEqual([
      ['migrate', false],
      ['migrate', true],
    ]);
    expect(statuses['jbhirsh__app__issue-comment-10']).toEqual(['migrate', 'listed']);
    expect(statuses['jbhirsh__app__review-comment-30']).toEqual(['unresolved']);

    const report = plan(context(), { host: 9, includeOthers: false });
    expect(report).toContain('| Distinct pictures to upload | 3 ');
    expect(report).toContain("vercel.json`: .json isn't a picture GitHub attaches");
    expect(report).toContain('by `someone`');
    expect(report).toContain("#9's description");
    const planned = JSON.parse(readFileSync(path.join(state, 'plan.json'), 'utf8'));
    expect(planned.rewrite.sort()).toEqual([
      'jbhirsh__app__issue-1',
      'jbhirsh__app__issue-comment-10',
      'jbhirsh__ci__commit-comment-40',
    ]);

    // Out of time after the first batch of two; a second run carries on.
    const clocked = context({ deadline: 0 });
    expect(await upload(clocked, { host: 9, batch: 2 })).toBe(1);
    expect(readMapping(state).size).toBe(2);
    expect(await upload(context(), { host: 9, batch: 2 })).toBe(0);
    expect(readMapping(state).size).toBe(3);
    expect(ghCalls).toHaveLength(2);
    expect(ghCalls[1].filter((a) => a === '--attach')).toHaveLength(1);
    // Nothing left: no gh call.
    expect(await upload(context(), { host: 9 })).toBe(0);
    expect(ghCalls).toHaveLength(2);
    expect(JSON.parse(readFileSync(path.join(state, 'host.json'), 'utf8'))).toEqual({
      pr: 9,
      repo: APP,
      original: 'the host',
    });

    expect(await rewrite(context())).toBe(1);
    const body1 = String(data[APP].issues[0].body);
    expect(body1).not.toContain('carousel/a.png');
    expect(body1).not.toContain('pr-screenshots');
    expect(body1).toContain(`${raw}/${origin.main}/README.md`);
    expect(body1.match(/user-attachments\/assets\/att-/g)).toHaveLength(2);
    const body10 = String(data[APP]['issues/comments'][0].body);
    expect(body10).toMatch(
      /^old: https:\/\/github\.com\/user-attachments\/assets\/att-\w+, folder: https:\/\/github\.com\/jbhirsh\/app\/tree\//,
    );
    expect(String(data[APP].issues[1].body)).toContain('raw.githubusercontent');
    const rewriteReport = readFileSync(path.join(state, 'rewrite.md'), 'utf8');
    expect(rewriteReport).toContain('Rewrote 2 post(s)');
    expect(rewriteReport).toContain(
      'GitHub refused the edit, 403 (Resource not accessible by personal access token)',
    );
    expect(readdirSync(path.join(state, 'posts')).sort()).toEqual([
      'jbhirsh__app__issue-1.json',
      'jbhirsh__app__issue-comment-10.json',
    ]);

    // Again: nothing to do, and the saved originals stay the originals.
    const writes = github.writes.length;
    await rewrite(context());
    expect(github.writes.length).toBe(writes);
    const saved = JSON.parse(
      readFileSync(path.join(state, 'posts/jbhirsh__app__issue-1.json'), 'utf8'),
    );
    expect(saved.original).toContain('carousel/a.png');
    expect(saved.written).toBe(body1);

    github.dead.add(/** @type {string} */ ([...readMapping(state).values()][0]));
    expect(await verify(context())).toBe(1);
    const verifyReport = readFileSync(path.join(state, 'verify.md'), 'utf8');
    expect(verifyReport).toContain('**Not ready');
    expect(verifyReport).toContain('Still linking picture history (5)');
    expect(verifyReport).toContain("Attachments that don't answer signed out (1)");
    expect(verifyReport).not.toContain('Changed since the rewrite');

    // Someone edits comment 10; undo restores PR 1 and lists the comment.
    data[APP]['issues/comments'][0].body = 'edited by hand';
    expect(await verify(context())).toBe(1);
    expect(readFileSync(path.join(state, 'verify.md'), 'utf8')).toContain(
      'Changed since the rewrite (1)',
    );
    expect(await undo(context())).toBe(1);
    expect(data[APP].issues[0].body).toBe(saved.original);
    expect(data[APP]['issues/comments'][0].body).toBe('edited by hand');
    expect(readFileSync(path.join(state, 'undo.md'), 'utf8')).toContain(
      'Restored 2 post(s); 0 already held their original; 1 left as they are',
    );
    expect(await undo(context())).toBe(1);
    expect(readFileSync(path.join(state, 'undo.md'), 'utf8')).toContain(
      'Restored 0 post(s); 1 already held',
    );
  });

  it('includes others when asked, and verifies a clean migration as ready', async () => {
    data[APP]['issues/comments'][0].body = `${raw}/${origin.tip}/carousel/a.png`;
    data[APP].reviews[1] = [];
    data[APP]['pulls/comments'] = [];
    data['jbhirsh/ci'].comments = [];
    await inventory(context(), meta);
    plan(context(), { host: null, includeOthers: true });
    await upload(context(), { host: 9 });
    expect(await rewrite(context())).toBe(0);
    expect(String(data[APP].issues[1].body)).toContain('user-attachments');
    expect(await verify(context())).toBe(0);
    const report = readFileSync(path.join(state, 'verify.md'), 'utf8');
    expect(report).toContain('**Ready.**');
    expect(report).toContain(`git push origin ${origin.tip}:refs/heads/screenshots`);
    expect(report).toContain('| Branch files no post linked (only in the bundle) | 1 |');
  });

  it('says which step comes first, and refuses an issue as the host', async () => {
    await expect(
      Promise.resolve().then(() => plan(context(), { host: null, includeOthers: false })),
    ).rejects.toThrow(/no inventory\.json in the state: run inventory first/);
    await inventory(context(), meta);
    plan(context(), { host: null, includeOthers: false });
    await expect(upload(context(), { host: 2 })).rejects.toThrow(/is an issue/);
    await expect(rewrite(context())).rejects.toThrow(/nothing uploaded yet/);
  });

  it('keeps what a failed batch did link, and fails saying to run again', async () => {
    await inventory(context(), meta);
    plan(context(), { host: null, includeOthers: false });
    const ctx = context();
    const gh = ctx.gh;
    ctx.gh = (args, cwd) => {
      gh(args, cwd);
      const host = /** @type {import('./test-fakes.mjs').Item} */ (
        data[APP].issues.find((it) => it.number === 9)
      );
      // gh linked only the first picture.
      host.body = String(host.body).split('\n').slice(0, 3).join('\n');
    };
    await expect(upload(ctx, { host: 9 })).rejects.toThrow(/left 2 of 3 pictures unlinked/);
    expect(readMapping(state).size).toBe(1);
  });

  it('writes the undo of a post it never rewrote as nothing', async () => {
    writeFileSync(path.join(state, 'meta.json'), '{}');
    expect(await undo(context())).toBe(0);
    expect(readFileSync(path.join(state, 'undo.md'), 'utf8')).toContain('Restored 0 post(s)');
  });
  it('reports a post gone since the inventory, in rewrite, verify and undo, and goes on', async () => {
    data['jbhirsh/ci'].comments = [];
    await inventory(context(), meta);
    plan(context(), { host: null, includeOthers: false });
    await upload(context(), { host: 9 });
    // Comment 10 is deleted before the rewrite.
    const [gone] = data[APP]['issues/comments'].splice(0, 1);
    expect(await rewrite(context())).toBe(1);
    expect(readFileSync(path.join(state, 'rewrite.md'), 'utf8')).toContain(
      '404 (Not Found) reading it: gone or hidden',
    );
    expect(String(data[APP].issues[0].body)).toContain('user-attachments');
    // It comes back rewritten by hand, then PR 1 is deleted.
    data[APP]['issues/comments'].push({ ...gone, body: 'by hand' });
    const [pr1] = data[APP].issues.splice(0, 1);
    expect(await verify(context())).toBe(1);
    expect(readFileSync(path.join(state, 'verify.md'), 'utf8')).toContain(
      '404 (Not Found) reading it: gone or hidden',
    );
    expect(await undo(context())).toBe(1);
    expect(readFileSync(path.join(state, 'undo.md'), 'utf8')).toContain(
      '404 (Not Found) reading or editing it',
    );
    // Back again: undo restores it.
    data[APP].issues.unshift(pr1);
    expect(await undo(context())).toBe(0);
    expect(String(data[APP].issues[0].body)).toContain('carousel/a.png');
  });

  it('stops undo cleanly when its time is up', async () => {
    data['jbhirsh/ci'].comments = [];
    await inventory(context(), meta);
    plan(context(), { host: null, includeOthers: false });
    await upload(context(), { host: 9 });
    await rewrite(context());
    expect(await undo(context({ deadline: -1 }))).toBe(1);
    expect(readFileSync(path.join(state, 'undo.md'), 'utf8')).toContain('Out of time');
  });

  it("leaves an edit that failed some other way saved, and verify doesn't call it changed", async () => {
    data['jbhirsh/ci'].comments = [];
    await inventory(context(), meta);
    plan(context(), { host: null, includeOthers: false });
    await upload(context(), { host: 9 });
    await expect(rewrite(context({ deadline: -1 }))).resolves.toBe(0);
    expect(readFileSync(path.join(state, 'rewrite.md'), 'utf8')).toContain('Out of time');
    expect(readdirSync(path.join(state, 'posts'))).toHaveLength(1);
    await verify(context());
    expect(readFileSync(path.join(state, 'verify.md'), 'utf8')).not.toContain('Changed since');
  });
  it('refuses a host that links pictures, or another host than the uploads went to', async () => {
    await inventory(context(), meta);
    plan(context(), { host: null, includeOthers: false });
    await expect(upload(context(), { host: 1 })).rejects.toThrow(
      /#1 links pictures the migration rewrites/,
    );
    data[APP].issues.push(issue(APP, 8, 'another host'));
    await upload(context(), { host: 9 });
    await expect(upload(context(), { host: 8 })).rejects.toThrow(/went to #9: pass host-pr 9/);
  });

  it("won't rewrite again a post edited by hand since an earlier rewrite", async () => {
    data['jbhirsh/ci'].comments = [];
    await inventory(context(), meta);
    plan(context(), { host: null, includeOthers: false });
    // Only some pictures are up when the first rewrite runs.
    const ctx = context();
    const gh = ctx.gh;
    ctx.gh = (args, cwd) => {
      gh(args, cwd);
      const host = /** @type {import('./test-fakes.mjs').Item} */ (
        data[APP].issues.find((it) => it.number === 9)
      );
      host.body = String(host.body).split('\n').slice(0, 3).join('\n');
    };
    await expect(upload(ctx, { host: 9 })).rejects.toThrow(/unlinked/);
    await rewrite(context());
    const pr1 = data[APP].issues[0];
    pr1.body = `${pr1.body}\nan edit by hand`;
    await upload(context(), { host: 9 });
    expect(await rewrite(context())).toBe(1);
    expect(readFileSync(path.join(state, 'rewrite.md'), 'utf8')).toContain(
      'edited since an earlier rewrite',
    );
    expect(String(pr1.body)).toContain('an edit by hand');
  });

  it('stops on a rate limit that outlasts the retries, rather than calling it a refusal', async () => {
    data['jbhirsh/ci'].comments = [];
    await inventory(context(), meta);
    plan(context(), { host: null, includeOthers: false });
    await upload(context(), { host: 9 });
    const ctx = context();
    const real = ctx.api;
    ctx.api = {
      ...real,
      write: async () => {
        throw new ApiError('limited', 403, { limited: true });
      },
    };
    await expect(rewrite(ctx)).rejects.toThrow('limited');
  });
});
