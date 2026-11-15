// review.mjs against GitHub, for the review job: the Actions token (GH_TOKEN)
// for the API, GraphQL and artifact downloads, BOT_PR_TOKEN (UPLOAD_TOKEN)
// only for the upload comment, which gh posts with --attach (gh 2.99 or
// later, which lib/gh.mjs checks first in action.yml).
//
//   node run.mjs   (env: GH_TOKEN, UPLOAD_TOKEN, TARGET (one
//                   matrix entry, JSON), GITHUB_REPOSITORY, DEFAULT_BRANCH,
//                   OWNER; from the app's checkout of main, for its settings)

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { appConfig, appRoot } from '../lib/app.mjs';
import { ghApi } from '../lib/comment.mjs';
import { pages } from '../lib/github.mjs';
import { PIXELS } from '../lib/pixels.mjs';
import { enable } from '../dependabot-merge/enable.mjs';
import { settings as visualsSettings } from '../visuals/check.mjs';
import { review } from './review.mjs';
import { settings } from './settings.mjs';
import { CONTEXT, MAX_DESCRIPTION } from './status.mjs';

/**
 * A matrix entry, checked: it comes from find.mjs, but through the
 * workflow's text.
 *
 * @param {string} text
 * @returns {import('./review.mjs').Target}
 */
export function parseTarget(text) {
  const t = /** @type {Record<string, unknown>} */ (JSON.parse(text));
  const whole = (/** @type {unknown} */ n) => Number.isInteger(n) && Number(n) > 0;
  if (t.kind === 'pr' && whole(t.number) && whole(t.run)) {
    return { kind: 'pr', number: Number(t.number), run: Number(t.run) };
  }
  if (t.kind === 'issue' && whole(t.run)) return { kind: 'issue', run: Number(t.run) };
  throw new Error(`not a review target: ${text}`);
}

/**
 * gh with a token.
 *
 * @typedef {(token: string, args: string[]) => string} Gh
 */

/** @type {Gh} */
function realGh(token, args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: token },
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 300_000,
  });
}

/**
 * The review's io against GitHub: the Actions token for everything but the
 * upload comment, which only BOT_PR_TOKEN may post.
 *
 * @param {{ env: Record<string, string | undefined>, repo: string, token: string,
 *   upload: string, gh: Gh, api: import('../lib/comment.mjs').Api }} options
 * @returns {import('./review.mjs').Io}
 */
export function gitHubIo({ env, repo, token, upload, gh, api }) {
  return {
    repo,
    owner: env.OWNER ?? repo.split('/')[0],
    main: env.DEFAULT_BRANCH || 'main',
    api,
    graphql: (query, variables) => {
      const args = ['api', 'graphql', '-f', `query=${query}`];
      for (const [k, v] of Object.entries(variables)) {
        args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
      }
      return JSON.parse(gh(token, args)).data;
    },
    artifact: (runId, dir) => {
      const found = /** @type {{ expired: boolean }[]} */ (
        pages(api, `repos/${repo}/actions/runs/${runId}/artifacts?name=visual-shots`, 'artifacts')
      );
      if (found.length === 0) return 'none';
      if (found.every((a) => a.expired)) return 'expired';
      // Any failure here throws: a download that failed must never read as
      // "no shots", which passes.
      gh(token, [
        'run',
        'download',
        String(runId),
        '--repo',
        repo,
        '--name',
        'visual-shots',
        '--dir',
        dir,
      ]);
      return 'ok';
    },
    upload: (kind, number, body, files) => {
      const url = gh(upload, [
        kind === 'pr' ? 'pr' : 'issue',
        'comment',
        String(number),
        '--repo',
        repo,
        '--body',
        body,
        ...files.flatMap((f) => ['--attach', f]),
      ]).trim();
      const id = /#issuecomment-(\d+)$/.exec(url)?.[1];
      if (!id) throw new Error(`gh didn't say which comment it posted: ${url}`);
      return Number(id);
    },
    editComment: (id, body) => {
      gh(upload, [
        'api',
        '-X',
        'PATCH',
        `repos/${repo}/issues/comments/${id}`,
        '-f',
        `body=${body}`,
      ]);
    },
    uploader: env.UPLOAD_LOGIN ?? '',
    enable: (number) =>
      enable({ GITHUB_REPOSITORY: repo, PR_NUMBER: String(number) }, (args) => gh(token, args)),
    pixels: PIXELS,
    now: () => Math.floor(Date.now() / 1000),
    log: console.log,
  };
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ gh?: Gh, api?: import('../lib/comment.mjs').Api }} [seams] for the tests
 */
export function main(env, { gh = realGh, api = ghApi } = {}) {
  const root = appRoot();
  const s = settings(appConfig('visual-review', root));
  if (!s) throw new Error('.github/ci.json has no visual-review key');
  const repo = env.GITHUB_REPOSITORY ?? '';
  const token = env.GH_TOKEN ?? '';
  const target = parseTarget(env.TARGET ?? '');
  try {
    const upload = env.UPLOAD_TOKEN ?? '';
    if (!upload) {
      throw new Error('BOT_PR_TOKEN is missing: visual review uploads its pictures with it');
    }
    // Which account it is: an upload counts only from it (describe.mjs).
    const login = gh(upload, ['api', 'user', '--jq', '.login']).trim();
    if (!login) throw new Error("BOT_PR_TOKEN's account couldn't be read");
    const io = gitHubIo({ env: { ...env, UPLOAD_LOGIN: login }, repo, token, upload, gh, api });
    const number = review(target, { s, visuals: visualsSettings(appConfig('visuals', root)), io });
    setOutput('number', number === null ? '' : String(number));
    setOutput('login', login);
    return number;
  } catch (error) {
    // A required check must never go unreported: a review that can't
    // finish says why on the PR, then fails the job. If saying so fails
    // too, that's logged, and the job still fails with the first error.
    if (target.kind === 'pr') {
      try {
        const run = /** @type {{ head_sha: string }} */ (
          api('GET', `repos/${repo}/actions/runs/${target.run}`)
        );
        const why = /** @type {Error} */ (error).message.replace(/\s+/g, ' ');
        const description = `Visual review failed: ${why}`;
        api('POST', `repos/${repo}/statuses/${run.head_sha}`, {
          state: 'failure',
          context: CONTEXT,
          description:
            description.length <= MAX_DESCRIPTION
              ? description
              : `${description.slice(0, MAX_DESCRIPTION - 1)}…`,
        });
      } catch (reporting) {
        console.error(`::warning::Couldn't post the failure status: ${String(reporting)}`);
      }
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env);
}
