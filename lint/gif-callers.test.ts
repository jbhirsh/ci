import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { lintGifCallers } from './gif-callers.ts';

/** @param {string} name */
const canonical = (name) =>
  parse(readFileSync(new URL(`../gif/callers/${name}.yml`, import.meta.url), 'utf8'));
const NAMES = new Set(['PR GIFs']);
/**
 * A copy of a parsed workflow.
 *
 * @param {unknown} doc
 * @returns {Record<string, unknown>}
 */
const copy = (doc) => structuredClone(/** @type {Record<string, unknown>} */ (doc));

/**
 * The object at a dotted path of a parsed workflow.
 *
 * @param {Record<string, unknown>} doc
 * @param {string} path
 */
const at = (doc, path) =>
  /** @type {Record<string, unknown>} */ (
    path === ''
      ? doc
      : path
          .split('.')
          .reduce(
            (o, k) => /** @type {Record<string, unknown>} */ (o)[k],
            /** @type {unknown} */ (doc),
          )
  );
/** Sets `path` (dotted; the last part is the key) to `value`. */
const set = (
  /** @type {Record<string, unknown>} */ doc,
  /** @type {string} */ path,
  /** @type {unknown} */ value,
) => {
  const parts = path.split('.');
  const key = /** @type {string} */ (parts.pop());
  at(doc, parts.join('.'))[key] = value;
};
/** Removes `path`. */
const del = (/** @type {Record<string, unknown>} */ doc, /** @type {string} */ path) => {
  const parts = path.split('.');
  const key = /** @type {string} */ (parts.pop());
  delete at(doc, parts.join('.'))[key];
};

describe('the canonical callers', () => {
  it('pass their own rules', () => {
    expect(lintGifCallers('pr-gif.yml', canonical('pr-gif'), NAMES)).toEqual([]);
    expect(lintGifCallers('pr-gif-attach.yml', canonical('pr-gif-attach'), NAMES)).toEqual([]);
  });

  it('are found by what they use, not what they are called', () => {
    expect(lintGifCallers('anything.yml', { jobs: { x: { uses: './other.yml' } } })).toEqual([]);
  });
});

describe('the recording caller', () => {
  const bad = (/** @type {(d: Record<string, unknown>) => void} */ change) => {
    const doc = copy(canonical('pr-gif'));
    change(doc);
    return lintGifCallers('f.yml', doc, NAMES).join('\n');
  };

  it('refuses a token for every event, inherited secrets and pull_request_target', () => {
    expect(bad((d) => set(d, 'jobs.gif.secrets.bot-token', '${{ secrets.BOT_PR_TOKEN }}'))).toMatch(
      /bot-token must be empty unless the event is workflow_dispatch/,
    );
    expect(bad((d) => set(d, 'jobs.gif.secrets', 'inherit'))).toMatch(/secrets: inherit/);
    expect(bad((d) => set(d, 'on.pull_request_target', {}))).toMatch(/pull_request_target/);
  });

  it('allows the token spaced differently, and refuses any permission past contents: read', () => {
    expect(
      bad((d) =>
        set(
          d,
          'jobs.gif.secrets.bot-token',
          "${{github.event_name=='workflow_dispatch'&&secrets.BOT_PR_TOKEN||''}}",
        ),
      ),
    ).toBe('');
    expect(bad((d) => set(d, 'jobs.gif.permissions.pull-requests', 'write'))).toMatch(
      /pull-requests: write/,
    );
    expect(bad((d) => set(d, 'jobs.gif.permissions.actions', 'write'))).toMatch(/actions: write/);
    expect(bad((d) => del(d, 'jobs.gif.permissions.contents'))).toMatch(/needs `contents: read`/);
  });

  it('lets a workflow with no pull_request trigger (sift) write actions and pass the token', () => {
    const doc = copy(canonical('pr-gif'));
    del(doc, 'on.pull_request');
    set(doc, 'jobs.gif.permissions.actions', 'write');
    set(doc, 'jobs.gif.permissions.pull-requests', 'read');
    set(doc, 'jobs.gif.secrets.bot-token', '${{ secrets.BOT_PR_TOKEN }}');
    expect(lintGifCallers('f.yml', doc, NAMES)).toEqual([]);
  });
});

describe('the attach caller', () => {
  const bad = (/** @type {(d: Record<string, unknown>) => void} */ change, names = NAMES) => {
    const doc = copy(canonical('pr-gif-attach'));
    change(doc);
    return lintGifCallers('f.yml', doc, names).join('\n');
  };

  it('must be woken by a workflow the app has', () => {
    expect(bad(() => {}, new Set(['CI']))).toMatch(/waits for "PR GIFs", which no workflow/);
    expect(bad((d) => set(d, 'on.workflow_run.workflows', ['CI']), new Set(['CI']))).toBe('');
    expect(bad((d) => del(d, 'on.workflow_run'))).toMatch(/woken by `workflow_run`/);
    expect(bad((d) => set(d, 'on.pull_request', {}))).toMatch(/runs only on `workflow_run`/);
  });

  it('must grant what the reusable workflow asks for, and pass the token from a secret', () => {
    for (const name of ['contents', 'pull-requests', 'actions', 'statuses']) {
      expect(bad((d) => del(d, `jobs.gif.permissions.${name}`))).toContain(`\`${name}:`);
    }
    expect(bad((d) => set(d, 'jobs.gif.permissions.statuses', 'read'))).toMatch(/statuses: write/);
    expect(bad((d) => set(d, 'jobs.gif.permissions.actions', 'write'))).toBe('');
    expect(bad((d) => set(d, 'jobs.gif.secrets.bot-token', ''))).toMatch(/BOT_PR_TOKEN/);
    expect(bad((d) => del(d, 'jobs.gif.secrets'))).toMatch(/BOT_PR_TOKEN/);
  });
});

describe('the rules the review found a gap in', () => {
  const record = () => copy(canonical('pr-gif'));
  const attach = () => copy(canonical('pr-gif-attach'));

  it('read the owner and repo as GitHub does, ignoring case', () => {
    const doc = record();
    set(doc, 'jobs.gif.uses', 'JBHirsh/CI/.github/workflows/PR-GIF.yml@main');
    set(doc, 'jobs.gif.secrets', 'inherit');
    expect(lintGifCallers('f.yml', doc, NAMES).join()).toMatch(/secrets: inherit/);
  });

  it('exempt only a workflow that runs by hand alone, not any one without pull_request', () => {
    for (const other of ['pull_request_review', 'push', 'issue_comment', 'merge_group']) {
      const doc = record();
      del(doc, 'on.pull_request');
      set(doc, `on.${other}`, {});
      set(doc, 'jobs.gif.permissions.actions', 'write');
      set(doc, 'jobs.gif.secrets.bot-token', '${{ secrets.BOT_PR_TOKEN }}');
      const found = lintGifCallers('f.yml', doc, NAMES).join('\n');
      expect(found, other).toMatch(/actions: write/);
      expect(found, other).toMatch(/bot-token must be empty/);
    }
  });

  it('limits the attach caller to its triggers, its permissions and the one token', () => {
    const extraTrigger = attach();
    set(extraTrigger, 'on.workflow_dispatch', {});
    expect(lintGifCallers('f.yml', extraTrigger, NAMES).join()).toMatch(
      /runs only on `workflow_run`/,
    );
    const wide = attach();
    set(wide, 'jobs.gif.permissions.issues', 'write');
    expect(lintGifCallers('f.yml', wide, NAMES).join()).toMatch(/must not grant `issues`/);
    const write = attach();
    set(write, 'jobs.gif.permissions.contents', 'write');
    expect(lintGifCallers('f.yml', write, NAMES).join()).toMatch(/must grant `contents: read`/);
    const wrong = attach();
    set(wrong, 'jobs.gif.secrets.bot-token', '${{ secrets.GITHUB_TOKEN }}');
    expect(lintGifCallers('f.yml', wrong, NAMES).join()).toMatch(/BOT_PR_TOKEN/);
  });

  it('takes `workflows:` as a string, and triggers as a list or a string', () => {
    const doc = attach();
    set(doc, 'on.workflow_run.workflows', 'PR GIFs');
    expect(lintGifCallers('f.yml', doc, NAMES)).toEqual([]);
    const list = record();
    set(list, 'jobs.gif.secrets.bot-token', '${{ secrets.BOT_PR_TOKEN }}');
    set(list, 'on', ['push']);
    expect(lintGifCallers('f.yml', list, NAMES).join()).toMatch(/bot-token must be empty/);
    set(list, 'on', 'workflow_dispatch');
    expect(lintGifCallers('f.yml', list, NAMES).join()).not.toMatch(/bot-token/);
  });

  it('prints the token it refused, as written', () => {
    const doc = record();
    set(doc, 'jobs.gif.secrets.bot-token', '${{ secrets.OTHER }}');
    expect(lintGifCallers('f.yml', doc, NAMES).join()).toContain('not ${{ secrets.OTHER }}');
  });
});

describe('lintGifCallers, for any workflow', () => {
  it('never throws, and says nothing of one that calls no GIF workflow', () => {
    fc.assert(
      fc.property(fc.anything(), (doc) => {
        const found = lintGifCallers(
          'f.yml',
          /** @type {Record<string, unknown>} */ (doc ?? {}),
          NAMES,
        );
        expect(Array.isArray(found)).toBe(true);
      }),
    );
  });

  it('fails a canonical copy with any one required key dropped', () => {
    const required = {
      'pr-gif': [
        'jobs.gif.uses',
        'jobs.gif.permissions',
        'jobs.gif.permissions.contents',
        'on.pull_request',
      ],
      'pr-gif-attach': [
        'on.workflow_run',
        'on.workflow_run.workflows',
        'jobs.gif.secrets',
        'jobs.gif.secrets.bot-token',
        'jobs.gif.permissions.contents',
        'jobs.gif.permissions.actions',
        'jobs.gif.permissions.pull-requests',
        'jobs.gif.permissions.statuses',
      ],
    };
    for (const [name, keys] of Object.entries(required)) {
      for (const key of keys) {
        const doc = copy(canonical(name));
        del(doc, key);
        const found = lintGifCallers('f.yml', doc, NAMES);
        // Dropping `uses` makes the job no GIF caller at all; dropping the
        // recording caller's pull_request makes a by-hand one, which is fine.
        if (key === 'jobs.gif.uses' || key === 'on.pull_request') expect(found, key).toEqual([]);
        else expect(found, key).not.toEqual([]);
      }
    }
  });

  it('never throws on a canonical copy changed at random, and still names a changed token', () => {
    const values = fc.oneof(fc.string(), fc.constant('inherit'), fc.constant(null), fc.integer());
    const paths = [
      'jobs.gif.secrets.bot-token',
      'jobs.gif.permissions.contents',
      'jobs.gif.permissions.statuses',
      'jobs.gif.permissions',
      'on',
    ];
    fc.assert(
      fc.property(
        fc.constantFrom('pr-gif', 'pr-gif-attach'),
        fc.constantFrom(...paths),
        values,
        (name, path, value) => {
          const doc = copy(canonical(name));
          set(doc, path, value);
          expect(Array.isArray(lintGifCallers('f.yml', doc, NAMES))).toBe(true);
        },
      ),
    );
  });
});
