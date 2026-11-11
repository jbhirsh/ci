import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ATTACH_MAX_BYTES,
  attachmentLinks,
  collectGifs,
  main,
  parseInputs,
  recordRuns,
  waitForLinks,
} from './workflow.mjs';

const GIF = 'GIF89a…';

/**
 * A folder holding `files` (path → content).
 *
 * @param {Record<string, string>} files
 */
function folder(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'pr-gif-workflow-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

describe('parseInputs', () => {
  it('reads the PR, the scenarios however separated, and the two switches', () => {
    expect(
      parseInputs({
        PR: '42',
        SCENARIOS: ' scripts/gif-scenarios/a.ts, b.ts\nc/d_e-f.mjs ',
        SIDE_BY_SIDE: 'true',
        AFTER_ONLY: 'false',
      }),
    ).toEqual({
      pr: '42',
      scenarios: ['scripts/gif-scenarios/a.ts', 'b.ts', 'c/d_e-f.mjs'],
      sideBySide: true,
      afterOnly: false,
    });
    expect(parseInputs({ PR: '7' })).toEqual({
      pr: '7',
      scenarios: [],
      sideBySide: false,
      afterOnly: false,
    });
  });

  it.each([
    [{ PR: '' }, "PR is the PR's number"],
    [{ PR: '07' }, "PR is the PR's number"],
    [{ PR: '7; rm -rf /' }, "PR is the PR's number"],
    [{ PR: '7', SCENARIOS: '--dir 3' }, '"--dir" isn\'t a scenario file'],
    [{ PR: '7', SCENARIOS: '../other/a.ts' }, "isn't a scenario file"],
    [{ PR: '7', SCENARIOS: 'a/../../b.ts' }, "isn't a scenario file"],
    [{ PR: '7', SCENARIOS: 'a.ts;b' }, "isn't a scenario file"],
    [{ PR: '7', SCENARIOS: '/etc/passwd' }, "isn't a scenario file"],
    [{ PR: '7', SIDE_BY_SIDE: 'yes' }, 'SIDE_BY_SIDE is "true" or "false"'],
    [{ PR: '7', SIDE_BY_SIDE: 'true', AFTER_ONLY: 'true' }, 'side-by-side needs a before'],
  ])('turns away %j', (env, why) => {
    expect(() => parseInputs(env)).toThrow(why);
  });
});

describe('recordRuns', () => {
  const inputs = { pr: '7', scenarios: ['a.ts', 'b.ts'], sideBySide: false, afterOnly: false };

  it('runs a web app once a scenario, with its switches', () => {
    expect(recordRuns('web', inputs)).toEqual([['a.ts'], ['b.ts']]);
    expect(recordRuns('web', { ...inputs, sideBySide: true })).toEqual([
      ['a.ts', '--side-by-side'],
      ['b.ts', '--side-by-side'],
    ]);
    expect(recordRuns('web', { ...inputs, afterOnly: true })[0]).toEqual(['a.ts', '--after-only']);
    expect(() => recordRuns('web', { ...inputs, scenarios: [] })).toThrow(
      'name the scenario files to record',
    );
  });

  it('runs videos.mjs once for an app whose CI records videos, leaving its GIFs in pr-gif', () => {
    const none = { ...inputs, scenarios: [] };
    expect(recordRuns('ci-videos', none)).toEqual([['7', '--out', 'pr-gif']]);
    expect(recordRuns('ci-videos', { ...none, sideBySide: true })).toEqual([
      ['7', '--out', 'pr-gif', '--side-by-side'],
    ]);
    expect(recordRuns('ci-videos', { ...none, afterOnly: true })).toEqual([
      ['7', '--out', 'pr-gif', '--no-before'],
    ]);
    expect(() => recordRuns('ci-videos', inputs)).toThrow('leave scenarios empty');
  });
});

describe('collectGifs', () => {
  it("finds each scenario's GIFs by their names, folders sorted", () => {
    const root = folder({
      'pr-gif/sheet/sheet-before.gif': GIF,
      'pr-gif/sheet/sheet-after.gif': GIF,
      'pr-gif/sheet/frames.txt': 'not a GIF, not one of its names',
      'pr-gif/carousel/carousel-side-by-side.gif': GIF,
      'pr-gif/empty/other.gif': GIF,
      'pr-gif/stray.gif': GIF,
    });
    expect(collectGifs(root)).toEqual([
      {
        name: 'carousel',
        before: null,
        after: null,
        sideBySide: 'pr-gif/carousel/carousel-side-by-side.gif',
      },
      {
        name: 'sheet',
        before: 'pr-gif/sheet/sheet-before.gif',
        after: 'pr-gif/sheet/sheet-after.gif',
        sideBySide: null,
      },
    ]);
  });

  it('refuses a folder name the description could not hold, a file that is no GIF, or one too big', () => {
    const big = folder({ 'pr-gif/s/s-after.gif': GIF });
    truncateSync(path.join(big, 'pr-gif/s/s-after.gif'), ATTACH_MAX_BYTES + 1);
    expect(() => collectGifs(big)).toThrow(
      'pr-gif/s/s-after.gif is 10.0 MB, over the 10 MB GitHub attaches',
    );
    truncateSync(path.join(big, 'pr-gif/s/s-after.gif'), ATTACH_MAX_BYTES);
    expect(collectGifs(big)).toHaveLength(1);
    expect(() => collectGifs(folder({ 'pr-gif/a b/a b-after.gif': GIF }))).toThrow(
      '"a b" isn\'t a scenario name',
    );
    expect(() => collectGifs(folder({ 'pr-gif/-x/-x-after.gif': GIF }))).toThrow(
      "isn't a scenario name",
    );
    expect(() => collectGifs(folder({ 'pr-gif/a--b/a--b-after.gif': GIF }))).toThrow(
      "isn't a scenario name",
    );
    expect(() => collectGifs(folder({ 'pr-gif/s/s-after.gif': '<html>' }))).toThrow(
      "pr-gif/s/s-after.gif isn't a GIF",
    );
    expect(collectGifs(folder({ 'pr-gif/s/s-after.gif/inner': GIF }))).toEqual([]);
  });
});

describe('attachmentLinks', () => {
  const a = 'https://github.com/user-attachments/assets/aaa-1';
  const b = 'https://github.com/user-attachments/assets/bbb-2';
  const c = 'https://github.com/user-attachments/assets/ccc-3';
  const s = { name: 's', before: 'x', after: 'y', sideBySide: null };

  it("reads the links in each scenario's block only: the one withBlock wrote", () => {
    const body = [
      `Intro ${c}`,
      '<!-- pr-gif:s -->',
      `| s | ![GIF: s before](${a}) | ![GIF: s after](${b}) |`,
      '<!-- /pr-gif:s -->',
      // A start left without its end, after the block: not the block.
      '<!-- pr-gif:s -->',
      c,
      '<!-- pr-gif:side -->',
      `| side | ![GIF: side before and after](${c}) |`,
      '<!-- /pr-gif:side -->',
    ].join('\n');
    expect(
      attachmentLinks(body, [s, { name: 'side', before: 'x', after: 'y', sideBySide: 'z' }]),
    ).toEqual([a, b, c]);
  });

  it('throws unless there is a link for each GIF attached', () => {
    const body = `<!-- pr-gif:s -->\n![GIF: s after](${b})\n<!-- /pr-gif:s -->`;
    expect(() => attachmentLinks(body, [s])).toThrow(
      "the description's blocks link 1 attachment(s), not the 2 attached",
    );
    expect(() => attachmentLinks('', [s])).toThrow('link 0 attachment(s), not the 2 attached');
  });
});

describe('waitForLinks', () => {
  /**
   * A fetch answering each link from its own list of statuses (or errors),
   * the last repeating; a clock that moves on each wait.
   *
   * @param {Record<string, (number | Error)[]>} answers
   */
  function fake(answers) {
    let clock = 0;
    /** @type {string[]} */
    const asked = [];
    const fetch = /** @type {typeof globalThis.fetch} */ (
      /** @type {unknown} */ (
        async (/** @type {string} */ url) => {
          asked.push(url);
          const list = answers[url];
          const next = list.length > 1 ? list.shift() : list[0];
          if (next instanceof Error) throw next;
          return new Response(next === 200 ? 'GIF89a' : null, { status: next });
        }
      )
    );
    return {
      asked,
      options: {
        fetch,
        now: () => clock,
        wait: async (/** @type {number} */ ms) => {
          clock += ms;
        },
        limitMs: 20,
        everyMs: 5,
      },
    };
  }

  it('waits for a link that goes live a moment after the edit', async () => {
    const { asked, options } = fake({ a: [404, new Error('reset'), 200], b: [200] });
    await waitForLinks(['a', 'b'], options);
    expect(asked).toEqual(['a', 'a', 'a', 'b']);
  });

  it('names each link that never answered', async () => {
    const { options } = fake({ a: [404], b: [200], c: [new Error('ENOTFOUND')] });
    await expect(waitForLinks(['a', 'b', 'c'], options)).rejects.toThrow(
      "2 attached GIF(s) didn't answer within 0.02 s: a (404), c (ENOTFOUND)",
    );
  });
});

describe('main', () => {
  const saved = { APP_ROOT: process.env.APP_ROOT, PATH: process.env.PATH };
  afterEach(() => {
    // An unset variable is deleted again: assigning undefined would set "undefined".
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** @param {Record<string, unknown>} gif the app's gif settings */
  function app(gif) {
    const root = folder({ '.github/ci.json': JSON.stringify({ gif }) });
    process.env.APP_ROOT = root;
    return root;
  }

  it("says the app's source, as a step output", async () => {
    app({ source: 'ci-videos' });
    const output = path.join(folder({}), 'output');
    /** @type {string[]} */
    const logs = [];
    expect(
      await main(['source'], { env: { GITHUB_OUTPUT: output }, log: (l) => logs.push(l) }),
    ).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('source=ci-videos\n');
    expect(logs).toEqual(['gif.source: ci-videos']);
    expect(await main(['source'], { env: {}, log: () => {} })).toBe(0);
  });

  it('records every scenario, failing the step if any failed', async () => {
    app({});
    /** @type {string[][]} */
    const ran = [];
    /** @type {string[]} */
    const logs = [];
    const env = { PR: '7', SCENARIOS: 'a.ts b.ts c.ts' };
    const run = (/** @type {string[]} */ args) => (ran.push(args), args[0] === 'b.ts' ? 1 : 0);
    expect(await main(['record'], { env, run, log: (l) => logs.push(l) })).toBe(1);
    expect(ran).toEqual([['a.ts'], ['b.ts'], ['c.ts']]);
    expect(logs).toEqual(['pr-gif: b.ts failed; nothing will be attached']);
    expect(await main(['record'], { env, run: () => 0 })).toBe(0);
  });

  /**
   * A gh first on PATH, written in Node: `--version` prints `version`, `pr
   * view` the description kept in a file beside it, and `pr edit` takes the
   * body file, each `--attach`ed file's reference becoming a link, as gh does.
   *
   * @param {string} version
   */
  function fakeGh(version) {
    const bin = folder({});
    const state = path.join(bin, 'body.md');
    writeFileSync(state, 'What changes.');
    const script = path.join(bin, 'gh');
    writeFileSync(
      script,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(${JSON.stringify(`gh version ${version} (2026-09-01)`)}); process.exit(0); }
if (args[1] === 'view') { console.log(fs.readFileSync(${JSON.stringify(state)}, 'utf8')); process.exit(0); }
let body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
args.forEach((arg, i) => {
  if (args[i - 1] === '--attach') body = body.replaceAll('](' + arg + ')', '](https://github.com/user-attachments/assets/id-' + i + ')');
});
fs.writeFileSync(${JSON.stringify(state)}, body);
`,
    );
    chmodSync(script, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
    return { body: () => readFileSync(state, 'utf8') };
  }

  it("attaches the artifact's GIFs, waits for their links, and says so in the summary", async () => {
    const gh = fakeGh('2.103.3');
    const cwd = folder({
      'pr-gif/sheet/sheet-after.gif': GIF,
      'pr-gif/sheet/sheet-before.gif': GIF,
    });
    const summary = path.join(cwd, 'summary.md');
    /** @type {string[]} */
    const fetched = [];
    const fetch = /** @type {typeof globalThis.fetch} */ (
      /** @type {unknown} */ (
        async (/** @type {string} */ url) => (fetched.push(url), new Response('GIF89a'))
      )
    );
    /** @type {string[]} */
    const logs = [];
    const env = {
      PR: '12',
      GH_TOKEN: 'token',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_STEP_SUMMARY: summary,
    };
    expect(await main(['attach'], { env, cwd, fetch, log: (l) => logs.push(l) })).toBe(0);
    expect(gh.body()).toContain(
      '![GIF: sheet before](https://github.com/user-attachments/assets/id-',
    );
    expect(gh.body()).not.toContain('](./');
    expect(fetched).toHaveLength(2);
    expect(logs).toEqual([
      "pr-gif: attached 2 GIFs to #12's description",
      'pr-gif: every attached GIF answers: https://github.com/o/r/pull/12',
    ]);
    expect(readFileSync(summary, 'utf8')).toBe(
      'Attached the GIFs of `sheet` to [#12](https://github.com/o/r/pull/12).\n',
    );
  });

  it('stops without a token or GIFs, and on an old gh or an unknown step', async () => {
    const cwd = folder({ 'pr-gif/sheet/sheet-after.gif': GIF });
    const env = { PR: '12', GH_TOKEN: 'token', GITHUB_REPOSITORY: 'o/r' };
    await expect(main(['attach'], { env: { ...env, GH_TOKEN: '' }, cwd })).rejects.toThrow(
      'no token to attach with',
    );
    await expect(main(['attach'], { env, cwd: folder({ 'pr-gif/x.txt': '' }) })).rejects.toThrow(
      'no GIFs in pr-gif/ to attach',
    );
    fakeGh('2.89.0');
    await expect(main(['gh'])).rejects.toThrow('install gh ≥ 2.99');
    await expect(main(['gh'])).rejects.toThrow('yours is 2.89.0');
    fakeGh('2.99.0');
    expect(await main(['gh'])).toBe(0);
    await expect(main(['wat'])).rejects.toThrow('usage: node gif/workflow.mjs');
  });
});
