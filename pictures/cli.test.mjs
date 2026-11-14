import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTACH_LIMIT } from '../lib/attach.mjs';
import { main } from './cli.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const ASSET = 'https://github.com/user-attachments/assets/';

/**
 * The artifact's folder, holding these PNGs.
 *
 * @param {readonly string[]} names
 */
function artifact(names) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pictures-cli-'));
  for (const name of names) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), PNG);
  }
  return dir;
}

/**
 * A fake gh over a repository's issues and PRs (their descriptions), which
 * `--attach` rewrites as gh's manual says: each local reference to an
 * attached file becomes its URL. Records every call.
 *
 * @param {Record<string, { pr: boolean; body: string }>} posts
 * @param {{ keepLocal?: boolean; failAttach?: boolean; extraLink?: boolean }} [opts]
 */
function fakeGh(posts, opts = {}) {
  /** @type {string[][]} */
  const calls = [];
  let uploads = 0;
  /** @type {import('../lib/gh.mjs').Command} */
  const gh = (args) => {
    calls.push(args);
    const ok = (/** @type {unknown} */ value) => ({
      status: 0,
      stdout: value === undefined ? '' : `${JSON.stringify(value)}\n`,
      stderr: '',
    });
    if (args[0] === 'api') {
      const n = /** @type {string} */ (args[1].split('/').at(-1));
      const post = posts[n];
      if (!post) throw new Error('gh api failed: HTTP 404: Not Found');
      return ok({
        html_url: `https://github.com/o/r/${post.pr ? 'pull' : 'issues'}/${n}`,
        ...(post.pr ? { pull_request: { url: '…' } } : {}),
      });
    }
    const [kind, verb, n] = args;
    const post = posts[n];
    if (post.pr !== (kind === 'pr')) throw new Error(`gh ${kind} ${verb}: #${n} is not a ${kind}`);
    if (verb === 'view') return ok({ body: post.body });
    const attach = args.filter((_, i) => args[i - 1] === '--attach');
    if (attach.length > 0 && opts.failAttach) throw new Error('gh pr failed: HTTP 422');
    let next = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
    for (const file of attach) {
      if (!opts.keepLocal) next = next.replaceAll(`](${file})`, `](${ASSET}${(uploads += 1)})`);
    }
    if (opts.extraLink && attach.length > 0)
      next = next.replace('Pictures for', `${ASSET}x Pictures for`);
    post.body = next;
    return ok(undefined);
  };
  return { gh, calls };
}

const env = {
  REPO: 'o/r',
  TARGET: '222',
  HOST_PR: '240',
  RUN_ID: '99',
  ARTIFACT: 'ios-screenshots',
  FILES: 'light.png | Light\ndark.png | Dark',
  BLOCK: '222',
  GH_TOKEN: 'token',
};

/**
 * Runs main with every link answering at once.
 *
 * @param {Record<string, string | undefined>} values
 * @param {string} cwd
 * @param {ReturnType<typeof fakeGh>} fake
 */
async function run(values, cwd, fake) {
  /** @type {string[]} */
  const logs = [];
  /** @type {string[]} */
  const fetched = [];
  const fetch = /** @type {typeof globalThis.fetch} */ (
    /** @type {unknown} */ (
      async (/** @type {string} */ link) => {
        fetched.push(link);
        return new Response('PNG', { status: 200 });
      }
    )
  );
  const url = await main({
    env: values,
    cwd,
    gh: fake.gh,
    fetch,
    wait: async () => {},
    log: (l) => logs.push(l),
  });
  return { url, logs, fetched };
}

/** @param {string[][]} calls */
const verbs = (calls) =>
  calls.map((c) => (c[0] === 'api' ? `api ${c[1]}` : c.slice(0, 3).join(' ')));

describe('main', () => {
  it('uploads to the host PR, then links the pictures into an issue', async () => {
    const cwd = artifact(['light.png', 'dark.png']);
    const posts = { 240: { pr: true, body: 'Host.' }, 222: { pr: false, body: 'The plan.' } };
    const fake = fakeGh(posts);
    const { url, logs, fetched } = await run(env, cwd, fake);
    expect(verbs(fake.calls)).toEqual([
      'api repos/o/r/issues/240',
      'api repos/o/r/issues/222',
      'pr view 240',
      'pr edit 240',
      'pr view 240',
      'issue view 222',
      'issue edit 222',
    ]);
    // The upload is the host's alone; the issue's edit attaches nothing.
    expect(fake.calls[3].filter((a) => a.startsWith('./'))).toEqual(['./light.png', './dark.png']);
    expect(fake.calls[6]).toEqual([
      'issue',
      'edit',
      '222',
      '--repo',
      'o/r',
      '--body-file',
      path.join(cwd, '.pictures-target-222.md'),
    ]);
    expect(posts[240].body).toBe(
      [
        'Host.',
        '',
        '<!-- pictures:222 -->',
        'Pictures for #222, from run 99.',
        '',
        `![light.png](${ASSET}1)`,
        `![dark.png](${ASSET}2)`,
        '<!-- /pictures:222 -->',
        '',
      ].join('\n'),
    );
    expect(posts[222].body).toBe(
      [
        'The plan.',
        '',
        '<!-- pictures:222 -->',
        '| Light | Dark |',
        '| --- | --- |',
        `| <img src="${ASSET}1" width="300" alt="Light"> | <img src="${ASSET}2" width="300" alt="Dark"> |`,
        '<!-- /pictures:222 -->',
        '',
      ].join('\n'),
    );
    expect(fetched).toEqual([`${ASSET}1`, `${ASSET}2`]);
    expect(url).toBe('https://github.com/o/r/issues/222');
    expect(logs).toEqual([
      "pictures: attached 2 pictures to #240's description",
      'pictures: 2 picture(s) in https://github.com/o/r/issues/222',
    ]);
    expect(() => readFileSync(path.join(cwd, '.pictures-target-222.md'))).toThrow();
  });

  it('replaces an earlier block in place, in the host and the target', async () => {
    const cwd = artifact(['light.png', 'dark.png']);
    const posts = { 240: { pr: true, body: '' }, 222: { pr: false, body: 'Plan.' } };
    await run(env, cwd, fakeGh(posts));
    posts[222].body += '\nA later note.';
    await run({ ...env, FILES: 'dark.png' }, cwd, fakeGh(posts));
    expect(posts[222].body.match(/<!-- pictures:222 -->/g)).toHaveLength(1);
    expect(posts[222].body).toMatch(/^Plan\.\n\n<!-- pictures:222 -->\n\| dark\.png \|\n/);
    expect(posts[222].body.endsWith('<!-- /pictures:222 -->\n\nA later note.')).toBe(true);
    expect(posts[240].body.match(/<!-- pictures:222 -->/g)).toHaveLength(1);
  });

  it('edits a PR target with gh pr, with no --attach', async () => {
    const cwd = artifact(['light.png', 'dark.png']);
    const posts = { 240: { pr: true, body: '' }, 300: { pr: true, body: 'A PR.' } };
    const fake = fakeGh(posts);
    const { url } = await run({ ...env, TARGET: '300', COLUMNS: '1', WIDTH: '200' }, cwd, fake);
    expect(verbs(fake.calls).slice(-2)).toEqual(['pr view 300', 'pr edit 300']);
    expect(fake.calls.at(-1)?.includes('--attach')).toBe(false);
    expect(posts[300].body).toContain(
      `| <img src="${ASSET}1" width="200" alt="Light"> |\n| **Dark** |`,
    );
    expect(url).toBe('https://github.com/o/r/pull/300');
  });

  it('turns the host’s own block into the table when the host is the target', async () => {
    const cwd = artifact(['light.png', 'dark.png']);
    const posts = { 240: { pr: true, body: 'Host.' } };
    const fake = fakeGh(posts);
    await run({ ...env, TARGET: '240' }, cwd, fake);
    expect(verbs(fake.calls)).toEqual([
      'api repos/o/r/issues/240',
      'pr view 240',
      'pr edit 240',
      'pr view 240',
      'pr view 240',
      'pr edit 240',
    ]);
    expect(posts[240].body).toContain('| Light | Dark |');
    expect(posts[240].body).not.toContain('![light.png]');
  });

  it(`uploads more than ${ATTACH_LIMIT} in batches, and links them all in order`, async () => {
    const names = Array.from({ length: ATTACH_LIMIT + 3 }, (_, i) => `s/${i}.png`);
    const cwd = artifact(names);
    const posts = { 240: { pr: true, body: '' }, 222: { pr: false, body: '' } };
    const fake = fakeGh(posts);
    const { fetched } = await run({ ...env, FILES: names.join('\n'), COLUMNS: '4' }, cwd, fake);
    const edits = fake.calls.filter((c) => c[0] === 'pr' && c[1] === 'edit');
    expect(edits.map((c) => c.filter((a) => a === '--attach').length)).toEqual([ATTACH_LIMIT, 3]);
    expect(fetched).toEqual(names.map((_, i) => `${ASSET}${i + 1}`));
    expect(posts[222].body).toContain(`alt="${ATTACH_LIMIT + 2}.png"`);
  });

  it('stops when the host’s block links other than one attachment a file', async () => {
    const cwd = artifact(['light.png', 'dark.png']);
    const posts = () => ({ 240: { pr: true, body: '' }, 222: { pr: false, body: 'Plan.' } });
    const extra = posts();
    await expect(run(env, cwd, fakeGh(extra, { extraLink: true }))).rejects.toThrow(
      "pictures: #240's pictures:222 block links 3 attachment(s), not the 2 attached",
    );
    expect(extra[222].body).toBe('Plan.');
    // A host whose block went missing meanwhile links none.
    const gone = posts();
    const fake = fakeGh(gone);
    /** @type {import('../lib/gh.mjs').Command} */
    const gh = (args, options) => {
      const out = fake.gh(args, options);
      if (args[1] === 'edit') gone[240].body = 'Someone else’s edit.';
      return out;
    };
    await expect(run(env, cwd, { gh, calls: [] })).rejects.toThrow(
      'block links 0 attachment(s), not the 2 attached',
    );
  });

  it('minds only its own block on a shared host, not an earlier run’s leftover', async () => {
    const cwd = artifact(['light.png', 'dark.png']);
    // Another block, left by a run that failed, still references light.png locally.
    const leftover = '<!-- pictures:old -->\n![light.png](./light.png)\n<!-- /pictures:old -->';
    const posts = { 240: { pr: true, body: leftover }, 222: { pr: false, body: '' } };
    /** @type {import('../lib/gh.mjs').Command} */
    const gh = (args, options) => {
      const fake = fakeGh(posts);
      if (args[1] !== 'edit' || !args.includes('--attach')) return fake.gh(args, options);
      // gh rewrites the references in this run's block, past the leftover.
      const [head, ...rest] = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8').split(
        '<!-- pictures:222 -->',
      );
      const file = path.join(cwd, 'tail.md');
      writeFileSync(file, rest.join('<!-- pictures:222 -->'));
      const tail = [...args];
      tail[tail.indexOf('--body-file') + 1] = file;
      fake.gh(tail, options);
      posts[240].body = `${head}<!-- pictures:222 -->${posts[240].body}`;
      return { status: 0, stdout: '', stderr: '' };
    };
    const { url } = await run(env, cwd, { gh, calls: [] });
    expect(url).toBe('https://github.com/o/r/issues/222');
    expect(posts[240].body.startsWith(leftover)).toBe(true);
    expect(posts[222].body).toContain(`alt="Light"`);
  });

  it('says how far an upload got when it fails, and edits no target', async () => {
    const cwd = artifact(['light.png', 'dark.png']);
    const posts = { 240: { pr: true, body: '' }, 222: { pr: false, body: 'Plan.' } };
    await expect(run(env, cwd, fakeGh(posts, { failAttach: true }))).rejects.toThrow(
      'pictures: attaching to #240 stopped after 0 of 2 pictures',
    );
    await expect(run(env, cwd, fakeGh(posts, { keepLocal: true }))).rejects.toThrow(
      'pictures: gh uploaded the pictures but left light.png, dark.png referenced locally',
    );
    expect(posts[222].body).toBe('Plan.');
  });

  it('stops before anything is edited on a bad input, file, token or host', async () => {
    const cwd = artifact(['light.png']);
    writeFileSync(path.join(cwd, 'dark.png'), 'not a picture');
    const posts = {
      240: { pr: true, body: '' },
      222: { pr: false, body: '' },
      7: { pr: false, body: '' },
    };
    const fake = fakeGh(posts);
    await expect(run({ ...env, HOST_PR: '' }, cwd, fake)).rejects.toThrow('pictures: HOST_PR is');
    await expect(run({ ...env, GH_TOKEN: '' }, cwd, fake)).rejects.toThrow(
      'pictures: no token to attach with',
    );
    await expect(run(env, cwd, fake)).rejects.toThrow("pictures: dark.png isn't a PNG");
    expect(fake.calls).toEqual([]);
    await expect(run({ ...env, FILES: 'light.png', HOST_PR: '7' }, cwd, fake)).rejects.toThrow(
      'pictures: HOST_PR #7 is an issue, not a PR',
    );
    expect(verbs(fake.calls)).toEqual(['api repos/o/r/issues/7']);
  });
});
