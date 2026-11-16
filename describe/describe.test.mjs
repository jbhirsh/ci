import { describe as group, expect, it } from 'vitest';
import {
  blocks,
  describe,
  isScreenState,
  latest,
  parseUpload,
  partMarker,
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

/**
 * A section in parts: the heading, then a part a state, then the rest.
 *
 * @param {Record<string, string>} screens text by state
 * @param {string} [rest]
 */
const parts = (screens, rest) =>
  [
    partMarker('head'),
    'HEAD',
    ...Object.entries(screens).flatMap(([state, text]) => [
      '',
      partMarker(`screen:${state}`),
      text,
    ]),
    ...(rest === undefined ? [] : ['', partMarker('rest'), rest]),
  ].join('\n');
const slot = (/** @type {string} */ state, inner = '') =>
  `<!-- describe:visual-review:${state} -->${inner ? `\n${inner}\n` : '\n'}<!-- /describe:visual-review:${state} -->`;
/** @param {string} section */
const written = (section, body = '') =>
  withSections(body, latest([upload(1, 'visual-review', A, section)], BOT).sections);

group('a section in parts', () => {
  it('is read with its part lines left out, and refused with any other marker of ours', () => {
    const got = parseUpload(upload(1, 'visual-review', A, parts({ trips: 'T' })), BOT);
    expect(got?.section).toContain('T');
    for (const bad of [
      `${partMarker('head')}\n${SECTION}`,
      `${partMarker('head')}\n${uploadMarker('x', A)}`,
      `${partMarker('head')}\n<!-- describe:pr-gif -->`,
      `${partMarker('head')}\n<!-- /describe:pr-gif -->`,
      // A part a marker can't hold isn't a part line, so it's refused as a marker.
      `${partMarker('head')}\n<!-- describe-part:screen:a--b -->`,
      `${partMarker('head')}\n<!-- describe-part:screen:a b -->`,
    ]) {
      expect(parseUpload(upload(1, 'visual-review', A, bad), BOT)).toBeNull();
    }
  });

  it('still takes only links to attachments, in every part', () => {
    const bad = parts({ trips: '<img src="https://evil.example/x.png">' });
    expect(parseUpload(upload(1, 'visual-review', A, bad), BOT)).toBeNull();
  });

  it('puts a state under the slot an author placed, and the rest under the heading', () => {
    const out = written(
      parts({ trips: 'T', cards: 'C' }, 'R'),
      `1. A.\n\n${slot('trips')}\n\n2. B.`,
    );
    expect(out.indexOf('1. A.')).toBeLessThan(out.indexOf('T'));
    expect(out.indexOf('T')).toBeLessThan(out.indexOf('2. B.'));
    expect(out.indexOf('2. B.')).toBeLessThan(out.indexOf('HEAD'));
    expect(out.indexOf('HEAD')).toBeLessThan(out.indexOf('C'));
    expect(out.indexOf('C')).toBeLessThan(out.indexOf('R'));
    for (const text of ['T', 'C', 'R']) expect(out.split(text)).toHaveLength(2);
    expect(out).not.toContain('describe-part');
  });

  it("shows every part in the bot's block when there is no slot, in order", () => {
    const out = written(parts({ trips: 'T', cards: 'C' }, 'R'));
    expect(out).toBe(
      '<!-- describe:visual-review -->\nHEAD\n\nT\n\nC\n\nR\n<!-- /describe:visual-review -->\n',
    );
  });

  it('fills a slot added later from the same upload, with no other change', () => {
    const first = written(parts({ trips: 'T' }));
    const second = written(parts({ trips: 'T' }), `Intro.\n\n${slot('trips')}\n\n${first}`);
    expect(second.split('T')).toHaveLength(2);
    expect(second.indexOf('T')).toBeLessThan(second.indexOf('HEAD'));
  });

  it('empties a slot whose state has no part, and keeps its markers, even for a section with no parts', () => {
    const body = `Intro.\n\n${slot('trips', 'old')}`;
    for (const section of [parts({ cards: 'C' }), '### Visual changes: none']) {
      const out = written(section, body);
      expect(out).not.toContain('old');
      expect(blocks.find(out, 'visual-review:trips')).not.toBeNull();
    }
  });

  it('leaves an upload with no part lines as it always was', () => {
    expect(written('table', 'Mine.')).toBe(
      'Mine.\n\n<!-- describe:visual-review -->\ntable\n<!-- /describe:visual-review -->\n',
    );
  });

  it("gives a slot nested in another, or inside the bot's own block, no part", () => {
    const inner = slot('cards');
    const nested = `<!-- describe:visual-review:trips -->\n${inner}\n<!-- /describe:visual-review:trips -->`;
    const out = written(parts({ trips: 'T', cards: 'C' }), nested);
    expect(out.split('C')).toHaveLength(2);
    expect(out.split('T')).toHaveLength(2);
    const inside = `<!-- describe:visual-review -->\n${slot('trips')}\n<!-- /describe:visual-review -->`;
    const out2 = written(parts({ trips: 'T' }), inside);
    expect(out2.split('T')).toHaveLength(2);
  });

  it('treats a state with two pairs, or a torn one, as no slot, and shows its part once', () => {
    const torn = '<!-- describe:visual-review:trips -->\nauthor';
    for (const body of [
      `${slot('trips')}\n\n${slot('trips')}`,
      torn,
      `${torn}\n${slot('trips')}`,
    ]) {
      const out = written(parts({ trips: 'T' }), body);
      expect(out.split('T')).toHaveLength(2);
      expect(out.indexOf('T')).toBeGreaterThan(out.indexOf('HEAD'));
    }
  });

  it("gives a state a marker can't hold no slot, whatever the description says", () => {
    expect(isScreenState('a--b')).toBe(false);
    expect(isScreenState('a b')).toBe(false);
    expect(isScreenState('trips-1.v2_x')).toBe(true);
    const out = written(parts({}, 'R'), slot('a--b'));
    expect(out).toContain('R');
  });

  it("keeps another bot's section as it is", () => {
    const sections = latest(
      [upload(1, 'visual-review', A, parts({ trips: 'T' })), upload(2, 'pr-gif', A, 'gif')],
      BOT,
    ).sections;
    const out = withSections(slot('trips'), sections);
    expect(out).toContain('<!-- describe:pr-gif -->\ngif\n<!-- /describe:pr-gif -->');
  });

  it("leaves another tool's block inside a slot alone, so the slot gets no part", () => {
    const gif = '<!-- pr-gif:s -->\ng\n<!-- /pr-gif:s -->';
    const body = `<!-- describe:visual-review:trips -->${gif}<!-- /describe:visual-review:trips -->`;
    const out = written(parts({ trips: 'T' }), body);
    expect(out).toContain(gif);
    expect(out.split('T')).toHaveLength(2);
    expect(out.indexOf('T')).toBeGreaterThan(out.indexOf('HEAD'));
  });

  it('puts the text of a part named twice into its slot, and text before the first part in the rest', () => {
    const section = `LEAD\n${partMarker('screen:trips')}\nA\n${partMarker('screen:trips')}\nB`;
    const out = written(section, slot('trips'));
    expect(out.indexOf('A')).toBeLessThan(out.indexOf('B'));
    expect(out).toContain(slot('trips', 'A\n\nB'));
    expect(out.indexOf('LEAD')).toBeGreaterThan(out.indexOf('B'));
  });

  it('adds no blank lines for a part with no text', () => {
    const out = written(
      `${partMarker('head')}\nH\n${partMarker('screen:b')}\nB\n${partMarker('rest')}\n`,
    );
    expect(out).toBe('<!-- describe:visual-review -->\nH\n\nB\n<!-- /describe:visual-review -->\n');
  });

  it('never gives a name outside letters, digits, . _ and - a slot, however it is written', () => {
    for (const state of ['café', 'a:b', 'a/b', 'a--b', 'a b']) {
      expect(isScreenState(state)).toBe(false);
    }
  });
});
