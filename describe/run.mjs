// describe.mjs against GitHub: the description and comments through the
// REST API with the Actions token (GH_TOKEN), and hiding a comment through
// GraphQL's minimizeComment. BOT_LOGIN is the account BOT_PR_TOKEN posts
// as, which the action reads with that token alone.
//
//   node run.mjs   (env: GH_TOKEN, GITHUB_REPOSITORY, NUMBER, BOT_LOGIN)

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ghApi } from '../lib/comment.mjs';
import { pages } from '../lib/github.mjs';
import { describe } from './describe.mjs';

/**
 * The io describe needs, for one PR or issue.
 *
 * @param {{ api: import('../lib/comment.mjs').Api, repo: string, number: number,
 *   hide: (nodeId: string) => void, log: (line: string) => void }} options
 * @returns {import('./describe.mjs').Io}
 */
export function gitHubIo({ api, repo, number, hide, log }) {
  const issue = `repos/${repo}/issues/${number}`;
  const read = () =>
    /** @type {import('./describe.mjs').Comment[]} */ (pages(api, `${issue}/comments`));
  return {
    body: () => String(/** @type {{ body?: string | null }} */ (api('GET', issue)).body ?? ''),
    write: (body) => {
      api('PATCH', issue, { body });
    },
    comments: read,
    hide,
    log,
  };
}

/** Hides a comment as outdated, through gh's GraphQL. */
function minimize(/** @type {string} */ nodeId) {
  execFileSync(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      'query=mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { clientMutationId } }',
      '-f',
      `id=${nodeId}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], timeout: 30_000 },
  );
}

/** @param {Record<string, string | undefined>} env */
export function main(env) {
  const repo = env.GITHUB_REPOSITORY ?? '';
  const number = Number(env.NUMBER);
  const login = env.BOT_LOGIN ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number) || number < 1 || !login) {
    throw new Error('describe needs GITHUB_REPOSITORY, NUMBER and BOT_LOGIN');
  }
  return describe(gitHubIo({ api: ghApi, repo, number, hide: minimize, log: console.log }), login);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env);
}
