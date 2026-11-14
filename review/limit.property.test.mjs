import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BOT_BRANCHES, commentBody, main, MARKER, mustFail } from './limit.mjs';

// The author, its type and the branch come from the event's payload, and
// auto-merge from the API (null when it couldn't be read): anything at all,
// with the bots' shapes mixed in.
const author = fc.oneof(
  fc.string(),
  fc.constantFrom('dependabot[bot]', 'github-actions[bot]', 'claude[bot]', 'jbhirsh', ''),
);
const authorType = fc.oneof(fc.string(), fc.constantFrom('Bot', 'User', 'Organization'));
const headRef = fc.oneof(
  fc.string(),
  fc.constantFrom(...BOT_BRANCHES).chain((prefix) => fc.string().map((rest) => prefix + rest)),
);
const autoMerge = fc.constantFrom(true, false, null);

describe('mustFail', () => {
  it('fails whenever the PR could merge unreviewed or that cannot be told, and passes otherwise', () => {
    fc.assert(
      fc.property(author, authorType, headRef, autoMerge, (a, type, ref, merge) => {
        const bot =
          a === '' ||
          a.endsWith('[bot]') ||
          type === 'Bot' ||
          BOT_BRANCHES.some((prefix) => ref.startsWith(prefix));
        const decision = mustFail({ author: a, authorType: type, headRef: ref }, merge);
        expect(decision.fail).toBe(bot || merge !== false);
      }),
    );
  });
});

describe('commentBody', () => {
  it('starts with its marker and keeps any unread file on one line, as code', () => {
    const limit = fc.record({
      name: fc.constantFrom('5-hour limit', 'usage limit'),
      resets: fc.option(fc.constant('2026-11-14 00:40 UTC')),
      turns: fc.option(fc.nat()),
      text: fc.string({ unit: 'binary' }),
    });
    fc.assert(
      fc.property(
        limit,
        fc.array(fc.string({ unit: 'binary' }), { maxLength: 60 }),
        fc.boolean(),
        (l, files, failed) => {
          const body = commentBody(l, files, failed);
          expect(body.startsWith(`${MARKER}\n`)).toBe(true);
          const items = body.split('\n').filter((line) => line.startsWith('- `'));
          expect(items).toHaveLength(Math.min(files.length, 50));
          for (const item of items) expect(item).toMatch(/^- `[^`\n]*`$/);
        },
      ),
    );
  });
});

describe('main', () => {
  // #320's limited pass, with its reset; the env, UNREAD and the API's
  // answers are anything at all.
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'limit-')), 'execution.json');
  writeFileSync(
    file,
    JSON.stringify([
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        num_turns: 1,
        api_error: 'usage_limit_reached',
        result: 'limit',
      },
    ]),
  );
  const env = fc.record(
    {
      REPO: fc.oneof(fc.constant('jbhirsh/app'), fc.string()),
      PR: fc.oneof(fc.constant('1'), fc.string()),
      PR_AUTHOR: author,
      PR_AUTHOR_TYPE: authorType,
      HEAD_REF: headRef,
      UNREAD: fc.string({ unit: 'binary' }),
    },
    { requiredKeys: [] },
  );
  const pull = fc.oneof(
    fc.jsonValue(),
    fc.record({ auto_merge: fc.oneof(fc.constant(null), fc.jsonValue()) }),
  );

  it('never passes a limited pass when a bot condition holds or the lookup fails', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('review', 'followup'),
        env,
        pull,
        fc.boolean(),
        fc.boolean(),
        (command, e, answer, lookupThrows, commentThrows) => {
          /** @type {import('../lib/comment.mjs').Api} */
          const api = (method, route) => {
            if (route.includes('/pulls/')) {
              if (lookupThrows) throw new Error('HTTP 502');
              return answer;
            }
            if (commentThrows) throw new Error('HTTP 403');
            return method === 'GET' ? [] : {};
          };
          const io = { log: () => {}, output: () => {}, summary: () => {} };
          const code = main([command, file], e, api, io);
          const a = e.PR_AUTHOR ?? '';
          const ref = e.HEAD_REF ?? '';
          const bot =
            a === '' ||
            a.endsWith('[bot]') ||
            e.PR_AUTHOR_TYPE === 'Bot' ||
            BOT_BRANCHES.some((prefix) => ref.startsWith(prefix));
          const off =
            !lookupThrows &&
            e.REPO === 'jbhirsh/app' &&
            e.PR === '1' &&
            typeof answer === 'object' &&
            answer !== null &&
            !Array.isArray(answer) &&
            'auto_merge' in answer &&
            answer.auto_merge === null;
          if (bot || !off) expect(code).toBe(1);
          else expect(code).toBe(0);
        },
      ),
    );
  });
});
