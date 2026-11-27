// review.ts against GitHub, for the review job: the Actions token (GH_TOKEN)
// for the API, GraphQL and artifact downloads. BOT_PR_TOKEN (UPLOAD_TOKEN)
// only reads which account it is, whose upload comments from before ci#144
// count: this job writes nothing with it. The hand-off for the attach job
// (attach.ts) goes into HANDOFF_DIR, which action.yml uploads.
//
//   node run.ts   (env: GH_TOKEN, UPLOAD_TOKEN, TARGET (one
//                   matrix entry, JSON), GITHUB_REPOSITORY, DEFAULT_BRANCH,
//                   OWNER, HANDOFF_DIR; from the app's checkout of main, for
//                   its settings)

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutput } from '../lib/actions.mjs';
import { appConfig, appRoot } from '../lib/app.mjs';
import { ghApi } from '../lib/comment.mjs';
import { PIXELS } from '../lib/pixels.mjs';
import { enable } from '../dependabot-merge/enable.mjs';
import { downloadShots } from './find.ts';
import { review } from './review.ts';
import { settings } from './settings.ts';
import { CONTEXT, MAX_DESCRIPTION } from './status.ts';
import type { Io, Target } from './review.ts';
import type { Api } from '../lib/comment.mjs';

/**
 * A matrix entry, checked: it comes from find.ts, but through the
 * workflow's text.
 */
export function parseTarget(text: string): Target {
  const t = JSON.parse(text) as Record<string, unknown>;
  const whole = (n: unknown) => Number.isInteger(n) && Number(n) > 0;
  if ((t.kind === 'pr' || t.kind === 'issue') && whole(t.number) && whole(t.run)) {
    return { kind: t.kind, number: Number(t.number), run: Number(t.run) };
  }
  throw new Error(`not a review target: ${text}`);
}

/** gh with a token. */
export type Gh = (token: string, args: string[]) => string;

function realGh(token: string, args: string[]): string {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: token },
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 300_000,
  });
}

/**
 * The review's io against GitHub: the Actions token for all of it.
 *
 * @param options handedOff: told when a hand-off is written
 */
export function gitHubIo({
  env,
  repo,
  token,
  gh,
  api,
  handoffDir,
  handedOff,
}: {
  env: Record<string, string | undefined>;
  repo: string;
  token: string;
  gh: Gh;
  api: Api;
  handoffDir: string;
  handedOff: () => void;
}): Io {
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
    artifact: (runId, dir) =>
      downloadShots({ api, gh: (args) => gh(token, args), repo, runId, dir }),
    handoff: (handoff, files) => {
      mkdirSync(handoffDir, { recursive: true });
      for (const { name, bytes } of files) writeFileSync(path.join(handoffDir, name), bytes);
      writeFileSync(path.join(handoffDir, 'attach.json'), JSON.stringify(handoff));
      handedOff();
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
 * @param env
 * @param seams for the tests
 */
export function main(
  env: Record<string, string | undefined>,
  { gh = realGh, api = ghApi }: { gh?: Gh; api?: Api } = {},
) {
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
    if (!env.HANDOFF_DIR) {
      throw new Error('HANDOFF_DIR is missing: where the hand-off for the attach job goes');
    }
    // Which account it is: an upload counts only from it (describe.ts).
    const login = gh(upload, ['api', 'user', '--jq', '.login']).trim();
    if (!login) throw new Error("BOT_PR_TOKEN's account couldn't be read");
    let handoff = false;
    const io = gitHubIo({
      env: { ...env, UPLOAD_LOGIN: login },
      repo,
      token,
      gh,
      api,
      handoffDir: env.HANDOFF_DIR ?? '',
      handedOff: () => {
        handoff = true;
      },
    });
    const number = review(target, { s, io });
    setOutput('handoff', String(handoff));
    return number;
  } catch (error) {
    // A required check must never go unreported: a review that can't
    // finish says why on the PR, then fails the job. If saying so fails
    // too, that's logged, and the job still fails with the first error.
    if (target.kind === 'pr') {
      try {
        const run = api('GET', `repos/${repo}/actions/runs/${target.run}`) as { head_sha: string };
        const why = (error as Error).message.replace(/\s+/g, ' ');
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
