import { describe, expect, it } from 'vitest';
import { hashOf, images, indexText, readIndex } from './counts.mjs';
import { putBlock } from './changes.mjs';
import {
  changes,
  fetchVerify,
  gitHubIo,
  ghUpload,
  main,
  MAX_PAIRS,
  pairsAt,
  uploadAllowed,
} from './run.mjs';

const REPO = 'jbhirsh/app';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const SLOT = '<!-- pr-changes:change:1 -->\n<!-- /pr-changes:change:1 -->';

/** @param {Record<string, unknown>} routes */
function fakeApi(routes) {
  /** @type {{ method: string, route: string, body?: unknown }[]} */
  const calls = [];
  /** @type {import('../lib/comment.mjs').Api} */
  const api = (method, route, body) => {
    calls.push({ method, route, body });
    const key = `${method} ${route}`;
    if (!(key in routes)) throw new Error(`unexpected ${key}`);
    return routes[key];
  };
  return { api, calls };
}

const routes = {
  [`GET repos/${REPO}/issues/5`]: { body: `## Changes\n\n${SLOT}\n` },
  [`GET repos/${REPO}/pulls/5/commits?per_page=100&page=1`]: [
    { sha: A, commit: { message: 'Add a\n\nbody' }, parents: [1], author: { login: 'jbhirsh' } },
    {
      sha: B,
      commit: { message: 'Refresh baselines' },
      parents: [1],
      author: { login: 'app[bot]' },
    },
    { sha: C, commit: { message: 'Merge main' }, parents: [1, 2], author: { login: 'jbhirsh' } },
    {
      sha: D,
      commit: { message: 'Bot, no author' },
      parents: [1],
      author: null,
      committer: { login: 'x[bot]' },
    },
  ],
  [`GET repos/${REPO}/commits/${A}?per_page=100&page=1`]: {
    files: [{ filename: 'src/a.ts', additions: 3, deletions: 1 }],
  },
  [`PATCH repos/${REPO}/issues/5`]: {},
};

describe('gitHubIo', () => {
  it("reads the commits except a bot's and a merge, with their files, and writes the description", () => {
    const { api, calls } = fakeApi(routes);
    const io = gitHubIo({ api, repo: REPO, number: 5, log: () => {} });
    expect(io.commits()).toEqual([
      { sha: A, subject: 'Add a', files: [{ path: 'src/a.ts', added: 3, removed: 1 }] },
    ]);
    io.write('new');
    expect(calls.at(-1)).toEqual({
      method: 'PATCH',
      route: `repos/${REPO}/issues/5`,
      body: { body: 'new' },
    });
  });
});

/**
 * The link a picture gets when "uploaded": made from its hash alone, in
 * GitHub's attachment form.
 *
 * @param {string} sha
 */
const linkFor = (sha) =>
  `https://github.com/user-attachments/assets/${sha.slice(0, 8)}-0000-0000-0000-${sha.slice(8, 20)}`;

/**
 * An io over a description held in memory, and an upload that does what gh's
 * `--attach` does: it rewrites each `](./file)` to a link.
 *
 * @param {{ body: string, files?: [string, number, number][][], verify?: (link: string, sha: string) => boolean,
 *   upload?: boolean, ownEdit?: boolean, rewrite?: (file: string) => string | null, fail?: boolean }} options
 */
function fakeIo({
  body,
  files = [[['src/a.ts', 3, 1]]],
  verify = () => true,
  upload = true,
  ownEdit = false,
  rewrite,
  fail = false,
}) {
  const state = {
    body,
    /** @type {string[]} */ writes: [],
    /** @type {string[][]} */ uploads: [],
    /** @type {string[]} */ log: [],
    /** @type {string[]} */ verified: [],
  };
  const commits = files.map((fs, i) => ({
    sha: `${i}`.repeat(40),
    subject: `Change ${i + 1}`,
    files: fs.map(([path, added, removed]) => ({ path, added, removed })),
  }));
  /** @type {import('./run.mjs').Io} */
  const io = {
    body: () => state.body,
    write: (b) => {
      state.writes.push(b);
      state.body = b;
    },
    commits: () => commits,
    verify: async (link, sha) => {
      state.verified.push(link);
      return verify(link, sha);
    },
    upload: upload
      ? (list, staged) => {
          if (fail) throw new Error('gh failed');
          state.uploads.push(list.map((f) => f.file));
          const after = staged.replace(/\]\(\.\/([0-9a-f]{64}-\d+\.svg)\)/g, (m, file) => {
            const link = rewrite ? rewrite(file) : linkFor(file.slice(0, 64));
            return link === null ? m : `](${link})`;
          });
          // gh overwrites the description with what it was given, and what it
          // returns is the description as it then is.
          state.body = after;
          return state.body;
        }
      : null,
    ownEdit,
    log: (line) => state.log.push(line),
  };
  return { io, state };
}

const WHERE = { repo: REPO, number: 5 };
const DESC = `## Changes\n\n${SLOT}\n`;

describe('changes', () => {
  it('draws the counts as pictures, uploading each distinct pair once, and writes once', async () => {
    const { io, state } = fakeIo({ body: DESC });
    expect(await changes(io, WHERE)).toBe(true);
    // One pair (+3 −1) in the title and on the one file: two images, uploaded once.
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0]).toHaveLength(2);
    for (const file of state.uploads[0]) expect(file).toMatch(/^[0-9a-f]{64}-(12|14)\.svg$/);
    expect(state.writes).toHaveLength(1);
    const out = state.body;
    expect(out).toContain('<picture>');
    expect(out).toContain('alt="+3 −1"');
    expect(out).not.toContain('<!-- pr-changes:staging -->');
    expect(out).not.toContain('](./');
    expect(readIndex(out).size).toBe(2);
  });

  it('writes nothing the second time, and uploads nothing', async () => {
    const { io, state } = fakeIo({ body: DESC });
    await changes(io, WHERE);
    state.uploads.length = 0;
    const before = state.writes.length;
    expect(await changes(io, WHERE)).toBe(false);
    expect(state.uploads).toHaveLength(0);
    expect(state.writes).toHaveLength(before);
  });

  it('reuses a picture the index names, once its bytes check out, with no upload', async () => {
    const [small, large] = images(3, 1);
    const links = new Map([
      [small.sha, linkFor(small.sha)],
      [large.sha, linkFor(large.sha)],
    ]);
    const body = `${DESC}\n${putBlock('', 'index', indexText(links))}`;
    const { io, state } = fakeIo({ body, verify: (_link, sha) => links.has(sha) });
    await changes(io, WHERE);
    expect(state.uploads).toHaveLength(0);
    expect(state.body).toContain(linkFor(small.sha));
    expect(state.verified).toHaveLength(2);
  });

  it('uploads again a picture whose link does not answer with its bytes', async () => {
    const [small, large] = images(3, 1);
    const stale = new Map([
      [small.sha, linkFor(small.sha)],
      [large.sha, linkFor(large.sha)],
    ]);
    const body = `${DESC}\n${putBlock('', 'index', indexText(stale))}`;
    const { io, state } = fakeIo({ body, verify: () => false });
    await changes(io, WHERE);
    expect(state.uploads).toHaveLength(1);
    expect(state.body).toContain('<picture>');
  });

  it('keeps a picture the description shows when a run that may not upload cannot verify it', async () => {
    const [small, large] = images(3, 1);
    const links = new Map([
      [small.sha, linkFor(small.sha)],
      [large.sha, linkFor(large.sha)],
    ]);
    const body = `${DESC}\n${putBlock('', 'index', indexText(links))}`;
    // The first run draws and indexes them.
    const first = fakeIo({ body, verify: () => true });
    await changes(first.io, WHERE);
    expect(first.state.body).toContain('<picture>');
    // The run the upload's own edit wakes may not upload, and the link's fetch fails.
    const second = fakeIo({ body: first.state.body, verify: () => false, upload: false });
    await changes(second.io, WHERE);
    expect(second.state.uploads).toHaveLength(0);
    // Nothing is written: the description, pictures and index, is what it was.
    expect(second.state.writes).toEqual([]);
    expect(second.state.body).toBe(first.state.body);
    expect(second.state.log.join('\n')).toMatch(/kept a picture the description shows/);
  });

  it("draws the counts for an edit from the token's own account, and its own edit then does nothing", async () => {
    // An author's edit, made with the token's account, before anything was uploaded.
    const first = fakeIo({ body: DESC, ownEdit: true });
    await changes(first.io, WHERE);
    expect(first.state.uploads).toHaveLength(1);
    expect(first.state.body).toContain('<picture>');
    // The upload's own edit wakes a run that finds the index: nothing to upload or write,
    // whatever its fetch of a link says.
    const second = fakeIo({ body: first.state.body, verify: () => false, ownEdit: true });
    await changes(second.io, WHERE);
    expect(second.state.uploads).toHaveLength(0);
    expect(second.state.writes).toEqual([]);
    expect(second.state.body).toBe(first.state.body);
  });

  it.each([
    ['throws', { fail: true }],
    ['returns no link', { rewrite: () => null }],
  ])(
    "marks a failed upload, so the run its edit wakes under the token's account tries nothing (%s)",
    async (_name, options) => {
      // The attempt may have edited the description before it failed, which wakes an own-edit run.
      const first = fakeIo({ body: DESC, ...options });
      await changes(first.io, WHERE);
      expect(first.state.uploads.length).toBeLessThanOrEqual(1);
      expect(first.state.body).toContain('pr-changes:index');
      expect(first.state.body).not.toContain('<picture>');
      const second = fakeIo({ body: first.state.body, ownEdit: true, ...options });
      await changes(second.io, WHERE);
      expect(second.state.uploads).toHaveLength(0);
      expect(second.state.writes).toEqual([]);
      // A push's run, which isn't an own edit, tries again.
      const third = fakeIo({ body: first.state.body });
      await changes(third.io, WHERE);
      expect(third.state.uploads).toHaveLength(1);
      expect(third.state.body).toContain('<picture>');
    },
  );

  it('leaves pairs a hand edit added to a description with an index plain, and says so', async () => {
    const drawn = fakeIo({ body: DESC });
    await changes(drawn.io, WHERE);
    const edited = drawn.state.body.replace(
      '<!-- /pr-changes:change:1 -->',
      `<!-- /pr-changes:change:1 -->\n\n${SLOT.replace(/1/g, '2')}`,
    );
    const more = fakeIo({
      body: edited,
      files: [[['src/a.ts', 3, 1]], [['src/b.ts', 5, 0]]],
      ownEdit: true,
    });
    await changes(more.io, WHERE);
    expect(more.state.uploads).toHaveLength(0);
    expect(more.state.log.join('\n')).toMatch(/may not upload/);
  });

  it('still re-attaches a shown picture that fails its check, when the run may upload', async () => {
    const [small, large] = images(3, 1);
    const links = new Map([
      [small.sha, linkFor(small.sha)],
      [large.sha, linkFor(large.sha)],
    ]);
    const first = fakeIo({
      body: `${DESC}\n${putBlock('', 'index', indexText(links))}`,
      verify: () => true,
    });
    await changes(first.io, WHERE);
    const again = fakeIo({ body: first.state.body, verify: () => false });
    await changes(again.io, WHERE);
    expect(again.state.uploads).toHaveLength(1);
  });

  it('still drops, to plain text, a link no picture of the description uses, when it cannot verify it', async () => {
    const [small, large] = images(3, 1);
    const links = new Map([
      [small.sha, linkFor(small.sha)],
      [large.sha, linkFor(large.sha)],
    ]);
    const body = `${DESC}\n${putBlock('', 'index', indexText(links))}`;
    const { io, state } = fakeIo({ body, verify: () => false, upload: false });
    await changes(io, WHERE);
    expect(state.body).not.toContain('<picture>');
    expect(state.body).toContain('+3 −1');
  });

  it('draws only the missing size of a pair that is half there', async () => {
    const [small, large] = images(3, 1);
    const body = `${DESC}\n${putBlock('', 'index', indexText(new Map([[small.sha, linkFor(small.sha)]])))}`;
    const { io, state } = fakeIo({ body, verify: (_l, sha) => sha === small.sha });
    await changes(io, WHERE);
    expect(state.uploads).toEqual([[large.file]]);
  });

  it('never uses a forged index entry: a link of any other form, or one in the wrong place', async () => {
    const [small, large] = images(3, 1);
    const forged = `<!-- ${small.sha}=not-a-link ${large.sha}=${'e'.repeat(36)} -->`;
    const body = `${DESC}\n${putBlock('', 'index', forged)}`;
    // Every fetch would "check out": only what is read decides.
    const { io, state } = fakeIo({ body, verify: () => true });
    await changes(io, WHERE);
    expect(state.verified).toHaveLength(0);
    expect(state.body).not.toContain('not-a-link');
    expect(state.body).not.toContain('e'.repeat(36));
    expect(state.uploads).toHaveLength(1);
  });

  it('ignores a picture planted outside its own blocks', async () => {
    const [small] = images(3, 1);
    const planted = `![${small.sha}](${linkFor('f'.repeat(64))})`;
    const { io, state } = fakeIo({ body: `${DESC}\n${planted}\n`, verify: () => true });
    await changes(io, WHERE);
    expect(state.verified).toHaveLength(0);
    expect(state.body).not.toContain(`srcset="${linkFor('f'.repeat(64))}"`);
    expect(state.uploads).toHaveLength(1);
  });

  it('leaves an example of its markers in a code fence alone, and writes its own block after', async () => {
    const example =
      '```\n<!-- pr-changes:index -->\n<!-- pr-changes:staging -->\n<!-- /pr-changes:staging -->\n<!-- /pr-changes:index -->\n```';
    const { io, state } = fakeIo({ body: `${DESC}\n${example}\n` });
    await changes(io, WHERE);
    expect(state.body).toContain(example);
    expect(readIndex(state.body).size).toBe(2);
    expect(state.body.endsWith('<!-- /pr-changes:index -->\n')).toBe(true);
  });

  it('leaves the counts plain, and says so, when the run may not upload', async () => {
    const { io, state } = fakeIo({ body: DESC, upload: false });
    await changes(io, WHERE);
    expect(state.body).not.toContain('<picture>');
    expect(state.body).toContain('+3 −1');
    expect(state.log.join()).toMatch(/may not upload/);
  });

  it("leaves a pair plain, with no staging block left, when its picture doesn't come back", async () => {
    const { io, state } = fakeIo({ body: DESC, rewrite: () => null });
    await changes(io, WHERE);
    expect(state.body).not.toContain('<picture>');
    expect(state.body).not.toContain('pr-changes:staging');
    expect(state.body).not.toContain('](./');
    expect(state.log.join()).toMatch(/no link came back/);
  });

  it('keeps an edit a person made between the upload and the write', async () => {
    const { io, state } = fakeIo({ body: DESC });
    const upload = io.upload;
    io.upload = (list, staged, was) => {
      const after = /** @type {NonNullable<typeof upload>} */ (upload)(list, staged, was);
      state.body = `Mine, edited.\n${after}`;
      return after;
    };
    await changes(io, WHERE);
    expect(state.body.startsWith('Mine, edited.')).toBe(true);
    expect(state.body).toContain('<picture>');
  });

  it('uploads at most MAX_PAIRS pairs a run, the rest staying plain', async () => {
    const many = Array.from(
      { length: 30 },
      (_, i) => /** @type {[string, number, number]} */ ([`f${i}.ts`, i + 1, 0]),
    );
    const { io, state } = fakeIo({ body: DESC, files: [many] });
    await changes(io, WHERE);
    const uploaded = state.uploads.flat();
    expect(uploaded).toHaveLength(2 * MAX_PAIRS);
    expect(state.log.join()).toMatch(/over the 25 a run uploads/);
    expect(state.body).toContain('+30 −0');
  });

  it('steps down to titles-only pictures, then plain totals, as the description grows', async () => {
    // Ten distinct pairs, so the cap on new pairs a run uploads isn't what limits it.
    const many = Array.from(
      { length: 80 },
      (_, i) => /** @type {[string, number, number]} */ ([`dir/file${i}.ts`, (i % 10) + 1, 1]),
    );
    /** @param {number} pad */
    const run = async (pad) => {
      const { io, state } = fakeIo({ body: `${DESC}\n${'x'.repeat(pad)}\n`, files: [many] });
      await changes(io, WHERE);
      return state.body;
    };
    const full = await run(100);
    expect(full.match(/<picture>/g)?.length).toBeGreaterThan(80);
    const titles = await run(30_000);
    expect(titles.match(/<picture>/g)).toHaveLength(1);
    expect(titles).toContain('files changed <picture>');
    const totals = await run(59_000);
    expect(totals).not.toContain('<picture>');
    expect(totals).not.toContain('<details>');
    for (const out of [full, titles, totals]) expect(out.length).toBeLessThanOrEqual(60_000);
  });

  it('reads the description again before the upload, so an edit made while it checked is kept', async () => {
    const [small, large] = images(3, 1);
    const stale = new Map([
      [small.sha, linkFor(small.sha)],
      [large.sha, linkFor(large.sha)],
    ]);
    const body = `${DESC}\n${putBlock('', 'index', indexText(stale))}`;
    let edited = false;
    const { io, state } = fakeIo({
      body,
      verify: () => {
        // A person saves a change while the links are being checked.
        if (!edited) {
          edited = true;
          state.body = `Edited meanwhile.\n${state.body}`;
        }
        return false;
      },
    });
    await changes(io, WHERE);
    expect(state.body.startsWith('Edited meanwhile.')).toBe(true);
    expect(state.uploads).toHaveLength(1);
  });

  it('keeps the counts plain, warns, and leaves no staging block, when the upload fails', async () => {
    const { io, state } = fakeIo({ body: DESC, fail: true });
    await changes(io, WHERE);
    expect(state.log.join()).toMatch(/attaching the pictures failed \(gh failed\)/);
    expect(state.body).not.toContain('<picture>');
    expect(state.body).not.toContain('pr-changes:staging');
    expect(state.body).toContain('+3 −1');
  });

  it('finds what was uploaded when the final write failed, and uploads nothing again', async () => {
    const { io, state } = fakeIo({ body: DESC });
    const write = io.write;
    io.write = () => {
      throw new Error('write failed');
    };
    await expect(changes(io, WHERE)).rejects.toThrow('write failed');
    expect(state.body).toContain('pr-changes:staging');
    io.write = write;
    state.uploads.length = 0;
    await changes(io, WHERE);
    expect(state.uploads).toHaveLength(0);
    expect(state.body).not.toContain('pr-changes:staging');
    expect(state.body).toContain('<picture>');
  });

  it('writes nothing on the run after an upload that added to a reused set', async () => {
    const first = fakeIo({ body: DESC, files: [[['a.ts', 5, 0]]] });
    await changes(first.io, WHERE);
    // A push adds a file: the +5 −0 pair is reused, and +1 −0 is new.
    const two = /** @type {[string, number, number][][]} */ ([
      [
        ['a.ts', 5, 0],
        ['b.ts', 1, 0],
      ],
    ]);
    const second = fakeIo({ body: first.state.body, files: two });
    await changes(second.io, WHERE);
    const third = fakeIo({ body: second.state.body, files: two });
    expect(await changes(third.io, WHERE)).toBe(false);
    expect(third.state.uploads).toHaveLength(0);
  });

  it('says a mismatch in the log and in the slot, once', async () => {
    const { io, state } = fakeIo({ body: DESC, files: [] });
    expect(await changes(io, WHERE)).toBe(true);
    expect(state.log.filter((l) => l.startsWith('::warning::'))).toHaveLength(1);
    expect(state.body).toContain('⚠️ **pr-changes:**');
    expect(await changes(io, WHERE)).toBe(false);
  });

  it('reads no commit for a description with no slot', async () => {
    const { io } = fakeIo({ body: 'No slots.' });
    io.commits = () => {
      throw new Error('read commits');
    };
    expect(await changes(io, WHERE)).toBe(false);
  });

  it('works the edit out again when a person changed the description meanwhile', async () => {
    const { io, state } = fakeIo({ body: DESC, upload: false });
    const reads = [
      DESC,
      DESC,
      `Mine, edited.\n${DESC}`,
      `Mine, edited.\n${DESC}`,
      `Mine, edited.\n${DESC}`,
    ];
    io.body = () => reads.shift() ?? state.body;
    expect(await changes(io, WHERE)).toBe(true);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toContain('Mine, edited.');
  });

  it('gives up when the description keeps changing', async () => {
    const { io } = fakeIo({ body: DESC, upload: false });
    let n = 0;
    io.body = () => `v${n++}\n${SLOT}`;
    io.write = () => {
      throw new Error('wrote');
    };
    await expect(changes(io, WHERE)).rejects.toThrow(/kept changing/);
  });

  it('stops when the slots are gone on a later read', async () => {
    const { io, state } = fakeIo({ body: DESC, upload: false });
    const reads = [DESC, DESC, 'Slots removed.'];
    io.body = () => reads.shift() ?? 'Slots removed.';
    io.write = () => {
      throw new Error('wrote');
    };
    expect(await changes(io, WHERE)).toBe(false);
    expect(state.writes).toHaveLength(0);
  });
});

describe('pairsAt', () => {
  const commit = {
    sha: A,
    subject: 's',
    files: [
      { path: 'a', added: 1, removed: 2 },
      { path: 'b', added: 1, removed: 2 },
      { path: 'c', added: 3, removed: 0 },
    ],
  };
  it('is each title pair and file pair once at full, only titles at titles, none at totals', () => {
    expect(pairsAt([commit], 'full')).toEqual([
      [1, 2],
      [3, 0],
      [5, 4],
    ]);
    expect(pairsAt([commit], 'titles')).toEqual([[5, 4]]);
    expect(pairsAt([commit], 'totals')).toEqual([]);
  });
});

describe('fetchVerify', () => {
  const sha = hashOf('abc');
  /**
   * @param {number} status
   * @param {string} text
   */
  const stub = (status, text) => {
    const real = globalThis.fetch;
    globalThis.fetch = /** @type {typeof fetch} */ (async () => new Response(text, { status }));
    return () => {
      globalThis.fetch = real;
    };
  };
  it('says why a link failed, as a notice', async () => {
    /** @type {string[]} */
    const lines = [];
    const real = globalThis.fetch;
    try {
      let restore = stub(404, 'x');
      expect(await fetchVerify('https://x/y', sha, (l) => lines.push(l))).toBe(false);
      restore();
      restore = stub(200, 'abd');
      expect(await fetchVerify('https://x/y', sha, (l) => lines.push(l))).toBe(false);
      restore();
      globalThis.fetch = /** @type {typeof fetch} */ (
        async () => {
          throw new Error('timed out');
        }
      );
      expect(await fetchVerify('https://x/y', sha, (l) => lines.push(l))).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
    expect(lines).toEqual([
      '::notice::pr-changes: https://x/y answered 404, not its bytes',
      '::notice::pr-changes: https://x/y answered with other bytes than were attached',
      '::notice::pr-changes: https://x/y did not answer (timed out)',
    ]);
  });

  it('is true for a 200 whose bytes hash to the image, false for another body or status or a failure', async () => {
    let restore = stub(200, 'abc');
    expect(await fetchVerify('https://x/y', sha)).toBe(true);
    restore();
    restore = stub(200, 'abd');
    expect(await fetchVerify('https://x/y', sha)).toBe(false);
    restore();
    restore = stub(404, 'abc');
    expect(await fetchVerify('https://x/y', sha)).toBe(false);
    restore();
    const real = globalThis.fetch;
    globalThis.fetch = /** @type {typeof fetch} */ (
      async () => {
        throw new Error('down');
      }
    );
    expect(await fetchVerify('https://x/y', sha)).toBe(false);
    globalThis.fetch = real;
  });
});

describe('ghUpload', () => {
  it("gives the person's token to the attach call alone, and names files by hash and size", () => {
    /** @type {{ args: string[], token: string | undefined }[]} */
    const calls = [];
    const [small] = images(3, 1);
    const staged = `x\n<!-- pr-changes:staging -->\n![${small.sha}](./${small.file})\n<!-- /pr-changes:staging -->`;
    const after = staged.replace(`./${small.file}`, linkFor(small.sha));
    const upload = ghUpload({
      repo: REPO,
      number: 5,
      token: 'PERSON',
      dir: '/tmp/pr-changes-test-' + process.pid,
      view: () => after,
      log: () => {},
      run: (args, options) => {
        calls.push({ args, token: options?.env?.GH_TOKEN });
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(upload([small], staged, 'x')).toBe(after);
    expect(calls).toHaveLength(1);
    expect(calls[0].token).toBe('PERSON');
    expect(calls[0].args).toContain('--attach');
    expect(calls[0].args).toContain(`./${small.file}`);
    expect(small.file).toMatch(/^[0-9a-f]{64}-12\.svg$/);
  });
});

describe('uploadAllowed', () => {
  it('needs a token', () => {
    expect(uploadAllowed({})).toEqual({ ok: false, why: expect.stringMatching(/no token/) });
    expect(uploadAllowed({ UPLOAD_TOKEN: '' }).ok).toBe(false);
    expect(uploadAllowed({ UPLOAD_TOKEN: 't' }).ok).toBe(true);
  });

  it("marks the run woken by the token's own edit, and only that one", () => {
    const base = { UPLOAD_TOKEN: 't', TOKEN_LOGIN: 'owner' };
    const own = (/** @type {Record<string, string>} */ env) => {
      const verdict = uploadAllowed({ ...base, ...env });
      return verdict.ok && verdict.ownEdit;
    };
    expect(own({ EVENT_ACTION: 'edited', SENDER: 'owner' })).toBe(true);
    expect(own({ EVENT_ACTION: 'edited', SENDER: 'someone' })).toBe(false);
    expect(own({ EVENT_ACTION: 'synchronize', SENDER: 'owner' })).toBe(false);
    expect(own({ EVENT_ACTION: 'opened', SENDER: 'owner' })).toBe(false);
    expect(own({ EVENT_ACTION: 'edited' })).toBe(false);
  });
});

describe('main', () => {
  it('refuses a missing repository or number', async () => {
    await expect(main({})).rejects.toThrow(/needs GITHUB_REPOSITORY and NUMBER/);
  });
});
