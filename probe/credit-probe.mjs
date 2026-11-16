// @ts-nocheck -- a one-off probe on its own branch, never merged; its SDKs are
// installed by its workflow, not this repo's package.json.
// One-off probe for #68, step 0. Never merged: it lives on the credit-probe
// branch, which is deleted once the results are recorded in #68.
//
// Proves three things, signed in by workload identity federation (the
// ANTHROPIC_FEDERATION_RULE_ID, _ORGANIZATION_ID, _SERVICE_ACCOUNT_ID,
// _WORKSPACE_ID and _IDENTITY_TOKEN_FILE variables both SDKs read):
//   1. a plain Messages API call is paid from the Max plan's API credit;
//   2. an Agent SDK run is too;
//   3. what a lean review costs, against Claude Code's default prompt and
//      tools on the same PR, and against the lean review with an Opus
//      advisor (the server-side advisor tool, set by the `advisorModel`
//      setting), whose cost shows apart in `modelUsage`.
// Each run's messages are written as an execution file, the shape
// coverage.mjs reads, and uploaded as an artifact for #68's fixtures.
//
// Nothing is posted: the inline comment tool only records, and Bash refuses
// any gh call that writes.
//
// CLI: node probe/credit-probe.mjs, from the reviewed checkout, with
//   ANTHROPIC_*        the federation variables above
//   PROMPT             the rendered review prompt (render.mjs)
//   CI_DIR             this repository, which the review may read
//   OUT_DIR            where the execution files go

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const { PROMPT = '', CI_DIR = '', OUT_DIR = '.' } = process.env;

const PROBE_NOTE = `

PROBE RUN: this review is a cost test and must post nothing. The inline comment tool records without posting. Don't post or update the summary comment with gh; print the summary as your final message instead.`;

/** The lean agent's whole system prompt, in place of Claude Code's. */
const LEAN_SYSTEM = `You are Claude Review, a code reviewer running non-interactively in CI on a pull request's checkout. Follow the user's instructions exactly. Use Read, Grep and Glob for files, and Bash only for the read-only git and gh commands allowed. Never edit files.`;

const GIT_READ = /^git (fetch|checkout|log|diff|show|blame|rev-parse|branch|ls-files)\b/;
const GH_WRITE = /(-X|--method)\s*(POST|PATCH|PUT|DELETE)|\s-[fF]\s|--field|--raw-field|--input/i;

/**
 * Today's review allowlist (review/action.yml), read-only: gh may only read.
 *
 * @param {string} command
 * @returns {boolean}
 */
function readOnlyCommand(command) {
  if (/[;`>]|\$\(/.test(command)) return false;
  return command.split(/&&|\|/).every((part) => {
    const c = part.trim();
    if (/^cd \S+$/.test(c) || GIT_READ.test(c)) return true;
    if (/^(head|tail|wc|sort|uniq|jq)\b/.test(c)) return true;
    if (/^gh pr (view|diff|checks|list)\b/.test(c)) return true;
    return /^gh api\b/.test(c) && !GH_WRITE.test(c);
  });
}

/** An inline comment tool that records instead of posting. */
function recorder() {
  /** @type {unknown[]} */
  const comments = [];
  const server = createSdkMcpServer({
    name: 'github_inline_comment',
    alwaysLoad: true,
    tools: [
      tool(
        'create_inline_comment',
        'Records an inline review comment on a line of the PR diff (probe: not posted).',
        { path: z.string(), line: z.number(), body: z.string(), startLine: z.number().optional() },
        async (args) => {
          comments.push(args);
          return {
            content: [{ type: 'text', text: `Recorded comment on ${args.path}:${args.line}.` }],
          };
        },
      ),
    ],
  });
  return { server, comments };
}

/**
 * Writes a fresh GitHub OIDC token to ANTHROPIC_IDENTITY_TOKEN_FILE. A token
 * can be exchanged only once (its jti), so each sign-in (the Messages call,
 * then each review's Claude Code process) needs its own.
 */
async function freshToken() {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = process.env;
  const res = await fetch(`${url}&audience=${encodeURIComponent('https://api.anthropic.com')}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) throw new Error(`OIDC token request failed: ${res.status}`);
  const { value } = await res.json();
  writeFileSync(process.env.ANTHROPIC_IDENTITY_TOKEN_FILE, value, { mode: 0o600 });
}

async function messagesCall() {
  try {
    const r = await new Anthropic().messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the word ok.' }],
    });
    console.log('Messages API: ok', JSON.stringify(r.usage));
    return true;
  } catch (e) {
    const err = /** @type {{status?: number, error?: unknown, message?: string}} */ (e);
    console.log(
      `::error title=Messages API refused::${err.status} ${JSON.stringify(err.error ?? err.message)}`,
    );
    return false;
  }
}

/** @param {'lean' | 'default' | 'advisor'} kind */
async function review(kind) {
  const rec = recorder();
  /** @type {unknown[]} */
  const messages = [];
  const run = query({
    prompt: PROMPT + PROBE_NOTE,
    options: {
      model: 'sonnet',
      maxTurns: 200,
      settingSources: [],
      additionalDirectories: CI_DIR ? [CI_DIR] : [],
      mcpServers: { github_inline_comment: rec.server },
      ...(kind === 'default'
        ? { tools: { type: 'preset', preset: 'claude_code' } }
        : { systemPrompt: LEAN_SYSTEM, tools: ['Read', 'Grep', 'Glob', 'Bash'] }),
      ...(kind === 'advisor' ? { settings: { advisorModel: 'opus' } } : {}),
      disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
      canUseTool: async (name, input) => {
        if (name === 'Bash' && !readOnlyCommand(String(input.command ?? ''))) {
          return { behavior: 'deny', message: 'Probe run: only read-only git and gh commands.' };
        }
        return { behavior: 'allow', updatedInput: input };
      },
    },
  });
  /** @type {any} */
  let result;
  for await (const m of run) {
    messages.push(m);
    if (m.type === 'result') result = m;
  }
  writeFileSync(path.join(OUT_DIR, `execution-${kind}.json`), JSON.stringify(messages, null, 2));
  const summary = {
    kind,
    subtype: result?.subtype,
    is_error: result?.is_error,
    num_turns: result?.num_turns,
    total_cost_usd: result?.total_cost_usd,
    usage: result?.usage,
    modelUsage: result?.modelUsage,
    inline_comments: rec.comments.length,
  };
  console.log(`${kind} review:`, JSON.stringify(summary, null, 2));
  if (result?.is_error)
    console.log(
      `::error title=${kind} review failed::${JSON.stringify(result.result ?? result.subtype)}`,
    );
  if (typeof result?.result === 'string')
    console.log(`--- ${kind} final message ---\n${result.result}`);
  console.log(`--- ${kind} inline comments ---\n${JSON.stringify(rec.comments, null, 2)}`);
  return summary;
}

await freshToken();
if (!(await messagesCall())) process.exit(1);
/** @type {unknown[]} */
const results = [];
for (const kind of /** @type {const} */ (['lean', 'default', 'advisor'])) {
  await freshToken();
  results.push(await review(kind));
}
writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(results, null, 2));
const rows = results.map(
  (r) =>
    `| ${r.kind} | ${r.subtype} | ${r.num_turns} | $${r.total_cost_usd?.toFixed(3)} | ${r.inline_comments} |`,
);
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '| Run | Result | Turns | Cost | Inline comments |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      '',
    ].join('\n'),
    { flag: 'a' },
  );
}
