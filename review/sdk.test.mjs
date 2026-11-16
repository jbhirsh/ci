import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fakeFetch } from './fakeFetch.mjs';
import { lastResult, main, oidcToken, report, reviewerEnv, stoppedBy } from './sdk.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OIDC = 'https://oidc.example/token?x=1';

/**
 * Anything the fake SDK was handed: options, servers, tools, hooks. Read
 * loosely, as the tests poke at its parts.
 *
 * @typedef {{ [key: string]: Loose } & ((...args: unknown[]) => Promise<Loose>)} Loose
 */

/**
 * A fake Agent SDK: records the options it's given and yields the messages.
 *
 * @param {unknown[]} messages
 * @param {{ throws?: string }} [behaviour]
 */
function fakeSdk(messages, behaviour = {}) {
  /** @type {{ prompt?: string, options?: Loose }} */
  const seen = {};
  const sdk = {
    /** @param {{ name: string, tools: unknown[] }} server */
    createSdkMcpServer: (server) => ({ type: 'sdk', ...server }),
    /**
     * @param {string} name
     * @param {string} description
     * @param {unknown} schema
     * @param {(args: unknown) => Promise<unknown>} handler
     */
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    /**
     * @param {{ prompt: string, options: Loose }} args
     * @yields {unknown} each message
     */
    query: async function* ({ prompt, options }) {
      seen.prompt = prompt;
      seen.options = options;
      if (behaviour.throws) throw new Error(behaviour.throws);
      yield* messages;
    },
  };
  return {
    sdk: /** @type {typeof import('@anthropic-ai/claude-agent-sdk')} */ (
      /** @type {unknown} */ (sdk)
    ),
    seen,
  };
}

const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 3,
  total_cost_usd: 0.046,
  result: 'done',
  modelUsage: {
    'claude-sonnet-5-5': {
      inputTokens: 6,
      outputTokens: 509,
      cacheReadInputTokens: 20384,
      cacheCreationInputTokens: 15465,
      costUSD: 0.0458,
    },
  },
};

/**
 * @param {Record<string, string>} [over]
 * @returns {Record<string, string>}
 */
function env(over = {}) {
  return {
    RUNNER_TEMP: mkdtempSync(path.join(tmpdir(), 'review-sdk-')),
    PROMPT: 'Review it.',
    MAX_TURNS: '40',
    CI_DIR: '/ci',
    REPO: 'o/r',
    PR: '7',
    BASE_REF: 'main',
    HEAD_SHA: 'a'.repeat(40),
    GH_TOKEN: 'ghs_claude',
    GITHUB_TOKEN: 'ghs_job',
    PATH: '/usr/bin',
    HOME: '/home/runner',
    ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_1',
    ANTHROPIC_ORGANIZATION_ID: 'org',
    ACTIONS_ID_TOKEN_REQUEST_URL: OIDC,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'bearer',
    ...over,
  };
}

const oidc = fakeFetch({
  [`GET ${OIDC}&audience=${encodeURIComponent('https://api.anthropic.com')}`]: [
    200,
    { value: 'jwt-1' },
  ],
});

describe('main', () => {
  it('runs a pass locked down to reading and reporting, and writes its messages', async () => {
    const { sdk, seen } = fakeSdk([{ type: 'assistant' }, success]);
    const vars = env({ ADVISOR: 'opus' });
    const out = await main(vars, { sdk, fetchImpl: oidc, root: '/app' });
    expect(out).toMatchObject({ stopped: null, finished: true });
    expect(JSON.parse(readFileSync(out.executionFile, 'utf8'))).toEqual([
      { type: 'assistant' },
      success,
    ]);
    expect(out.report).toContain('success, 3 turns, $0.046');
    expect(out.report).toContain('| claude-sonnet-5-5 | $0.046 |');

    const o = /** @type {Loose} */ (seen.options);
    expect(seen.prompt).toBe('Review it.');
    expect(o).toMatchObject({
      model: 'sonnet',
      settings: { advisorModel: 'opus' },
      tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
      disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent'],
      permissionMode: 'default',
      settingSources: ['project'],
      strictMcpConfig: true,
      maxTurns: 40,
      cwd: '/app',
      additionalDirectories: ['/ci'],
    });
    expect(o.allowedTools).toContain('mcp__review__diff');
    expect(o.allowedTools).not.toContain('Bash');
    expect(o.systemPrompt).toContain('You have no shell');
    expect(Object.keys(o.mcpServers)).toEqual(['review', 'github_inline_comment']);

    // Neither GitHub token reaches the reviewer's process.
    expect(o.env.GH_TOKEN).toBeUndefined();
    expect(o.env.GITHUB_TOKEN).toBeUndefined();
    expect(o.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    expect(readFileSync(String(o.env.ANTHROPIC_IDENTITY_TOKEN_FILE), 'utf8')).toBe('jwt-1');
  });

  it('guards every tool call with its hooks', async () => {
    const { sdk, seen } = fakeSdk([success]);
    await main(env(), { sdk, fetchImpl: oidc, root: '/app' });
    const o = /** @type {Loose} */ (seen.options);
    const pre = o.hooks.PreToolUse[0].hooks[0];
    const post = o.hooks.PostToolUse[0].hooks[0];
    expect(await pre({ tool_name: 'Bash', tool_input: { command: 'ls' } })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(await pre({ tool_name: 'Read', tool_input: { file_path: '/app/a.ts' } })).toEqual({
      continue: true,
    });
    const url = 'https://docs.example.com/x';
    expect(await pre({ tool_name: 'WebFetch', tool_input: { url } })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await post({ tool_name: 'WebSearch', tool_response: `found ${url}` });
    expect(await pre({ tool_name: 'WebFetch', tool_input: { url } })).toEqual({ continue: true });
  });

  it("wraps each tool's result for the SDK, an error flagged", async () => {
    const { sdk, seen } = fakeSdk([success]);
    await main(env(), { sdk, fetchImpl: oidc, root: '/app' });
    const servers = /** @type {Loose} */ (seen.options).mcpServers;
    const list = /** @type {{ name: string, handler: Loose }[]} */ (
      /** @type {unknown} */ (servers.review.tools)
    );
    const show = /** @type {{ handler: Loose }} */ (list.find((t) => t.name === 'show'));
    expect(await show.handler({ ref: 'HEAD~2', path: 'a.ts' })).toEqual({
      content: [{ type: 'text', text: 'ref must be HEAD or origin/main' }],
      isError: true,
    });
    expect(list.map((t) => t.name)).toEqual([
      'diff',
      'diff_list',
      'diff_stat',
      'show',
      'log',
      'commit',
      'pr',
      'post_summary',
    ]);
    expect(servers.github_inline_comment.tools[0].name).toBe('create_inline_comment');
  });

  it('stops on spent credit, saying so, rather than failing', async () => {
    const credit = { ...success, is_error: true, result: 'API Error: Credit balance is too low' };
    const { sdk } = fakeSdk([credit]);
    expect(await main(env(), { sdk, fetchImpl: oidc, root: '/app' })).toMatchObject({
      stopped: 'credit',
      finished: false,
    });
  });

  it("fails a pass that didn't finish, or threw, keeping what it got", async () => {
    const capped = { ...success, subtype: 'error_max_turns', is_error: true, result: undefined };
    expect(
      await main(env(), { sdk: fakeSdk([capped]).sdk, fetchImpl: oidc, root: '/app' }),
    ).toMatchObject({
      stopped: null,
      finished: false,
    });
    const threw = await main(env(), {
      sdk: fakeSdk([], { throws: 'Claude Code process exited' }).sdk,
      fetchImpl: oidc,
      root: '/app',
    });
    expect(threw).toMatchObject({ stopped: null, finished: false });
    expect(threw.report).toContain('The pass failed: Claude Code process exited');
    expect(JSON.parse(readFileSync(threw.executionFile, 'utf8'))).toEqual([]);
  });

  it('signs in with an API key instead, with no OIDC token', async () => {
    const { sdk, seen } = fakeSdk([success]);
    await main(env({ ANTHROPIC_API_KEY: 'sk-test', ACTIONS_ID_TOKEN_REQUEST_URL: '' }), {
      sdk,
      fetchImpl: fakeFetch({}),
      root: '/app',
    });
    const o = /** @type {Loose} */ (seen.options);
    expect(o.env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(o.env.ANTHROPIC_IDENTITY_TOKEN_FILE).toBeUndefined();
    expect(o.settings).toBeUndefined();
  });

  it('needs its inputs', async () => {
    await expect(
      main(env({ REPO: '' }), { sdk: fakeSdk([]).sdk, fetchImpl: oidc }),
    ).rejects.toThrow('REPO is not set');
  });
});

describe('oidcToken', () => {
  it('needs id-token: write, and a token back', async () => {
    await expect(oidcToken({}, oidc)).rejects.toThrow('id-token: write');
    const vars = { ACTIONS_ID_TOKEN_REQUEST_URL: OIDC, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'b' };
    await expect(oidcToken(vars, fakeFetch({}))).rejects.toThrow('failed: 404');
    const empty = fakeFetch({
      [`GET ${OIDC}&audience=${encodeURIComponent('https://api.anthropic.com')}`]: [200, {}],
    });
    await expect(oidcToken(vars, empty)).rejects.toThrow('GitHub gave no OIDC token');
  });
});

describe('helpers', () => {
  it('tells spent credit and limits from other failures, by the API only', () => {
    const failed = (/** @type {string} */ result) => [{ ...success, is_error: true, result }];
    expect(stoppedBy(failed('API Error: Credit balance is too low'), '')).toBe('credit');
    expect(stoppedBy([{ type: 'assistant', error: 'billing_error' }, success], 'x')).toBe('credit');
    expect(stoppedBy(failed('You have reached your workspace spend limit'), '')).toBe('limit');
    expect(stoppedBy([], 'Credit balance is too low')).toBe('credit');
    // A transient rate limit is a failure to re-run, not a stop.
    expect(stoppedBy(failed('{"type":"rate_limit_error"}'), '')).toBeNull();
    expect(stoppedBy(failed('error_max_turns'), '')).toBeNull();
  });
  it("stops on a subscription's usage limit, read from the API's error code", () => {
    /** @type {Record<string, unknown>[]} */
    const limited = JSON.parse(
      readFileSync(path.join(HERE, 'fixtures', 'usage-limit.json'), 'utf8'),
    );
    expect(stoppedBy(limited, '')).toBe('limit');
    // The weekly window, with only the assistant message carrying the code.
    const weekly = limited.map((m) =>
      m.type === 'result'
        ? { ...m, api_error: undefined, result: "You've hit your weekly limit" }
        : m.type === 'assistant'
          ? {
              ...m,
              api_error_params: {
                rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day' },
              },
            }
          : m,
    );
    expect(stoppedBy(weekly, '')).toBe('limit');
    // The code on a pass that finished, or with no error, is no stop.
    const finished = limited.map((m) => (m.type === 'result' ? { ...m, is_error: false } : m));
    expect(stoppedBy(finished, '')).toBeNull();
    expect(
      stoppedBy([{ ...success, is_error: true, result: 'x', api_error: 'overloaded' }], ''),
    ).toBeNull();
  });
  it("never stops on the reviewer's own words in a pass that finished", () => {
    const words = {
      ...success,
      result: 'This PR handles the spend limit and credit balance is too low errors.',
    };
    expect(stoppedBy([words], '')).toBeNull();
    expect(
      stoppedBy([{ type: 'assistant', message: { content: 'spend limit' } }, success], ''),
    ).toBeNull();
  });
  it('finds the last result, and reports a pass without one', () => {
    expect(lastResult([{ type: 'result', n: 1 }, null, { type: 'result', n: 2 }])).toEqual({
      type: 'result',
      n: 2,
    });
    expect(lastResult([])).toBeUndefined();
    expect(report(undefined)).toContain('no result');
    expect(report({ subtype: 'success', num_turns: 1 })).toContain('unknown');
  });
  it('gives the reviewer only the allowed environment', () => {
    const out = reviewerEnv(
      { PATH: '/bin', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', AWS_SECRET: 'z', ANTHROPIC_API_KEY: '' },
      { tokenFile: '/t', configDir: '/c' },
    );
    expect(out).toEqual({
      PATH: '/bin',
      ANTHROPIC_IDENTITY_TOKEN_FILE: '/t',
      CLAUDE_CONFIG_DIR: '/c',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'jbhirsh-ci-review',
    });
  });
});
