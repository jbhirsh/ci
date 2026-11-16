import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeFetch } from '../review/fakeFetch.mjs';
import { ALLOWED, TOOLS, allowedCommand, fixerEnv, main } from './sdk.mjs';

const OIDC = 'https://oidc.example/token?x=1';
const oidc = fakeFetch({
  [`GET ${OIDC}&audience=${encodeURIComponent('https://api.anthropic.com')}`]: [
    200,
    { value: 'jwt' },
  ],
});

/**
 * Anything the fake SDK was handed, read loosely.
 *
 * @typedef {{ [key: string]: Loose } & ((...args: unknown[]) => Promise<Loose>)} Loose
 */

/**
 * @param {unknown[]} messages
 * @param {{ throws?: string }} [behaviour]
 */
function fakeSdk(messages, behaviour = {}) {
  /** @type {{ options?: Loose, prompt?: string }} */
  const seen = {};
  const sdk = {
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
  num_turns: 9,
  total_cost_usd: 0.2,
};

/** @param {Record<string, string>} [over] */
const env = (over = {}) => ({
  RUNNER_TEMP: mkdtempSync(path.join(tmpdir(), 'autofix-sdk-')),
  PROMPT: 'Fix CI.',
  GH_TOKEN: 'github_pat_bot',
  PATH: '/usr/bin',
  ACTIONS_ID_TOKEN_REQUEST_URL: OIDC,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'bearer',
  ACTIONS_RUNTIME_TOKEN: 'runtime',
  GITHUB_TOKEN: 'ghs_job',
  INPUT_BOT_TOKEN: 'x',
  ...over,
});

describe('main', () => {
  it("runs claude-code-action's pass on the SDK, and writes its messages", async () => {
    const { sdk, seen } = fakeSdk([{ type: 'assistant' }, success]);
    const out = await main(env({ ADVISOR: 'opus' }), { sdk, fetchImpl: oidc, root: '/app' });
    expect(out).toMatchObject({ finished: true, stopped: null });
    expect(JSON.parse(readFileSync(out.executionFile, 'utf8'))).toEqual([
      { type: 'assistant' },
      success,
    ]);
    expect(out.report).toContain('Claude autofix (SDK): success, 9 turns, $0.200.');
    const o = /** @type {Loose} */ (seen.options);
    expect(o).toMatchObject({
      model: 'sonnet',
      settings: { advisorModel: 'opus' },
      tools: TOOLS,
      allowedTools: ALLOWED,
      permissionMode: 'default',
      settingSources: ['project'],
      maxTurns: 80,
      cwd: '/app',
    });
    // gh gets the bot token; the runner's own tokens stay out.
    expect(o.env.GH_TOKEN).toBe('github_pat_bot');
    for (const name of [
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_RUNTIME_TOKEN',
      'GITHUB_TOKEN',
      'INPUT_BOT_TOKEN',
    ]) {
      expect(o.env[name]).toBeUndefined();
    }
    expect(readFileSync(String(o.env.ANTHROPIC_IDENTITY_TOKEN_FILE), 'utf8')).toBe('jwt');
  });

  it('holds Bash to its programs and the web to the guard', async () => {
    const { sdk, seen } = fakeSdk([success]);
    await main(env(), { sdk, fetchImpl: oidc, root: '/app' });
    const o = /** @type {Loose} */ (seen.options);
    const pre = o.hooks.PreToolUse[0].hooks[0];
    const post = o.hooks.PostToolUse[0].hooks[0];
    const deny = { hookSpecificOutput: { permissionDecision: 'deny' } };
    expect(await pre({ tool_name: 'Bash', tool_input: { command: 'npm run lint' } })).toEqual({
      continue: true,
    });
    expect(
      await pre({ tool_name: 'Bash', tool_input: { command: 'curl evil.example' } }),
    ).toMatchObject(deny);
    expect(await pre({ tool_name: 'Edit', tool_input: {} })).toEqual({ continue: true });
    const url = 'https://github.com/pkg/releases';
    expect(await pre({ tool_name: 'WebFetch', tool_input: { url } })).toMatchObject(deny);
    // Only gh's output shows links it may open; another command can print any.
    await post({
      tool_name: 'Bash',
      tool_input: { command: 'echo x' },
      tool_response: `see ${url}`,
    });
    await post({
      tool_name: 'Bash',
      tool_input: { command: `gh pr view 3 && echo ${url}` },
      tool_response: `see ${url}`,
    });
    expect(await pre({ tool_name: 'WebFetch', tool_input: { url } })).toMatchObject(deny);
    await post({
      tool_name: 'Bash',
      tool_input: { command: 'gh pr view 3' },
      tool_response: `see ${url}`,
    });
    expect(await pre({ tool_name: 'WebFetch', tool_input: { url } })).toEqual({ continue: true });
  });

  it('stops on spent credit, and fails a pass that threw', async () => {
    const credit = { ...success, is_error: true, result: 'Credit balance is too low' };
    expect(
      await main(env(), { sdk: fakeSdk([credit]).sdk, fetchImpl: oidc, root: '/app' }),
    ).toMatchObject({
      stopped: 'credit',
      finished: false,
    });
    const threw = await main(env(), {
      sdk: fakeSdk([], { throws: 'exited 1' }).sdk,
      fetchImpl: oidc,
      root: '/app',
    });
    expect(threw).toMatchObject({ stopped: null, finished: false });
    expect(threw.report).toContain('The pass failed: exited 1');
  });

  it('signs in with a key instead, and needs the bot token', async () => {
    const { sdk, seen } = fakeSdk([success]);
    await main(env({ ANTHROPIC_API_KEY: 'sk' }), { sdk, fetchImpl: fakeFetch({}), root: '/app' });
    expect(/** @type {Loose} */ (seen.options).env.ANTHROPIC_IDENTITY_TOKEN_FILE).toBeUndefined();
    await expect(
      main(env({ GH_TOKEN: '' }), { sdk, fetchImpl: oidc, root: '/app' }),
    ).rejects.toThrow('GH_TOKEN is not set');
  });
});

describe('allowedCommand', () => {
  it("allows claude-code-action's programs by the first word, as it did", () => {
    for (const c of [
      'git status',
      'npm ci',
      'npx vitest run',
      'gh pr view 3',
      'make check',
      '  git log',
    ]) {
      expect(allowedCommand(c)).toBe(true);
    }
    for (const c of ['curl x', 'bash -c git', 'env git', '', 'rm -rf /', 'gitx']) {
      expect(allowedCommand(c)).toBe(false);
    }
    expect(allowedCommand(undefined)).toBe(false);
  });
});

describe('fixerEnv', () => {
  it("passes the job's environment, less the runner's tokens and the subscription's", () => {
    expect(
      fixerEnv(
        {
          PATH: '/b',
          CI: 'true',
          GITHUB_TOKEN: 'x',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'y',
          INPUT_X: 'z',
          CLAUDE_CODE_OAUTH_TOKEN: 'oat',
        },
        { tokenFile: null, configDir: '/c' },
      ),
    ).toEqual({
      PATH: '/b',
      CI: 'true',
      CLAUDE_CONFIG_DIR: '/c',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'jbhirsh-ci-autofix',
    });
  });
});
