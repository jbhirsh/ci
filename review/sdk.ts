// Claude Review's pass: runs one review pass (render.ts's prompt) on the
// Claude Agent SDK on the runner. The Max plan's API credit pays for Agent
// SDK runs but not for Claude Code, which is why the review left
// claude-code-action (jbhirsh/ci#68, whose step 0 proved it on #69).
//
// It writes the execution file (the SDK's messages, one JSON array) that
// coverage.ts checks for what the pass read, and that carry.ts and the
// follow-up build on. The reviewer reads and reports, nothing else:
//   - tools: Read, Grep, Glob, WebSearch, WebFetch and the in-process tools
//     (tools.ts: git reads, the PR, the two posting tools). No Bash, Edit,
//     Write or Agent.
//   - every call passes the guard (guard.ts) as a PreToolUse hook, which
//     runs ahead of every other permission check: reads stay inside the
//     checkout and this repo, searches are capped, a page is opened only
//     from a link the reviewer was shown.
//   - permissionMode "default", never "auto", whose classifier could
//     approve a call; the allowed tools are approved by `allowedTools`, and
//     anything else has no one to ask, so it's refused.
//   - settingSources ["project"]: the base branch's CLAUDE.md (action.yml
//     restores it and `.claude/` from the base first), so a PR can't change
//     what loads. strictMcpConfig: no MCP servers but ours.
//   - env: an allowlist. The GitHub token (the job's own; comments come
//     from github-actions[bot]) is held by this process for the posting
//     tools and never reaches the reviewer's.
//
// Model: "sonnet", the alias for the newest Sonnet. With `review.advisor`
// set, Sonnet may consult that model (the advisor tool, `advisorModel`).
//
// Sign-in: workload identity federation, with a fresh GitHub OIDC token per
// pass (a token can be exchanged once: `jti_reused` otherwise), written to
// ANTHROPIC_IDENTITY_TOKEN_FILE; the federated token lasts an hour, longer
// than the job's timeout. An API key (ANTHROPIC_API_KEY) works instead.
//
// A pass refused for credit or a spend or usage limit isn't the PR's fault.
// With CLAUDE_CODE_OAUTH_TOKEN set (the owner's Claude subscription, made
// by `claude setup-token`), the same pass runs once more on it, from a
// fresh config folder with a fresh guard, so it can't read the stopped
// attempt's files (#57). Its prompt says an earlier attempt may have left
// comments, not to repeat. The retry's cost goes into the subscription's
// own 5-hour and weekly limits, which the owner's interactive Claude Code
// shares. Each attempt's environment holds exactly one credential, since
// the bundled CLI picks by precedence (ANTHROPIC_AUTH_TOKEN, then
// ANTHROPIC_API_KEY, then CLAUDE_CODE_OAUTH_TOKEN, then federation): the
// API attempt never sees the subscription token, nor the retry the key,
// the federation IDs or the OIDC token file. A pass still stopped after
// that, or with no token to retry with, ends with a warning and the output
// `stopped` (credit or limit); action.yml skips the coverage check and the
// follow-up on it, and stopped.ts fails the check.
//
// CLI: `node sdk.ts`, run from the app's checkout, with
//   PROMPT          the rendered prompt (render.ts)
//   MAX_TURNS       the turn cap
//   ADVISOR         the advisor model, or empty
//   CI_DIR          this repo's checkout (SHARED_CI)
//   REPO, PR, BASE_REF, HEAD_SHA   the PR
//   GH_TOKEN        the job's token, for the posting tools
//   OUT_FILE        where the execution file goes: the last attempt's
//                   messages only, so coverage credits only what it read
//   RUNNER_TEMP     for the OIDC token file and the SDK's own files
//   the federation variables (ANTHROPIC_FEDERATION_RULE_ID,
//   _ORGANIZATION_ID, _SERVICE_ACCOUNT_ID, _WORKSPACE_ID) or
//   ANTHROPIC_API_KEY, and the Actions OIDC variables
//   CLAUDE_CODE_OAUTH_TOKEN   the subscription to retry a stop on, or empty
// Step outputs: `execution_file`, `stopped`, `fallback` ("true" when the
// subscription retry ran) and `turns` (the most any attempt ran). Exits 1 when the pass didn't finish (result.ts
// then judges it), 0 otherwise.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setOutput, summary } from '../lib/actions.mjs';
import { appRoot } from '../lib/app.mjs';
import { createGuard } from './guard.ts';
import { github } from './github.ts';
import * as tools from './tools.ts';
import { z } from 'zod';
import type { Fetch } from './github.ts';
import type { Context, Result } from './tools.ts';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The built-in tools the reviewer has. */
export const BUILT_IN = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
/** Built-in tools it never has, refused by name as well as by the guard. */
export const DISALLOWED = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent'];
/** The environment every attempt's process gets, besides its credential. */
const ENV_ALLOWED = ['PATH', 'HOME', 'LANG', 'TMPDIR'];
/** The federation variables, the API attempt's credential without a key. */
const FEDERATION = [
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_WORKSPACE_ID',
];
/** What the retry's prompt adds: the stopped attempt may have posted. */
export const RETRY_NOTE = [
  '',
  'An earlier attempt at this pass stopped, out of API credit or at a limit,',
  'and may already have left inline comments and a summary on the PR. Read',
  "them with `mcp__review__pr` first, and don't post an inline comment",
  "that's already there.",
].join('\n');

/** how an attempt signs in: the API (a key, or federation), or the owner's Claude subscription */
export type Auth = 'api' | 'subscription';

/**
 * The reviewer's environment: the allowlist, its one credential and where
 * its config folder is. The API attempt gets the key, or else the
 * federation variables and the OIDC token file; the subscription retry
 * gets CLAUDE_CODE_OAUTH_TOKEN and nothing else that signs in.
 */
export function reviewerEnv(
  env: Record<string, string | undefined>,
  { auth, tokenFile, configDir }: { auth: Auth; tokenFile: string | null; configDir: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  const pass = (name: string) => {
    const value = env[name];
    if (value) out[name] = value;
  };
  ENV_ALLOWED.forEach(pass);
  if (auth === 'subscription') {
    pass('CLAUDE_CODE_OAUTH_TOKEN');
  } else if (env.ANTHROPIC_API_KEY) {
    pass('ANTHROPIC_API_KEY');
  } else {
    FEDERATION.forEach(pass);
    if (tokenFile) out.ANTHROPIC_IDENTITY_TOKEN_FILE = tokenFile;
  }
  out.CLAUDE_CONFIG_DIR = configDir;
  out.CLAUDE_AGENT_SDK_CLIENT_APP = 'jbhirsh-ci-review';
  return out;
}

/**
 * A fresh GitHub OIDC token for the Anthropic exchange, from the Actions
 * runtime (the job needs `id-token: write`).
 */
export async function oidcToken(
  env: Record<string, string | undefined>,
  fetchImpl: Fetch,
): Promise<string> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) {
    throw new Error('no GitHub OIDC token: the job needs `permissions: id-token: write`');
  }
  const res = await fetchImpl(
    `${url}&audience=${encodeURIComponent('https://api.anthropic.com')}`,
    {
      headers: { authorization: `Bearer ${bearer}` },
    },
  );
  if (!res.ok) throw new Error(`the GitHub OIDC token request failed: ${res.status}`);
  const { value } = (await res.json()) as { value?: unknown };
  if (typeof value !== 'string' || value === '') throw new Error('GitHub gave no OIDC token');
  return value;
}

/** The API's error code for a subscription's spent usage window. */
const USAGE_LIMIT = 'usage_limit_reached';

/**
 * Why a pass that failed stopped short for reasons not the PR's: out of
 * credit, or a spend or usage limit. Null for any other failure, and for a
 * pass that finished, whatever its text says: the reviewer's own words
 * (a review of a PR about rate limits) never count, only the API's error
 * (the SDK's `error` on an assistant message, the result's error text, or
 * the query's thrown error). A subscription's usage limit (its 5-hour or
 * weekly window) is read from its `api_error`, `usage_limit_reached`, on
 * the result or the limited assistant message, since its text ("You've hit
 * your 5-hour limit") names no usage limit (BoardGames #320). A transient
 * rate limit or overload isn't a stop: it's a failure, re-run like any
 * other.
 *
 * @param messages the pass's messages
 * @param failure what the query threw, or ''
 */
export function stoppedBy(messages: unknown[], failure: string): 'credit' | 'limit' | null {
  const result = lastResult(messages);
  const failed = failure !== '' || result?.is_error === true;
  if (!failed) return null;
  const errors: string[] = [failure];
  if (result?.is_error === true) {
    if (typeof result.result === 'string') errors.push(result.result);
    if (Array.isArray(result.errors)) errors.push(...result.errors.map(String));
  }
  let billing = false;
  let usage = result?.is_error === true && result.api_error === USAGE_LIMIT;
  for (const m of messages) {
    const message = (m && typeof m === 'object' ? m : {}) as {
      type?: unknown;
      error?: unknown;
      api_error?: unknown;
    };
    if (message.type === 'assistant' && typeof message.error === 'string') {
      if (message.error === 'billing_error') billing = true;
      if (message.api_error === USAGE_LIMIT) usage = true;
      errors.push(JSON.stringify(m));
    }
  }
  const text = errors.join('\n');
  if (billing || /credit balance is too low/i.test(text)) return 'credit';
  if (usage || /(spend|spending|usage) limit/i.test(text)) return 'limit';
  return null;
}

/**
 * The last result message of a pass, if any.
 */
export function lastResult(messages: unknown[]): Record<string, unknown> | undefined {
  let result: Record<string, unknown> | undefined;
  for (const m of messages) {
    if (m && typeof m === 'object' && (m as { type?: unknown }).type === 'result') {
      result = m as Record<string, unknown>;
    }
  }
  return result;
}

/**
 * The step summary's lines for a pass: how it ended, what it cost, and each
 * model's share (the advisor's shows as its own row when it ran).
 */
export function report(result: Record<string, unknown> | undefined): string {
  if (!result) return 'Claude Review (SDK): the pass gave no result.';
  const cost =
    typeof result.total_cost_usd === 'number' ? `$${result.total_cost_usd.toFixed(3)}` : 'unknown';
  const lines = [
    `Claude Review (SDK): ${String(result.subtype)}, ${String(result.num_turns)} turns, ${cost}.`,
    '',
    '| Model | Cost | Input | Cache write | Cache read | Output |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const usage = (
    result.modelUsage && typeof result.modelUsage === 'object' ? result.modelUsage : {}
  ) as Record<string, Record<string, unknown>>;
  for (const [model, u] of Object.entries(usage)) {
    const n = (key: string) => (typeof u[key] === 'number' ? String(u[key]) : '');
    const c = typeof u.costUSD === 'number' ? `$${u.costUSD.toFixed(3)}` : '';
    lines.push(
      `| ${model} | ${c} | ${n('inputTokens')} | ${n('cacheCreationInputTokens')} | ${n('cacheReadInputTokens')} | ${n('outputTokens')} |`,
    );
  }
  return lines.join('\n');
}

/**
 * The SDK's query options for one pass.
 */
export function queryOptions({
  sdk,
  ctx,
  guard,
  run,
}: {
  sdk: typeof import('@anthropic-ai/claude-agent-sdk');
  ctx: Context;
  guard: ReturnType<typeof createGuard>;
  run: { maxTurns: number; advisor: string | null; ciDir: string; env: Record<string, string> };
}): Options {
  const { createSdkMcpServer, tool } = sdk;
  const wrap = async (r: Result | Promise<Result>): Promise<CallToolResult> => {
    const { text, isError } = await r;
    return { content: [{ type: 'text', text }], isError: isError === true };
  };
  const review = createSdkMcpServer({
    name: 'review',
    alwaysLoad: true,
    tools: [
      tool(
        'diff',
        "The PR's diff, whole or for the files named (both paths of a rename). A long diff comes in numbered parts: ask for each with part.",
        { paths: z.array(z.string()).optional(), part: z.number().int().optional() },
        async (a) => wrap(tools.diff(ctx, a)),
      ),
      tool(
        'diff_list',
        'Each file the PR changes, with how (`git diff --name-status`).',
        {},
        async () => wrap(tools.listing(ctx, '--name-status')),
      ),
      tool('diff_stat', 'How much each file changed (`git diff --stat`).', {}, async () =>
        wrap(tools.listing(ctx, '--stat')),
      ),
      tool(
        'show',
        'A file as HEAD (the PR) or the base branch holds it.',
        { ref: z.string(), path: z.string() },
        async (a) => wrap(tools.show(ctx, a)),
      ),
      tool('log', "The PR's commits, oldest first: short hash, author, subject.", {}, async () =>
        wrap(tools.log(ctx)),
      ),
      tool(
        'commit',
        'One of the PR commits, with the files it touched.',
        { sha: z.string() },
        async (a) => wrap(tools.commit(ctx, a)),
      ),
      tool(
        'pr',
        "The PR's title, description, review comments and this review's earlier summary.",
        {},
        async () => wrap(tools.pr(ctx)),
      ),
      tool(
        'post_summary',
        "Creates or replaces this review's summary comment on the PR.",
        { body: z.string() },
        async (a) => wrap(tools.postSummary(ctx, a)),
      ),
    ],
  });
  const comments = createSdkMcpServer({
    name: 'github_inline_comment',
    alwaysLoad: true,
    tools: [
      tool(
        'create_inline_comment',
        'Leaves an inline review comment on a line (or lines, with startLine) of a file the PR changes.',
        {
          path: z.string(),
          line: z.number(),
          startLine: z.number().optional(),
          side: z.enum(['RIGHT', 'LEFT']).optional(),
          body: z.string(),
        },
        async (a) => wrap(tools.inlineComment(ctx, a)),
      ),
    ],
  });
  const ownTools = [
    ...['diff', 'diff_list', 'diff_stat', 'show', 'log', 'commit', 'pr', 'post_summary'].map(
      (t) => `mcp__review__${t}`,
    ),
    'mcp__github_inline_comment__create_inline_comment',
  ];
  return {
    model: 'sonnet',
    ...(run.advisor ? { settings: { advisorModel: run.advisor } } : {}),
    systemPrompt: readFileSync(path.join(HERE, 'system.md'), 'utf8'),
    tools: BUILT_IN,
    allowedTools: [...BUILT_IN, ...ownTools],
    disallowedTools: DISALLOWED,
    permissionMode: 'default',
    settingSources: ['project'],
    strictMcpConfig: true,
    mcpServers: { review, github_inline_comment: comments },
    maxTurns: run.maxTurns,
    cwd: ctx.repoDir,
    additionalDirectories: [run.ciDir],
    env: run.env,
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              const { tool_name, tool_input } = input as { tool_name: string; tool_input: unknown };
              const decision = guard.before(tool_name, tool_input);
              return decision.allow
                ? { continue: true }
                : {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: decision.reason,
                    },
                  };
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            async (input) => {
              const { tool_name, tool_response } = input as {
                tool_name: string;
                tool_response: unknown;
              };
              guard.after(tool_name, tool_response);
              return { continue: true };
            },
          ],
        },
      ],
    },
  };
}

export type Attempt = {
  messages: unknown[];
  stopped: 'credit' | 'limit' | null;
  finished: boolean;
  /** how many turns it ran (0 when it gave no count) */
  turns: number;
  report: string;
};

/**
 * Runs one attempt at the pass, signed in as `auth`, with its own config
 * folder and guard.
 */
async function attempt({
  sdk,
  ctx,
  env,
  as,
  run,
}: {
  sdk: typeof import('@anthropic-ai/claude-agent-sdk');
  ctx: Context;
  env: Record<string, string | undefined>;
  as: { auth: Auth; tokenFile: string | null; configDir: string };
  run: { prompt: string; maxTurns: number; advisor: string | null; ciDir: string };
}): Promise<Attempt> {
  mkdirSync(as.configDir, { recursive: true });
  // The SDK saves long tool output under its config folder; the reviewer
  // reads it back, so it's one of the guard's roots.
  const guard = createGuard({ roots: [ctx.repoDir, run.ciDir, as.configDir], cwd: ctx.repoDir });
  const options = queryOptions({
    sdk,
    ctx,
    guard,
    run: { ...run, env: reviewerEnv(env, as) },
  });
  const messages: unknown[] = [];
  let failure = '';
  try {
    for await (const message of sdk.query({ prompt: run.prompt, options })) messages.push(message);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const result = lastResult(messages);
  return {
    messages,
    stopped: stoppedBy(messages, failure),
    finished: !failure && result?.subtype === 'success' && result.is_error !== true,
    turns: Number.isSafeInteger(result?.num_turns) ? (result?.num_turns as number) : 0,
    report: failure ? `${report(result)}\n\nThe pass failed: ${failure}` : report(result),
  };
}

/**
 * Runs one pass, and retries a stopped one on the subscription. Returns the
 * outputs and whether it finished.
 */
export async function main(
  env: Record<string, string | undefined>,
  deps: {
    sdk?: typeof import('@anthropic-ai/claude-agent-sdk');
    fetchImpl?: Fetch;
    root?: string;
  } = {},
): Promise<{
  executionFile: string;
  stopped: 'credit' | 'limit' | null;
  finished: boolean;
  fallback: boolean;
  turns: number;
  report: string;
}> {
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as Fetch);
  const sdk = deps.sdk ?? (await import('@anthropic-ai/claude-agent-sdk'));
  const root = deps.root ?? appRoot();
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const temp = path.join(need('RUNNER_TEMP'), 'claude-review-sdk');
  mkdirSync(temp, { recursive: true });

  let tokenFile = null;
  if (!env.ANTHROPIC_API_KEY) {
    tokenFile = path.join(temp, 'oidc-token');
    writeFileSync(tokenFile, await oidcToken(env, fetchImpl), { mode: 0o600 });
  }

  const ctx = {
    repoDir: root,
    base: env.BASE_REF || 'main',
    repo: need('REPO'),
    pr: need('PR'),
    headSha: need('HEAD_SHA'),
    api: github(need('GH_TOKEN'), fetchImpl),
  };
  const run = {
    prompt: need('PROMPT'),
    maxTurns: Number(env.MAX_TURNS) || 200,
    advisor: env.ADVISOR || null,
    ciDir: need('CI_DIR'),
  };
  const first = await attempt({
    sdk,
    ctx,
    env,
    as: { auth: 'api', tokenFile, configDir: path.join(temp, 'config') },
    run,
  });
  const fallback = first.stopped !== null && Boolean(env.CLAUDE_CODE_OAUTH_TOKEN);
  const last = fallback
    ? await attempt({
        sdk,
        ctx,
        env,
        as: { auth: 'subscription', tokenFile: null, configDir: path.join(temp, 'config-retry') },
        run: { ...run, prompt: `${run.prompt}\n${RETRY_NOTE}` },
      })
    : first;
  const executionFile = env.OUT_FILE || path.join(temp, 'execution.json');
  writeFileSync(executionFile, JSON.stringify(last.messages));
  return {
    executionFile,
    stopped: last.stopped,
    finished: last.finished,
    fallback,
    // How far the pass got: a stopped API attempt may have read and posted
    // more than a retry that stopped on its first turn.
    turns: Math.max(first.turns, last.turns),
    report: fallback
      ? `${first.report}\n\nStopped (${first.stopped}); retried on the Claude subscription:\n\n${last.report}`
      : last.report,
  };
}

/* c8 ignore start: the CLI's lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {
    executionFile,
    stopped,
    finished,
    fallback,
    turns,
    report: text,
  } = await main(process.env);
  setOutput('execution_file', executionFile);
  setOutput('stopped', stopped ?? '');
  setOutput('fallback', fallback ? 'true' : '');
  setOutput('turns', String(turns));
  summary(text);
  console.log(text);
  if (stopped) {
    const why =
      stopped === 'credit' ? 'the API credit is spent' : 'a spend or usage limit was reached';
    const retry = fallback
      ? 'The retry on the Claude subscription stopped too.'
      : 'No subscription token was given to retry on.';
    console.log(
      `::warning title=Claude Review stopped::Claude Review didn't finish: ${why}. ${retry}`,
    );
  } else if (!finished) {
    process.exit(1);
  }
}
/* c8 ignore stop */
