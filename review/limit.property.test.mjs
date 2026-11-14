import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BOT_BRANCHES, commentBody, MARKER, mustFail } from './limit.mjs';

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
      text: fc.string(),
    });
    fc.assert(
      fc.property(
        limit,
        fc.array(fc.string(), { maxLength: 60 }),
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
