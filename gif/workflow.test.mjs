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
import { ATTACH_MAX_BYTES } from '../lib/attach.mjs';
import {
  attachmentLinks,
  automaticChange,
  changedScenarios,
  checkRun,
  collectGifs,
  main,
  parseApiFiles,
  parseInputs,
  parseNameStatus,
  readManifest,
  recordRuns,
  screenRun,
  waitForLinks,
  writeManifest,
} from './workflow.mjs';
import { recordedLine, withBlock } from './publish.mjs';

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
      automatic: false,
    });
    expect(parseInputs({ PR: '7' })).toEqual({
      pr: '7',
      scenarios: [],
      sideBySide: false,
      afterOnly: false,
      automatic: false,
    });
    expect(
      parseInputs({ PR: '7', AUTOMATIC: 'true', HEAD_SHA: 'a'.repeat(40), AFTER_RUN: '99' }),
    ).toMatchObject({ automatic: true, head: 'a'.repeat(40), afterRun: '99' });
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
    [{ PR: '7', AUTOMATIC: 'true', AFTER_ONLY: 'true' }, 'records a separate before and after'],
    [{ PR: '7', HEAD_SHA: 'abc1234' }, 'HEAD_SHA is a full commit SHA'],
    [{ PR: '7', AFTER_RUN: '1;x' }, "AFTER_RUN is a run's id"],
  ])('turns away %j', (env, why) => {
    expect(() => parseInputs(env)).toThrow(why);
  });
});

describe('recordRuns', () => {
  /** @type {import('./workflow.mjs').Inputs} */
  const inputs = {
    pr: '7',
    scenarios: ['a.ts', 'b.ts'],
    sideBySide: false,
    afterOnly: false,
    automatic: false,
  };

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

  it('lets an automatic run\'s "before" fail, and takes sift\'s CI run for "after"', () => {
    const auto = { ...inputs, automatic: true };
    expect(recordRuns('web', auto)).toEqual([
      ['a.ts', '--before-may-fail'],
      ['b.ts', '--before-may-fail'],
    ]);
    const head = 'c'.repeat(40);
    const sift = { ...auto, scenarios: ['swipe', 'sheet'], head, afterRun: '55' };
    expect(recordRuns('ci-videos', sift)).toEqual([
      ['7', '--out', 'pr-gif', '--after-run', '55', '--head', head, '--only', 'swipe,sheet'],
    ]);
    expect(() => recordRuns('ci-videos', { ...sift, afterRun: undefined })).toThrow(
      'needs HEAD_SHA and AFTER_RUN',
    );
    expect(() => recordRuns('ci-videos', { ...sift, scenarios: ['e2e/gifs/a.yaml'] })).toThrow(
      'as plain names',
    );
    expect(() => recordRuns('ci-videos', { ...sift, scenarios: [] })).toThrow('as plain names');
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
    const git = () => `${'f'.repeat(40)}\n`;
    expect(await main(['record'], { env, run, git, log: (l) => logs.push(l) })).toBe(1);
    expect(ran).toEqual([['a.ts'], ['b.ts'], ['c.ts']]);
    expect(logs).toEqual(['pr-gif: b.ts failed; nothing will be attached']);
    expect(await main(['record'], { env, run: () => 0, git })).toBe(0);
  });

  it('names each web scenario by the folder its recording made, in a manifest of the commit', async () => {
    const root = app({});
    const head = 'e'.repeat(40);
    /** @type {string[]} */
    const logs = [];
    // a.ts names itself "sheet"; b.ts fails before making a folder.
    const run = (/** @type {string[]} */ args) => {
      if (args[0] === 'b.ts') return 1;
      mkdirSync(path.join(root, 'pr-gif', 'sheet'), { recursive: true });
      writeFileSync(path.join(root, 'pr-gif', 'sheet', 'sheet-after.gif'), GIF);
      return 0;
    };
    const env = { PR: '7', SCENARIOS: 'a.ts b.ts', AUTOMATIC: 'true', HEAD_SHA: head };
    expect(await main(['record'], { env, run, log: (l) => logs.push(l) })).toBe(1);
    expect(readManifest(readFileSync(path.join(root, 'pr-gif', 'pr-gif.json')))).toEqual({
      pr: 7,
      head,
      automatic: true,
      recorded: ['sheet'],
      failed: ['b'],
    });
    expect(logs).toEqual([
      'pr-gif: b.ts failed; what recorded will be attached, and the rest marked not updated',
    ]);
  });

  it("records sift's changed scenarios from its CI run, counting the ones it left out as failed", async () => {
    const root = app({ source: 'ci-videos' });
    const head = 'e'.repeat(40);
    /** @type {string[][]} */
    const ran = [];
    const run = (/** @type {string[]} */ args) => {
      ran.push(args);
      mkdirSync(path.join(root, 'pr-gif', 'swipe'), { recursive: true });
      writeFileSync(path.join(root, 'pr-gif', 'swipe', 'swipe-after.gif'), GIF);
      return 0;
    };
    const env = {
      PR: '7',
      SCENARIOS: 'swipe,sheet',
      AUTOMATIC: 'true',
      HEAD_SHA: head,
      AFTER_RUN: '55',
    };
    expect(await main(['record'], { env, run, log: () => {} })).toBe(1);
    expect(ran).toEqual([
      ['7', '--out', 'pr-gif', '--after-run', '55', '--head', head, '--only', 'swipe,sheet'],
    ]);
    expect(readManifest(readFileSync(path.join(root, 'pr-gif', 'pr-gif.json')))).toMatchObject({
      recorded: ['swipe'],
      failed: ['sheet'],
    });

    // A run that made nothing, not even the folder: every one failed.
    const bare = app({ source: 'ci-videos' });
    expect(await main(['record'], { env, run: () => 1, log: () => {} })).toBe(1);
    expect(readManifest(readFileSync(path.join(bare, 'pr-gif', 'pr-gif.json')))).toMatchObject({
      recorded: [],
      failed: ['swipe', 'sheet'],
    });
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
    const headFile = path.join(bin, 'head');
    writeFileSync(state, 'What changes.');
    writeFileSync(headFile, 'a'.repeat(40));
    const script = path.join(bin, 'gh');
    writeFileSync(
      script,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(${JSON.stringify(`gh version ${version} (2026-09-01)`)}); process.exit(0); }
if (args[1] === 'view') { console.log(JSON.stringify({ body: fs.readFileSync(${JSON.stringify(state)}, 'utf8'), headRefOid: fs.readFileSync(${JSON.stringify(headFile)}, 'utf8') })); process.exit(0); }
let body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
args.forEach((arg, i) => {
  if (args[i - 1] === '--attach') body = body.replaceAll('](' + arg + ')', '](https://github.com/user-attachments/assets/id-' + i + ')');
});
fs.writeFileSync(${JSON.stringify(state)}, body);
`,
    );
    chmodSync(script, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
    return {
      body: () => readFileSync(state, 'utf8'),
      setBody: (/** @type {string} */ text) => writeFileSync(state, text),
      setHead: (/** @type {string} */ sha) => writeFileSync(headFile, sha),
    };
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

  it('stops without a token or GIFs, and on an unknown step', async () => {
    const cwd = folder({ 'pr-gif/sheet/sheet-after.gif': GIF });
    const env = { PR: '12', GH_TOKEN: 'token', GITHUB_REPOSITORY: 'o/r' };
    await expect(main(['attach'], { env: { ...env, GH_TOKEN: '' }, cwd })).rejects.toThrow(
      'no token to attach with',
    );
    await expect(main(['attach'], { env, cwd: folder({ 'pr-gif/x.txt': '' }) })).rejects.toThrow(
      'no GIFs in pr-gif/ to attach',
    );
    await expect(main(['wat'])).rejects.toThrow('usage: node gif/workflow.mjs');
  });

  it("passes a dispatch's inputs through, and finds the scenarios a pull_request changes", async () => {
    const root = app({ scenarios: 'scripts/gif-scenarios' });
    const output = path.join(root, 'output');
    const base = 'b'.repeat(40);
    const head = 'c'.repeat(40);
    /** @type {string[][]} */
    const asked = [];
    const git = (/** @type {string[]} */ args) => {
      asked.push(args);
      if (args[0] === 'merge-base') return `${'d'.repeat(40)}\n`;
      return [
        'M',
        'scripts/gif-scenarios/sheet.ts',
        'A',
        'scripts/gif-scenarios/new.mjs',
        'D',
        'scripts/gif-scenarios/gone.ts',
        'M',
        'scripts/gif-scenarios/sheet.test.ts',
        'M',
        'src/App.tsx',
        '',
      ].join('\0');
    };
    const env = {
      GITHUB_OUTPUT: output,
      EVENT_NAME: 'pull_request',
      PR: '12',
      BASE_SHA: base,
      HEAD_SHA: head,
    };
    expect(await main(['changed'], { env, git, log: () => {} })).toBe(0);
    expect(asked).toEqual([
      ['merge-base', base, head],
      ['diff', '--name-status', '--no-renames', '-z', 'd'.repeat(40), head],
    ]);
    expect(readFileSync(output, 'utf8')).toBe(
      [
        'pr=12',
        'scenarios=scripts/gif-scenarios/new.mjs scripts/gif-scenarios/sheet.ts',
        `head=${head}`,
        'automatic=true',
        'record=true',
        '',
      ].join('\n'),
    );

    const dispatch = path.join(root, 'dispatch');
    const inputs = {
      GITHUB_OUTPUT: dispatch,
      EVENT_NAME: 'workflow_dispatch',
      PR: '9',
      SCENARIOS: 'a.ts',
    };
    expect(await main(['changed'], { env: inputs, git, log: () => {} })).toBe(0);
    expect(readFileSync(dispatch, 'utf8')).toBe(
      'pr=9\nscenarios=a.ts\nhead=\nautomatic=false\nrecord=true\n',
    );

    // sift records on its CI: nothing here.
    app({ source: 'ci-videos', scenarios: 'e2e/gifs' });
    const sift = path.join(root, 'sift');
    expect(
      await main(['changed'], { env: { ...env, GITHUB_OUTPUT: sift }, git, log: () => {} }),
    ).toBe(0);
    expect(readFileSync(sift, 'utf8')).toContain('record=false');
    await expect(
      main(['changed'], { env: { ...env, BASE_SHA: 'main' }, git, log: () => {} }),
    ).rejects.toThrow("BASE_SHA and HEAD_SHA are the PR event's commit SHAs");
  });

  /**
   * A workflow_run event's file, and an api answering from `answers` by the
   * endpoint's start, noting each call.
   *
   * @param {Record<string, unknown>} run
   * @param {Record<string, unknown>} answers
   */
  function checkWorld(run, answers) {
    const dir = folder({});
    const eventPath = path.join(dir, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ workflow_run: run }));
    /** @type {string[][]} */
    const calls = [];
    const api = (/** @type {string[]} */ args) => {
      calls.push(args);
      if (args[0] === '-X') return '{}';
      const endpoint = args.find((a) => a.startsWith('repos/')) ?? '';
      const key = Object.keys(answers)
        .sort((a, b) => b.length - a.length)
        .find((k) => endpoint.startsWith(k));
      if (!key) throw new Error(`no answer for ${endpoint}`);
      const value = answers[key];
      return typeof value === 'string' ? value : JSON.stringify(value);
    };
    const output = path.join(dir, 'output');
    const env = {
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: '77',
      GITHUB_SERVER_URL: 'https://github.com',
    };
    const outputs = () =>
      Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map((line) => /** @type {[string, string]} */ (line.split(/=(.*)/s).slice(0, 2))),
      );
    return { api, calls, env, outputs };
  }

  const head = 'a'.repeat(40);
  const run = {
    id: 5,
    event: 'pull_request',
    conclusion: 'failure',
    head_sha: head,
    head_branch: 'feature',
    html_url: 'https://github.com/o/r/actions/runs/5',
    head_repository: { full_name: 'o/r', owner: { login: 'o' } },
    pull_requests: [{ number: 12 }],
  };
  const pull = {
    number: 12,
    state: 'open',
    body: '',
    head: { sha: head, repo: { full_name: 'o/r' } },
  };
  const files = [
    '{"filename":"scripts/gif-scenarios/sheet.ts","status":"modified"}',
    '{"filename":"README.md","status":"modified"}',
  ].join('\n');

  it('checks a finished recording, says go, and sets the status pending', async () => {
    app({ scenarios: 'scripts/gif-scenarios' });
    const world = checkWorld(run, {
      'repos/o/r/pulls/12/files': files,
      'repos/o/r/pulls/12': pull,
      'repos/o/r/actions/runs/5/jobs': {
        jobs: [
          { name: 'gif / Which scenarios changed', conclusion: 'success' },
          { name: 'gif / Record the GIFs', conclusion: 'failure' },
        ],
      },
    });
    /** @type {string[]} */
    const logs = [];
    expect(
      await main(['check'], { env: world.env, api: world.api, log: (l) => logs.push(l) }),
    ).toBe(0);
    expect(world.outputs()).toEqual({
      go: 'true',
      record: 'true',
      report: 'true',
      pr: '12',
      head,
      scenarios: 'sheet',
      'artifact-run': '5',
      'run-url': 'https://github.com/o/r/actions/runs/5',
    });
    expect(world.calls.at(-1)).toEqual([
      '-X',
      'POST',
      `repos/o/r/statuses/${head}`,
      '-f',
      'state=pending',
      '-f',
      'context=PR GIFs',
      '-f',
      'description=Checking and attaching the GIFs',
      '-f',
      'target_url=https://github.com/o/r/actions/runs/77',
    ]);
    expect(logs).toEqual(['pr-gif: #12 changes sheet']);
  });

  it("never goes on for a fork's PR, saying so in a status, nor for a run that's no PR's or is stale", async () => {
    app({ source: 'ci-videos', scenarios: 'e2e/gifs' });
    const fork = {
      ...run,
      head_repository: { full_name: 'x/r', owner: { login: 'x' } },
      pull_requests: [],
    };
    const forkPull = { ...pull, head: { sha: head, repo: { full_name: 'x/r' } } };
    const world = checkWorld(fork, {
      'repos/o/r/pulls?state=open&head=x%3Afeature': [forkPull],
      'repos/o/r/pulls/12/files': '{"filename":"e2e/gifs/swipe.yaml","status":"added"}',
    });
    expect(await main(['check'], { env: world.env, api: world.api, log: () => {} })).toBe(0);
    expect(world.outputs()).toMatchObject({
      go: 'false',
      record: 'false',
      report: 'false',
      pr: '',
    });
    expect(world.calls.at(-1)).toContain(
      "description=A fork's PR: not recorded here. Run PR GIFs by hand if you trust it",
    );

    for (const [what, r, answers] of /** @type {const} */ ([
      ['a run by hand', { ...run, event: 'workflow_dispatch' }, {}],
      ['a cancelled run', { ...run, conclusion: 'cancelled' }, {}],
      ['a run with no PR', { ...run, pull_requests: [] }, {}],
      [
        'a stale run',
        run,
        {
          'repos/o/r/pulls/12/files': files,
          'repos/o/r/pulls/12': { ...pull, head: { ...pull.head, sha: 'b'.repeat(40) } },
        },
      ],
    ])) {
      const w = checkWorld(r, answers);
      expect(await main(['check'], { env: w.env, api: w.api, log: () => {} }), what).toBe(0);
      expect(w.outputs().go, what).toBe('false');
      expect(
        w.calls.some((c) => c[0] === '-X'),
        what,
      ).toBe(false);
    }
  });

  it("attaches an automatic run's GIFs at its commit, marks what failed, drops what the PR no longer changes", async () => {
    const gh = fakeGh('2.103.3');
    const runUrl = 'https://github.com/o/r/actions/runs/5';
    const old = (/** @type {string} */ sha) =>
      `${recordedLine(sha, { automatic: true })}\n\n| old |`;
    gh.setBody(
      withBlock(
        withBlock(
          withBlock(
            withBlock('What changes.', 'sheet', old('1'.repeat(40))),
            'broken',
            old('1'.repeat(40)),
          ),
          'gone',
          old('1'.repeat(40)),
        ),
        'manual',
        `${recordedLine('2'.repeat(40))}\n\n| by hand |`,
      ),
    );
    const cwd = folder({
      'pr-gif/sheet/sheet-after.gif': GIF,
      'pr-gif/new/new-after.gif': GIF,
      'pr-gif/new/new-before.gif': GIF,
      'pr-gif/stray/stray-after.gif': GIF,
      'pr-gif/pr-gif.json': writeManifest({
        pr: 12,
        head,
        automatic: true,
        recorded: ['sheet', 'new'],
        failed: ['broken'],
      }),
    });
    const fetch = /** @type {typeof globalThis.fetch} */ (
      /** @type {unknown} */ (async () => new Response('GIF89a'))
    );
    /** @type {string[]} */
    const logs = [];
    const env = {
      PR: '12',
      GH_TOKEN: 'token',
      GITHUB_REPOSITORY: 'o/r',
      AUTOMATIC: 'true',
      RECORD: 'true',
      HEAD_SHA: head,
      RUN_URL: runUrl,
      SCENARIOS: 'sheet,new,broken',
    };
    expect(await main(['attach'], { env, cwd, fetch, log: (l) => logs.push(l) })).toBe(1);
    const body = gh.body();
    expect(body).toContain(
      "<!-- pr-gif:sheet -->\nRecorded automatically at `aaaaaaa`. No before: main couldn't play this scenario.\n\n| Scenario |",
    );
    expect(body).toContain('<!-- pr-gif:new -->\nRecorded automatically at `aaaaaaa`.\n\n');
    expect(body).toContain(
      `<!-- pr-gif:broken -->\n**Not updated for \`aaaaaaa\`: recording failed ([run](${runUrl})).** Recorded automatically at \`1111111\`.`,
    );
    expect(body).not.toContain('pr-gif:gone');
    expect(body).not.toContain('stray');
    expect(body).toContain('| by hand |');
    expect(body).not.toContain('](./');
    expect(logs.at(-1)).toBe('pr-gif: not updated, as recording failed: broken');
  });

  it('only drops, stops for a moved head, and refuses an artifact for another PR or commit', async () => {
    const gh = fakeGh('2.103.3');
    const auto = withBlock('Intro', 'gone', `${recordedLine(head, { automatic: true })}\n\n| t |`);
    gh.setBody(auto);
    const env = {
      PR: '12',
      GH_TOKEN: 'token',
      GITHUB_REPOSITORY: 'o/r',
      AUTOMATIC: 'true',
      RECORD: 'false',
      HEAD_SHA: head,
    };
    /** @type {string[]} */
    const logs = [];
    expect(await main(['attach'], { env, cwd: folder({}), log: (l) => logs.push(l) })).toBe(0);
    expect(gh.body()).toBe('Intro');

    gh.setBody(auto);
    gh.setHead('b'.repeat(40));
    expect(await main(['attach'], { env, cwd: folder({}), log: (l) => logs.push(l) })).toBe(0);
    expect(gh.body()).toBe(auto);
    expect(logs.at(-1)).toMatch(/head moved on to bbbbbbb from aaaaaaa/);

    const manifest = (/** @type {Partial<import('./workflow.mjs').Manifest>} */ m) =>
      folder({
        'pr-gif/s/s-after.gif': GIF,
        'pr-gif/pr-gif.json': writeManifest({
          pr: 12,
          head,
          automatic: true,
          recorded: ['s'],
          failed: [],
          ...m,
        }),
      });
    const record = { ...env, RECORD: 'true' };
    await expect(main(['attach'], { env: record, cwd: manifest({ pr: 13 }) })).rejects.toThrow(
      "the artifact is #13's, not #12's",
    );
    await expect(
      main(['attach'], { env: record, cwd: manifest({ head: 'c'.repeat(40) }) }),
    ).rejects.toThrow('recorded at ccccccc, not aaaaaaa');
    await expect(
      main(['attach'], { env: record, cwd: manifest({ automatic: false }) }),
    ).rejects.toThrow("a run by hand's");
    await expect(
      main(['attach'], { env: { ...record, HEAD_SHA: '' }, cwd: manifest({}) }),
    ).rejects.toThrow('needs HEAD_SHA');
  });

  it('marks the changed scenarios not updated when the recording left nothing, dropping none', async () => {
    const gh = fakeGh('2.103.3');
    const block = `${recordedLine('1'.repeat(40), { automatic: true })}\n\n| t |`;
    gh.setBody(withBlock(withBlock('', 'sheet', block), 'other', block));
    const env = {
      PR: '12',
      GH_TOKEN: 'token',
      GITHUB_REPOSITORY: 'o/r',
      AUTOMATIC: 'true',
      RECORD: 'true',
      HEAD_SHA: head,
      RUN_URL: 'u',
      SCENARIOS: 'sheet',
    };
    expect(await main(['attach'], { env, cwd: folder({}), log: () => {} })).toBe(1);
    expect(gh.body()).toContain('<!-- pr-gif:sheet -->\n**Not updated for `aaaaaaa`');
    expect(gh.body()).toContain('<!-- pr-gif:other -->\nRecorded automatically');
  });

  it('says the commit a run by hand recorded, from its manifest', async () => {
    const gh = fakeGh('2.103.3');
    const cwd = folder({
      'pr-gif/sheet/sheet-after.gif': GIF,
      'pr-gif/pr-gif.json': writeManifest({
        pr: 12,
        head,
        automatic: false,
        recorded: ['sheet'],
        failed: [],
      }),
    });
    const fetch = /** @type {typeof globalThis.fetch} */ (
      /** @type {unknown} */ (async () => new Response('GIF89a'))
    );
    const env = { PR: '12', GH_TOKEN: 'token', GITHUB_REPOSITORY: 'o/r' };
    expect(await main(['attach'], { env, cwd, fetch, log: () => {} })).toBe(0);
    expect(gh.body()).toContain('<!-- pr-gif:sheet -->\nRecorded at `aaaaaaa`.\n\n| Scenario |');
  });
});

describe('the manifest', () => {
  const manifest = {
    pr: 3,
    head: 'f'.repeat(40),
    automatic: true,
    recorded: ['a', 'b.c'],
    failed: ['d-e'],
  };

  it('reads back what was written', () => {
    expect(readManifest(writeManifest(manifest))).toEqual(manifest);
  });

  it.each([
    ['x'.repeat(70_000), 'is over 64 KB'],
    ['{', "isn't JSON"],
    ['[]', "isn't an object"],
    [JSON.stringify({ ...manifest, extra: 1 }), 'must hold exactly'],
    [JSON.stringify({ ...manifest, pr: 0 }), "pr isn't a PR number"],
    [JSON.stringify({ ...manifest, pr: '3' }), "pr isn't a PR number"],
    [JSON.stringify({ ...manifest, head: 'main' }), "head isn't a commit SHA"],
    [JSON.stringify({ ...manifest, automatic: 'yes' }), "automatic isn't true or false"],
    [JSON.stringify({ ...manifest, recorded: ['a b'] }), "lists aren't scenario names"],
    [JSON.stringify({ ...manifest, failed: ['a--b'] }), "lists aren't scenario names"],
  ])('turns away %j', (text, why) => {
    expect(() => readManifest(text)).toThrow(why);
  });
});

describe('which scenarios a PR changes', () => {
  it('reads git and the API alike', () => {
    expect(parseNameStatus('M\0a.ts\0D\0b.ts\0A\0c d.ts\0')).toEqual([
      { file: 'a.ts', removed: false },
      { file: 'b.ts', removed: true },
      { file: 'c d.ts', removed: false },
    ]);
    expect(parseNameStatus('')).toEqual([]);
    expect(
      parseApiFiles(
        '{"filename":"a.ts","status":"renamed"}\nnot json\n{"filename":"b.ts","status":"removed"}\n{"x":1}\n',
      ),
    ).toEqual([
      { file: 'a.ts', removed: false },
      { file: 'b.ts', removed: true },
    ]);
  });

  it('keeps added and changed scenarios directly in the folder, by its predicate, plainly named', () => {
    const changes = [
      'scripts/gif-scenarios/b.ts',
      'scripts/gif-scenarios/a.mjs',
      'scripts/gif-scenarios/a.mjs',
      'scripts/gif-scenarios/a.test.ts',
      'scripts/gif-scenarios/x.d.ts',
      'scripts/gif-scenarios/helpers/h.ts',
      'scripts/gif-scenarios/two words.ts',
      'scripts/gif-scenarios/a--b.ts',
      'scripts/other.ts',
    ].map((file) => ({ file, removed: false }));
    changes.push({ file: 'scripts/gif-scenarios/gone.ts', removed: true });
    expect(changedScenarios(changes, 'scripts/gif-scenarios/', 'web')).toEqual([
      'scripts/gif-scenarios/a.mjs',
      'scripts/gif-scenarios/b.ts',
    ]);
    expect(changedScenarios(changes, undefined, 'web')).toEqual([]);
    expect(
      changedScenarios(
        [
          { file: 'e2e/gifs/swipe.yaml', removed: false },
          { file: 'e2e/gifs/shared/start.yaml', removed: false },
        ],
        'e2e/gifs',
        'ci-videos',
      ),
    ).toEqual(['e2e/gifs/swipe.yaml']);
  });
});

describe('screenRun and checkRun', () => {
  const head = 'a'.repeat(40);
  /** @type {import('./workflow.mjs').WorkflowRun} */
  const run = {
    id: 5,
    event: 'pull_request',
    conclusion: 'success',
    head_sha: head,
    html_url: 'u',
    head_repository: { full_name: 'o/r' },
  };
  /** @type {import('./workflow.mjs').Pull} */
  const pull = {
    number: 12,
    state: 'open',
    body: '',
    head: { sha: head, repo: { full_name: 'o/r' } },
  };
  const facts = {
    run,
    pull,
    repo: 'o/r',
    fork: false,
    changed: [],
    source: /** @type {const} */ ('web'),
  };

  it('passes a finished pull_request run, telling a fork', () => {
    expect(screenRun(run, 'o/r')).toEqual({ fork: false });
    expect(screenRun({ ...run, head_repository: { full_name: 'x/r' } }, 'o/r')).toEqual({
      fork: true,
    });
    expect(screenRun({ ...run, conclusion: 'cancelled' }, 'o/r')).toEqual({
      ignore: 'the run ended cancelled',
    });
    expect(screenRun({ ...run, event: 'push' }, 'o/r')).toEqual({
      ignore: "a push run, not a PR's",
    });
  });

  it('records a scenario the PR changes, prunes an automatic block it no longer does', () => {
    const changed = ['scripts/gif-scenarios/sheet.ts'];
    expect(checkRun({ ...facts, changed, recorded: true })).toMatchObject({
      go: true,
      record: true,
      names: ['sheet'],
      status: { state: 'pending' },
    });
    // A web app's run is the word on whether there is a recording.
    expect(checkRun({ ...facts, changed, recorded: false })).toMatchObject({
      go: false,
      record: false,
    });
    expect(checkRun({ ...facts, recorded: true })).toMatchObject({
      record: true,
      why: '#12 changes its GIF scenarios',
    });
    expect(
      checkRun({ ...facts, source: 'ci-videos', changed: ['e2e/gifs/swipe.yaml'] }),
    ).toMatchObject({ go: true, record: true, names: ['swipe'] });
    const auto = withBlock('', 'gone', `${recordedLine(head, { automatic: true })}`);
    expect(checkRun({ ...facts, pull: { ...pull, body: auto } })).toMatchObject({
      go: true,
      record: false,
      status: null,
      why: '#12 no longer changes gone: dropping their GIFs',
    });
    const manual = withBlock('', 'kept', recordedLine(head));
    expect(checkRun({ ...facts, pull: { ...pull, body: manual } })).toMatchObject({
      go: false,
      why: '#12 changes no GIF scenario',
    });
  });

  it("never goes on for a fork's, a closed or a moved-on PR", () => {
    const changed = ['e2e/gifs/swipe.yaml'];
    expect(checkRun({ ...facts, fork: true, changed, recorded: true })).toMatchObject({
      go: false,
      record: false,
      status: { state: 'success', description: expect.stringContaining('recorded, not attached') },
    });
    expect(checkRun({ ...facts, fork: true })).toMatchObject({ go: false, status: null });
    expect(
      checkRun({
        ...facts,
        changed,
        pull: { ...pull, head: { sha: head, repo: { full_name: 'x/r' } } },
      }),
    ).toMatchObject({ go: false });
    expect(checkRun({ ...facts, changed, pull: { ...pull, state: 'closed' } })).toMatchObject({
      go: false,
      status: null,
      why: '#12 is closed',
    });
    expect(
      checkRun({
        ...facts,
        changed,
        pull: { ...pull, head: { ...pull.head, sha: 'b'.repeat(40) } },
      }),
    ).toMatchObject({ go: false, status: null });
  });
});

describe('automaticChange', () => {
  it('leaves every block alone when which to keep is unknown', () => {
    const head = 'a'.repeat(40);
    const body = withBlock('', 'x', recordedLine(head, { automatic: true }));
    expect(
      automaticChange({ scenarios: [], failed: [], keep: null, head, runUrl: 'u' })(body),
    ).toBe(body);
    expect(automaticChange({ scenarios: [], failed: [], keep: [], head, runUrl: 'u' })(body)).toBe(
      '',
    );
  });
});
