import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blocks, parseUpload, SECTION, uploadMarker, withSections } from './describe.mjs';

const BOT = 'jbhirsh';
const A = 'a'.repeat(40);

describe('parseUpload, for any comment', () => {
  it('never throws, and takes only links to attachments', () => {
    fc.assert(
      fc.property(fc.string(), fc.option(fc.string(), { nil: null }), (section, login) => {
        const comment = {
          id: 1,
          node_id: 'N',
          user: { login: login ?? undefined },
          body: `${uploadMarker('visual-review', A)}\n${SECTION}\n${section}`,
        };
        const upload = parseUpload(comment, BOT);
        if (upload) {
          expect(login).toBe(BOT);
          for (const m of upload.section.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
            expect(m[0]).toMatch(/^https:\/\/github\.com\/user-attachments\/assets\//);
          }
        }
      }),
    );
  });
});

describe('withSections, for any description', () => {
  it('keeps everything outside its own blocks, and writing twice changes nothing', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (body, section) => {
        const marked = /<!-- \/?describe:/.test(body);
        fc.pre(!marked);
        const sections = new Map([
          ['visual-review', { id: 1, nodeId: 'N', bot: 'visual-review', sha: A, section }],
        ]);
        const out = withSections(body, sections);
        expect(out.startsWith(body.trimEnd())).toBe(true);
        expect(withSections(out, sections)).toBe(out);
        expect(blocks.find(out, 'visual-review')).not.toBeNull();
      }),
    );
  });
});
