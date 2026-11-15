import { describe as group, expect, it } from 'vitest';
import {
  blocks,
  describe,
  latest,
  parseUpload,
  SECTION,
  uploadMarker,
  withSections,
} from './describe.mjs';

const BOT = 'jbhirsh';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const IMG = 'https://github.com/user-attachments/assets/0123abcd-0000-1111-2222-333344445555';

/**
 * An upload comment.
 *
 * @param {number} id
 * @param {string} bot
 * @param {string} sha
 * @param {string} section
 * @param {string} [login]
 */
const upload = (id, bot, sha, section, login = BOT) => ({
  id,
  node_id: `N${id}`,
  user: { login },
  body: `${uploadMarker(bot, sha)}\nPictures.\n\n${SECTION}\n${section}`,
});

group('parseUpload', () => {
  it('reads a genuine upload', () => {
    expect(parseUpload(upload(1, 'visual-review', A, `<img src="${IMG}">`), BOT)).toEqual({
      id: 1,
      nodeId: 'N1',
      bot: 'visual-review',
      sha: A,
      section: `<img src="${IMG}">`,
    });
  });

  it("refuses another author's, an unmarked one, one without a section, and outside links", () => {
    expect(parseUpload(upload(1, 'visual-review', A, 'x', 'someone'), BOT)).toBeNull();
    expect(parseUpload({ id: 1, node_id: 'N', user: { login: BOT }, body: 'hi' }, BOT)).toBeNull();
    expect(
      parseUpload({ id: 1, node_id: 'N', user: { login: BOT }, body: uploadMarker('x', A) }, BOT),
    ).toBeNull();
    for (const bad of [
      '<img src="https://evil.example/x.png">',
      '![x](https://raw.githubusercontent.com/a/b/c.png)',
      'see https://example.com',
      '<a href="javascript:alert(1)">x</a>',
    ]) {
      expect(parseUpload(upload(1, 'visual-review', A, bad), BOT)).toBeNull();
    }
  });
});

group('latest', () => {
  it("takes each bot's newest upload, whatever order they're listed in", () => {
    const comments = [
      upload(5, 'visual-review', B, 'new'),
      upload(3, 'visual-review', A, 'old'),
      upload(4, 'pr-gif', A, 'gif'),
      // A commit a force-push dropped still counts: it's the newest.
      upload(6, 'pr-gif', 'c'.repeat(40), 'gif after a force-push'),
    ];
    const { sections, outdated } = latest(comments, BOT);
    expect(sections.get('visual-review')?.section).toBe('new');
    expect(sections.get('pr-gif')?.section).toBe('gif after a force-push');
    expect(outdated.map((u) => u.id).sort()).toEqual([3, 4]);
  });

  it('prefers the later comment for the same commit', () => {
    const { sections, outdated } = latest(
      [upload(1, 'visual-review', A, 'one'), upload(2, 'visual-review', A, 'two')],
      BOT,
    );
    expect(sections.get('visual-review')?.section).toBe('two');
    expect(outdated.map((u) => u.id)).toEqual([1]);
  });
});

group('withSections', () => {
  it("writes each bot's block and leaves the rest of the description", () => {
    const body = `Mine.\n\n${blocks.markers('pr-gif').start}\nhand\n${blocks.markers('pr-gif').end}`;
    const { sections } = latest([upload(1, 'visual-review', A, 'table')], BOT);
    const out = withSections(body, sections);
    expect(out.startsWith('Mine.')).toBe(true);
    expect(out).toContain('hand');
    expect(out).toContain(
      '<!-- describe:visual-review -->\ntable\n<!-- /describe:visual-review -->',
    );
    expect(withSections(out, sections)).toBe(out);
  });
});

group('describe', () => {
  /**
   * A fake GitHub holding a description that may change under it.
   *
   * @param {string[]} reads what each read of the description returns
   */
  const io = (reads) => {
    /** @type {string[]} */
    const written = [];
    /** @type {string[]} */
    const hidden = [];
    let i = 0;
    return {
      written,
      hidden,
      io: {
        body: () => reads[Math.min(i++, reads.length - 1)],
        write: (/** @type {string} */ b) => written.push(b),
        comments: () => [
          upload(1, 'visual-review', A, 'old'),
          upload(2, 'visual-review', B, 'new'),
        ],
        hide: (/** @type {string} */ id) => hidden.push(id),
        log: () => {},
      },
    };
  };

  it('writes the newest section and hides the old upload', () => {
    const f = io(['Mine.']);
    expect(describe(f.io, BOT)).toBe(true);
    expect(f.written).toHaveLength(1);
    expect(f.written[0]).toContain('new');
    expect(f.hidden).toEqual(['N1']);
  });

  it('writes nothing when the description already holds it', () => {
    const done = withSections('Mine.', latest(io([]).io.comments(), BOT).sections);
    const f = io([done]);
    expect(describe(f.io, BOT)).toBe(false);
    expect(f.written).toEqual([]);
  });

  it('works the edit out again when the description moved, keeping the new text', () => {
    const f = io(['Mine.', 'Mine, edited.', 'Mine, edited.', 'Mine, edited.']);
    describe(f.io, BOT);
    expect(f.written).toHaveLength(1);
    expect(f.written[0].startsWith('Mine, edited.')).toBe(true);
  });

  it('gives up, saying so, when it keeps moving', () => {
    const f = io(['1', '2', '3', '4', '5', '6', '7']);
    expect(() => describe(f.io, BOT)).toThrow(/kept changing/);
    expect(f.written).toEqual([]);
  });
});
