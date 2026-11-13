// A fake GitHub for carry.mjs's tests and the rewrites' that use it: the
// API's answers for a commit's checks, the branch rule and the held runs,
// recording every call. Not part of the tool.

import { ACTIONS_APP } from './carry.mjs';

export const RUN_ID = '900';
export const VERIFY = { check: 'E2E', command: 'npm run test:e2e' };

/**
 * A check run as the API returns it.
 *
 * @param {number} id
 * @param {string} name
 * @param {string | null} conclusion null: still running
 * @param {{ app?: number, run?: string }} [options] `run`: its workflow run's id
 */
export function apiRun(id, name, conclusion, { app = ACTIONS_APP, run = String(id) } = {}) {
  const url = `https://github.com/o/r/actions/runs/${run}/job/${id}`;
  return {
    id,
    name,
    status: conclusion ? 'completed' : 'in_progress',
    conclusion,
    html_url: url,
    details_url: url,
    app: { id: app },
  };
}

/** @param {...string} contexts */
export function rule(...contexts) {
  return {
    type: 'required_status_checks',
    parameters: {
      required_status_checks: contexts.map((context) => ({ context, integration_id: ACTIONS_APP })),
    },
  };
}

/** @param {...[string, string]} pairs [context, state] */
export function statusPage(...pairs) {
  return {
    statuses: pairs.map(([context, state]) => ({
      context,
      state,
      target_url: `https://vercel.example/${context}`,
    })),
  };
}

/**
 * A fake GitHub: `rules` the branch rule's pages, `results(sha, read)` A's
 * check runs (the nth read of them) and statuses, `held` the runs awaiting
 * approval on each look.
 *
 * @param {{ rules?: unknown[], results?: (sha: string, read: number) => { runs?: unknown[], statuses?: unknown[] },
 *   held?: number[][], failCancel?: number[], files?: string[], failPost?: boolean }} options
 *   `files`: what A changes (none by default); `failPost`: posting a check fails
 */
export function fake({
  rules = [[rule('Unit', 'Lint', 'E2E')]],
  results,
  held = [[]],
  failCancel = [],
  files = [],
  failPost = false,
}) {
  /** @type {{ method: string, route: string, body?: Record<string, unknown> }[]} */
  const calls = [];
  /** @type {string[]} */
  const logs = [];
  let clock = 0;
  let reads = 0;
  let looks = 0;
  /** @type {import('../lib/comment.mjs').Api} */
  const api = (method, route, body) => {
    calls.push({ method, route, ...(body ? { body } : {}) });
    const page = Number(/[?&]page=(\d+)/.exec(route)?.[1] ?? 1);
    if (route.startsWith('repos/o/r/rules/branches/main?')) return rules[page - 1] ?? [];
    const runs = /^repos\/o\/r\/commits\/(\w+)\/check-runs\?/.exec(route);
    if (runs) {
      if (page === 1) reads++;
      const all = results?.(runs[1], reads).runs ?? [];
      return { total_count: all.length, check_runs: all.slice((page - 1) * 100, page * 100) };
    }
    const status = /^repos\/o\/r\/commits\/(\w+)\/status\?/.exec(route);
    if (status) return { statuses: results?.(status[1], reads).statuses ?? [] };
    if (route.startsWith('repos/o/r/actions/runs?')) {
      const ids = held[Math.min(looks++, held.length - 1)];
      return { workflow_runs: ids.map((id) => ({ id })) };
    }
    if (/^repos\/o\/r\/commits\/\w+\?/.test(route)) {
      return { files: files.slice((page - 1) * 100, page * 100).map((filename) => ({ filename })) };
    }
    if (failPost && route === 'repos/o/r/check-runs') throw new Error('HTTP 502');
    const cancel = /^repos\/o\/r\/actions\/runs\/(\d+)\/cancel$/.exec(route);
    if (cancel && failCancel.includes(Number(cancel[1]))) throw new Error('HTTP 409');
    return null;
  };
  /** @type {import('./carry.mjs').GitHub} */
  const github = {
    api,
    repo: 'o/r',
    runId: RUN_ID,
    runUrl: `https://github.com/o/r/actions/runs/${RUN_ID}`,
    workflow: 'Update visual baselines',
    sleep: (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: (line) => logs.push(line),
  };
  return {
    github,
    calls,
    logs,
    posted: () => calls.filter((c) => c.route === 'repos/o/r/check-runs'),
  };
}
