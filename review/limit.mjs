// What "Check the review finished" and "Check the follow-up finished" in
// action.yml run when a pass failed: it judges the pass (result.mjs) and,
// when the pass stopped on the Claude account's usage limit, says so
// plainly, keeps one PR comment saying what wasn't reviewed, sets the step
// output `limited=true`, and decides the check.
//
// A usage limit says nothing about the PR, so on a person's PR the check
// passes with a warning. It still fails wherever a green check could merge
// the PR without a person looking at it (mustFail): a bot's PR, a
// `dependabot/` or `bot/` branch (the README screenshots bot opens its PR
// under the owner's account, from bot/readme-screenshots, and turns on
// auto-merge: BoardGames #320 was one), a PR with auto-merge on, read live
// since autofix or publish.mjs turn it on after the event, and a PR whose
// auto-merge can't be read. A person who turns auto-merge on after the
// warning passed isn't caught (nothing re-runs the check); the comment
// tells them not to.
//
// The comment is marked MARKER and kept by AUTHOR (lib/comment.mjs): a
// later limited run edits it in place, and `clear` (action.yml's "Clear the
// usage-limit note", once a review finishes) deletes it. Keeping it is
// best-effort: a token that can't comment (a fork's, Dependabot's) is a
// warning, never the check's result.
//
// The follow-up pass gets UNREAD, the files still unread across both
// passes: with none left, its limit is only noted, as nothing went
// unreviewed; with some, the comment lists them.
//
//   node limit.mjs review <execution file>
//   node limit.mjs followup <execution file>   (env UNREAD, one file a line)
//   node limit.mjs clear
//   env: REPO, PR, PR_AUTHOR, PR_AUTHOR_TYPE, HEAD_REF, GH_TOKEN for gh

import { pathToFileURL } from 'node:url';
import { setOutput, summary } from '../lib/actions.mjs';
import { findComment, ghApi } from '../lib/comment.mjs';
import { judgeFile, limitSentence, oneLine } from './result.mjs';

/** @typedef {import('../lib/comment.mjs').Api} Api */
/** @typedef {import('./result.mjs').Limit} Limit */

/** The hidden first line of the usage-limit comment. */
export const MARKER = '<!-- claude-review:usage-limit -->';
/** The branches whose PRs are a bot's, whoever opened them. */
export const BOT_BRANCHES = ['dependabot/', 'bot/'];
/** The most unread files the comment lists. */
const MAX_FILES = 50;
const TITLE = 'Claude Review stopped on a usage limit';

/**
 * @typedef {object} Pr
 * @property {string} author the PR's author's login
 * @property {string} authorType its account type ("User", "Bot")
 * @property {string} headRef the PR's head branch
 */

/**
 * @typedef {object} Io
 * @property {(line: string) => void} log
 * @property {(name: string, value: string) => void} output
 * @property {(markdown: string) => void} summary
 */

/**
 * Whether the check must fail on a usage limit: when a green check could
 * let the PR merge without a person looking at it. `autoMerge` is null when
 * it couldn't be read, which fails.
 *
 * @param {Pr} pr
 * @param {boolean | null} autoMerge
 * @returns {{ fail: boolean, why: string }}
 */
export function mustFail({ author, authorType, headRef }, autoMerge) {
  if (!author) return { fail: true, why: "the PR's author isn't known" };
  if (authorType === 'Bot' || author.endsWith('[bot]')) {
    return { fail: true, why: "it's a bot's PR, which can merge with no person looking" };
  }
  const branch = BOT_BRANCHES.find((prefix) => headRef.startsWith(prefix));
  if (branch) {
    return { fail: true, why: `its branch is a bot's (${branch}), which can merge unreviewed` };
  }
  if (autoMerge === null) {
    return { fail: true, why: "whether auto-merge is on couldn't be read" };
  }
  if (autoMerge) return { fail: true, why: 'auto-merge is on, so it would merge unreviewed' };
  return { fail: false, why: "a person's PR without auto-merge" };
}

/**
 * Whether the PR has auto-merge on, read live; null when it can't be told.
 *
 * @param {Api} api
 * @param {string} repo
 * @param {number} pr
 * @returns {boolean | null}
 */
export function autoMergeOn(api, repo, pr) {
  try {
    const pull = /** @type {{ auto_merge?: unknown } | null} */ (
      api('GET', `repos/${repo}/pulls/${pr}`)
    );
    if (!pull || typeof pull !== 'object' || !('auto_merge' in pull)) return null;
    return pull.auto_merge !== null;
  } catch {
    return null;
  }
}

/**
 * Untrusted text for the comment (a file name, the API's message): one
 * line, in a code span, so neither markup nor an `@name` in it acts.
 *
 * @param {string} text
 */
const code = (text) => `\`${oneLine(text, 200).replaceAll('`', "'")}\``;

/**
 * The usage-limit comment's body.
 *
 * @param {Limit} limit
 * @param {string[]} unread the files still unread, after a limited follow-up
 * @param {boolean} failed whether the check fails
 * @returns {string}
 */
export function commentBody(limit, unread, failed) {
  const why = limitSentence(limit, code).replace('re-run this job', 're-run the Claude Review job');
  const lines = [MARKER];
  if (unread.length > 0) {
    lines.push(
      `**Claude Review stopped before reading every file**: ${why}.`,
      '',
      'Still unread:',
      '',
      ...unread.slice(0, MAX_FILES).map((f) => `- ${code(f)}`),
    );
    if (unread.length > MAX_FILES) lines.push(`- and ${unread.length - MAX_FILES} more`);
  } else if (limit.turns !== null && limit.turns > 1) {
    lines.push(`**Claude Review stopped partway (${limit.turns} turns)**: ${why}.`);
  } else {
    lines.push(`**Claude Review didn't review this PR**: ${why}.`);
  }
  lines.push(
    '',
    failed
      ? 'The check fails until a review finishes, as this PR could otherwise merge without a person looking at it.'
      : "Until then nothing has reviewed this diff; don't merge it, or turn on auto-merge, on the strength of a green check.",
  );
  return lines.join('\n');
}

/**
 * Posts the comment, or edits the one there; a body already there is left.
 *
 * @param {Api} api
 * @param {string} repo
 * @param {number} pr
 * @param {string} body
 * @returns {string} what happened
 */
export function keepComment(api, repo, pr, body) {
  const existing = findComment(api, repo, pr, MARKER);
  if (existing?.body === body) return 'the usage-limit comment is already up to date';
  if (existing) {
    api('PATCH', `repos/${repo}/issues/comments/${existing.id}`, { body });
    return 'updated the usage-limit comment';
  }
  api('POST', `repos/${repo}/issues/${pr}/comments`, { body });
  return 'posted the usage-limit comment';
}

/**
 * Deletes the comment, once a review has finished.
 *
 * @param {Api} api
 * @param {string} repo
 * @param {number} pr
 * @returns {string} what happened
 */
export function clearComment(api, repo, pr) {
  const existing = findComment(api, repo, pr, MARKER);
  if (!existing) return 'no usage-limit comment to clear';
  api('DELETE', `repos/${repo}/issues/comments/${existing.id}`);
  return 'cleared the usage-limit comment';
}

/**
 * A workflow command's message, escaped as the runner expects.
 *
 * @param {string} text
 */
const escapeData = (text) =>
  text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

/**
 * The first line of a failure, for a warning.
 *
 * @param {unknown} error
 */
const failure = (error) =>
  oneLine((error instanceof Error ? error.message : String(error)).split('\n')[0]);

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ repo: string, pr: number } | null} null when REPO or PR isn't usable
 */
function target(env) {
  const repo = env.REPO ?? '';
  const pr = Number(env.PR);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(pr) || pr <= 0) return null;
  return { repo, pr };
}

/**
 * Runs one of the CLI's commands; returns the exit code.
 *
 * @param {string[]} args the command, then the execution file
 * @param {Record<string, string | undefined>} env
 * @param {Api} api
 * @param {Io} io
 * @param {number} [now]
 * @returns {number}
 */
export function main(args, env, api, io, now = Date.now()) {
  const [command, file] = args;
  const where = target(env);
  if (command === 'clear') {
    if (!where) {
      io.log('::warning::Claude Review: REPO and PR are needed to clear the usage-limit comment.');
      return 0;
    }
    try {
      io.log(`Claude Review: ${clearComment(api, where.repo, where.pr)}.`);
    } catch (error) {
      io.log(
        `::warning::Claude Review: couldn't clear the usage-limit comment: ${escapeData(failure(error))}`,
      );
    }
    return 0;
  }
  if (command !== 'review' && command !== 'followup') {
    io.log(
      `Claude Review: unknown command ${oneLine(command, 40)}; use review, followup or clear.`,
    );
    return 1;
  }
  const { finished, why, limit } = judgeFile(file, now);
  io.log(`Claude Review: ${why}.`);
  if (finished) return 0;
  if (!limit) return 1;

  const unread =
    command === 'followup' ? (env.UNREAD ?? '').split('\n').filter((f) => f.trim()) : [];
  if (command === 'followup' && unread.length === 0) {
    io.log(
      'Claude Review: the follow-up had read every file left before it stopped, so nothing went unreviewed.',
    );
    return 0;
  }
  io.output('limited', 'true');
  const pr = {
    author: env.PR_AUTHOR ?? '',
    authorType: env.PR_AUTHOR_TYPE ?? '',
    headRef: env.HEAD_REF ?? '',
  };
  const merge = where ? autoMergeOn(api, where.repo, where.pr) : null;
  const decision = mustFail(pr, merge);
  const left = unread.length > 0 ? ` ${unread.length} file(s) are still unread.` : '';
  const verdict = decision.fail
    ? `The check fails: ${decision.why}.`
    : `The check passes with this warning (${decision.why}); the PR is not reviewed.`;
  const message = `${why}.${left} ${verdict}`;
  io.log(`::${decision.fail ? 'error' : 'warning'} title=${TITLE}::${escapeData(message)}`);
  io.summary(`**${TITLE}.** ${message}`);
  if (where) {
    try {
      const body = commentBody(limit, unread, decision.fail);
      io.log(`Claude Review: ${keepComment(api, where.repo, where.pr, body)}.`);
    } catch (error) {
      io.log(
        `::warning::Claude Review: couldn't keep the usage-limit comment: ${escapeData(failure(error))}`,
      );
    }
  }
  return decision.fail ? 1 : 0;
}

/* c8 ignore start: the CLI's lines, run by action.yml */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const io = { log: console.log, output: setOutput, summary };
  process.exit(main(process.argv.slice(2), process.env, ghApi, io));
}
/* c8 ignore stop */
