// Rules for an app's callers of jbhirsh/ci's PR GIF workflows (ci#92), run by
// lint/actions.mjs on every workflow of an app ("Against <app>") whose job
// uses `pr-gif.yml` or `pr-gif-attach.yml`, found by what it `uses`, never by
// its file name. gif/callers/ holds the shape every app's copy takes (the
// sync keeps the copies in step, sync/manifest.json, with sift's and fog's
// differences as variants); these are the lines in it that matter, checked
// here as defence in depth, because a wrong copy puts BOT_PR_TOKEN, the one
// token that may attach files, in a run that holds a PR's code, or wakes
// nothing:
//
//   any caller   no `secrets: inherit`; no `pull_request_target` trigger
//   pr-gif.yml   its job asks for nothing past `contents: read`, but
//                `actions: write` and `pull-requests: read` where the workflow
//                runs only by hand
//                (`workflow_dispatch` and nothing else: sift, whose CI is the
//                recording); its `bot-token` is empty on every event but
//                workflow_dispatch, that is `github.event_name ==
//                'workflow_dispatch' && secrets.BOT_PR_TOKEN || ''`, unless
//                the workflow runs only by hand
//   attach       woken by `workflow_run` and nothing else (a branch's copy
//                of the file would run with the token) of a workflow of the
//                app (every name in `workflows:` is one: a workflow with no
//                `name:` is named by its path); its job grants `contents`
//                and `pull-requests` read, `actions` read or write and
//                `statuses: write`, and nothing more, else every run fails at
//                startup or holds more than it uses; `bot-token` is
//                `${{ secrets.BOT_PR_TOKEN }}`, the only token that may attach
//
// Pure functions over the parsed workflow, so a test can mutate the canonical
// copies and see each rule fail.

/** @typedef {Record<string, unknown>} Doc */

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The workflow's trigger names (`on:`; the yaml package reads YAML 1.2, where
 * `on` is a plain key).
 *
 * @param {Doc} doc
 * @returns {Set<string>}
 */
function triggers(doc) {
  const on = doc.on;
  if (typeof on === 'string') return new Set([on]);
  if (Array.isArray(on)) return new Set(on.map(String));
  return new Set(isObject(on) ? Object.keys(/** @type {Doc} */ (on)) : []);
}

/** @param {unknown} expression */
const squash = (expression) => String(expression ?? '').replace(/\s+/g, '');

/** The token expression a recording caller may pass. */
const EVENT = "${{ github.event_name == 'workflow_dispatch' && secrets.BOT_PR_TOKEN || '' }}";
const EVENT_ONLY = squash(EVENT);

/**
 * Problems in one job that calls a PR GIF workflow.
 *
 * @param {string} where
 * @param {'record' | 'attach'} kind
 * @param {Doc} job
 * @param {Doc} doc the whole workflow
 * @param {Set<string> | null} appNames the names of the app's workflows, when known
 * @returns {string[]}
 */
function lintJob(where, kind, job, doc, appNames) {
  /** @type {string[]} */
  const errors = [];
  const on = triggers(doc);
  const secrets = job.secrets;
  if (secrets === 'inherit') errors.push(`${where}: \`secrets: inherit\` hands every secret to it`);
  if (on.has('pull_request_target')) {
    errors.push(`${where}: pull_request_target runs with secrets in the PR's reach: never`);
  }
  const permissions = isObject(job.permissions) ? /** @type {Doc} */ (job.permissions) : {};
  const token = isObject(secrets) ? /** @type {Doc} */ (secrets)['bot-token'] : undefined;
  /** The workflow runs only when started by hand (sift: its CI is the recording). */
  const manual = on.size === 1 && on.has('workflow_dispatch');
  if (kind === 'record') {
    const allowed = manual ? ['contents', 'actions', 'pull-requests'] : ['contents'];
    for (const [name, level] of Object.entries(permissions)) {
      const ok = allowed.includes(name) && (name === 'actions' || level === 'read');
      if (!ok)
        errors.push(
          `${where}: permission \`${name}: ${String(level)}\` isn't allowed on the recording caller`,
        );
    }
    if (permissions.contents !== 'read') {
      errors.push(`${where}: the recording caller needs \`contents: read\``);
    }
    if (!manual && token !== undefined && squash(token) !== EVENT_ONLY) {
      errors.push(
        `${where}: bot-token must be empty unless the event is workflow_dispatch: ${EVENT}, not ${String(token)}`,
      );
    }
    return errors;
  }
  if (!(on.size === 1 && on.has('workflow_run'))) {
    errors.push(
      `${where}: the attach caller runs only on \`workflow_run\` (this copy has ${[...on].join(', ') || 'no trigger'}): any other trigger runs a branch's copy with the token`,
    );
  }
  const run = isObject(doc.on) ? /** @type {Doc} */ (doc.on).workflow_run : undefined;
  const wanted = isObject(run) ? /** @type {Doc} */ (run).workflows : undefined;
  const listed = (Array.isArray(wanted) ? wanted : typeof wanted === 'string' ? [wanted] : []).map(
    String,
  );
  if (!on.has('workflow_run') || listed.length === 0) {
    errors.push(
      `${where}: the attach caller is woken by \`workflow_run\` with \`workflows:\` naming the recording workflow`,
    );
  } else if (appNames) {
    for (const name of listed) {
      if (!appNames.has(name))
        errors.push(
          `${where}: workflow_run waits for "${name}", which no workflow of the app is named`,
        );
    }
  }
  /** What the reusable workflow's jobs ask for, and no more. */
  /** @type {[string, string[]][]} */
  const grants = [
    ['contents', ['read']],
    ['pull-requests', ['read']],
    ['actions', ['read', 'write']],
    ['statuses', ['write']],
  ];
  for (const [name, wants] of grants) {
    if (!wants.includes(String(permissions[name]))) {
      errors.push(
        `${where}: the attach caller must grant \`${name}: ${wants[0]}\`, or its run fails at startup`,
      );
    }
  }
  for (const name of Object.keys(permissions)) {
    if (!grants.some(([granted]) => granted === name)) {
      errors.push(`${where}: the attach caller must not grant \`${name}\`: it asks for none`);
    }
  }
  if (squash(token) !== squash('${{ secrets.BOT_PR_TOKEN }}')) {
    errors.push(
      `${where}: the attach caller must pass \`bot-token: \${{ secrets.BOT_PR_TOKEN }}\`, the only token that may attach files`,
    );
  }
  return errors;
}

/**
 * Problems in an app workflow's calls of the PR GIF workflows.
 *
 * @param {string} file
 * @param {Doc} doc the parsed workflow
 * @param {Set<string> | null} [appNames] the names of the app's workflows
 * @returns {string[]}
 */
export function lintGifCallers(file, doc, appNames = null) {
  const jobs = isObject(doc.jobs) ? /** @type {Doc} */ (doc.jobs) : {};
  /** @type {string[]} */
  const errors = [];
  for (const [id, raw] of Object.entries(jobs)) {
    const job = isObject(raw) ? /** @type {Doc} */ (raw) : {};
    const m = /^jbhirsh\/ci\/\.github\/workflows\/(pr-gif|pr-gif-attach)\.yml@/i.exec(
      String(job.uses),
    );
    if (!m) continue;
    errors.push(
      ...lintJob(`${file}: job ${id}`, m[1] === 'pr-gif' ? 'record' : 'attach', job, doc, appNames),
    );
  }
  return errors;
}
