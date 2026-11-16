// Claude autofix's fixer pass: runs one pass (ci-fix.md or review-fix.md) on
// the Claude Agent SDK on the runner, in place of claude-code-action, which
// the Max plan's API credit doesn't pay for (jbhirsh/ci#68).
//
// A port of the claude-code-action pass, as the owner chose (#68): the same
// tools (Read, Edit, Write, Glob, Grep, Agent for review-fix's sub-agents,
// and Bash for git, npm, npx, gh and make, by the same allow rules, with a
// PreToolUse hook as a second line), the same 80-turn cap, and Claude pushes
// and posts itself. It does so with the app's BOT_PR_TOKEN (the stub's
// `bot_token`), which action.yml sets as git's credential and gh's token;
// that token lasts longer than the Claude app's, and the bump's npm scripts
// run in this job, a risk the owner accepted. WebSearch and WebFetch are
// added under the review's guard (../review/guard.mjs): a few searches, a
// page only from a link it was shown (a package's changelog, say).
//
// Model "sonnet"; with `autofix.advisor`, Sonnet may consult that model.
// Sign-in is the review's: federation with a fresh OIDC token, or an API
// key. A pass refused for credit or a spend or usage limit (a
// subscription's `usage_limit_reached` among them, ../review/sdk.mjs's
// stoppedBy) warns and passes, posting no failure. The execution file is the SDK's messages, the shape crash.mjs
// already reads.
//
// CLI: `node sdk.mjs`, run from the app's checkout, with PROMPT, ADVISOR,
// GH_TOKEN (the bot token, for gh), OUT_FILE, RUNNER_TEMP, and the review's
// sign-in variables. Step output `execution_file`. Exits 1 when the pass
// didn't finish, for crash.mjs to judge.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput, summary } from '../lib/actions.mjs';
import { appRoot } from '../lib/app.mjs';
import { createGuard } from '../review/guard.mjs';
import { lastResult, oidcToken, report, stoppedBy } from '../review/sdk.mjs';

/** The tools the fixer has: claude-code-action's, plus the web. */
export const TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Agent',
  'Bash',
  'WebSearch',
  'WebFetch',
];
/**
 * What's approved without asking: the tools, and Bash only for those
 * programs, as claude-code-action's `--allowedTools` had it. Claude Code
 * checks each part of a compound command against these rules, and with no
 * one to ask (permissionMode "default", no canUseTool) anything else is
 * refused.
 */
export const ALLOWED = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Agent',
  'WebSearch',
  'WebFetch',
  'Bash(git:*)',
  'Bash(npm:*)',
  'Bash(npx:*)',
  'Bash(gh:*)',
  'Bash(make:*)',
];
/** The programs Bash may start: the hook's second line, by first word. */
const PROGRAMS = new Set(['git', 'npm', 'npx', 'gh', 'make']);
/**
 * Environment the fixer's process never gets. CLAUDE_CODE_OAUTH_TOKEN, the
 * owner's subscription, is the review's retry credential (#57): here it
 * would reach the bump's npm scripts, and outrank the federated sign-in.
 */
const WITHHELD =
  /^(ACTIONS_ID_TOKEN_REQUEST_|ACTIONS_RUNTIME_TOKEN$|GITHUB_TOKEN$|INPUT_|CLAUDE_CODE_OAUTH_TOKEN$)/;

/**
 * Whether a Bash command starts one of the allowed programs, as
 * `Bash(git:*)` and the like allowed: its first word only.
 *
 * @param {unknown} command
 * @returns {boolean}
 */
export function allowedCommand(command) {
  if (typeof command !== 'string') return false;
  const first = command.trim().split(/\s+/)[0] ?? '';
  return PROGRAMS.has(first);
}

/**
 * The fixer's environment: the job's, less the runner's own tokens, plus
 * the sign-in file and the SDK's folder.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ tokenFile: string | null, configDir: string }} files
 * @returns {Record<string, string>}
 */
export function fixerEnv(env, { tokenFile, configDir }) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !WITHHELD.test(name)) out[name] = value;
  }
  if (tokenFile) out.ANTHROPIC_IDENTITY_TOKEN_FILE = tokenFile;
  out.CLAUDE_CONFIG_DIR = configDir;
  out.CLAUDE_AGENT_SDK_CLIENT_APP = 'jbhirsh-ci-autofix';
  return out;
}

/**
 * The SDK's query options for one pass.
 *
 * @param {{ cwd: string, advisor: string | null, env: Record<string, string>, guard: ReturnType<typeof createGuard> }} run
 * @returns {import('@anthropic-ai/claude-agent-sdk').Options}
 */
export function queryOptions({ cwd, advisor, env, guard }) {
  return {
    model: 'sonnet',
    ...(advisor ? { settings: { advisorModel: advisor } } : {}),
    tools: TOOLS,
    allowedTools: ALLOWED,
    permissionMode: 'default',
    settingSources: ['project'],
    strictMcpConfig: true,
    maxTurns: 80,
    cwd,
    env,
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              const { tool_name, tool_input } =
                /** @type {{ tool_name: string, tool_input: unknown }} */ (input);
              const args = /** @type {Record<string, unknown>} */ (tool_input ?? {});
              /** @type {string | null} */
              let refused = null;
              if (tool_name === 'Bash' && !allowedCommand(args.command)) {
                refused = `Bash may run only ${[...PROGRAMS].join(', ')}`;
              } else if (tool_name === 'WebSearch' || tool_name === 'WebFetch') {
                const decision = guard.before(tool_name, tool_input);
                if (!decision.allow) refused = decision.reason;
              }
              return refused
                ? {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: refused,
                    },
                  }
                : { continue: true };
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            async (input) => {
              const { tool_name, tool_response } =
                /** @type {{ tool_name: string, tool_response: unknown }} */ (input);
              // The pages it may open: from search results, and from what gh
              // shows of the PR (its description, a changelog link). Not from
              // other commands' output, which the fixer can make print any
              // URL.
              const { tool_input } = /** @type {{ tool_input?: { command?: unknown } }} */ (input);
              // gh alone: `gh x && echo <url>` would print a URL of its choosing.
              const fromGh =
                tool_name === 'Bash' &&
                /^\s*gh\s[^;&|`$<>\n]*$/.test(String(tool_input?.command ?? ''));
              guard.after(fromGh ? 'mcp__review__pr' : tool_name, tool_response);
              return { continue: true };
            },
          ],
        },
      ],
    },
  };
}

/**
 * Runs one pass. Returns its outputs and whether it finished.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ sdk?: typeof import('@anthropic-ai/claude-agent-sdk'), fetchImpl?: import('../review/github.mjs').Fetch, root?: string }} [deps]
 * @returns {Promise<{ executionFile: string, stopped: 'credit' | 'limit' | null, finished: boolean, report: string }>}
 */
export async function main(env, deps = {}) {
  const fetchImpl =
    deps.fetchImpl ??
    /** @type {import('../review/github.mjs').Fetch} */ (/** @type {unknown} */ (fetch));
  const sdk = deps.sdk ?? (await import('@anthropic-ai/claude-agent-sdk'));
  const root = deps.root ?? appRoot();
  const need = (/** @type {string} */ name) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const temp = path.join(need('RUNNER_TEMP'), 'claude-autofix-sdk');
  const configDir = path.join(temp, 'config');
  mkdirSync(configDir, { recursive: true });
  let tokenFile = null;
  if (!env.ANTHROPIC_API_KEY) {
    tokenFile = path.join(temp, 'oidc-token');
    writeFileSync(tokenFile, await oidcToken(env, fetchImpl), { mode: 0o600 });
  }
  need('GH_TOKEN');
  const options = queryOptions({
    cwd: root,
    advisor: env.ADVISOR || null,
    env: fixerEnv(env, { tokenFile, configDir }),
    // The web only: Read and the rest aren't limited for the fixer, as
    // they weren't under claude-code-action.
    guard: createGuard({ roots: [root], cwd: root }),
  });

  /** @type {unknown[]} */
  const messages = [];
  let failure = '';
  try {
    for await (const message of sdk.query({ prompt: need('PROMPT'), options }))
      messages.push(message);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const executionFile = env.OUT_FILE || path.join(temp, 'execution.json');
  mkdirSync(path.dirname(executionFile), { recursive: true });
  writeFileSync(executionFile, JSON.stringify(messages));
  const result = lastResult(messages);
  const text = report(result).replace('Claude Review (SDK)', 'Claude autofix (SDK)');
  return {
    executionFile,
    stopped: stoppedBy(messages, failure),
    finished: !failure && result?.subtype === 'success' && result.is_error !== true,
    report: failure ? `${text}\n\nThe pass failed: ${failure}` : text,
  };
}

/* c8 ignore start: the CLI's lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { executionFile, stopped, finished, report: text } = await main(process.env);
  setOutput('execution_file', executionFile);
  summary(text);
  console.log(text);
  if (stopped) {
    const why =
      stopped === 'credit' ? 'the API credit is spent' : 'a spend or usage limit was reached';
    console.log(`::warning title=Claude autofix stopped::Claude autofix didn't run: ${why}.`);
  } else if (!finished) {
    process.exit(1);
  }
}
/* c8 ignore stop */
