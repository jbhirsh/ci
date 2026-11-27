// The bots' sections in a PR's or an issue's description (ci#64, ci#144):
// visual-review's table today. A bot hands its finished section to place(),
// which writes it between `<!-- describe:<bot> -->` markers, and each part of
// it under the slot an author placed for it, with the Actions token: GitHub
// starts no workflow for that token's edits. visual-review's attach job runs it
// right after the one edit that uploads the pictures (visual-review/attach.mjs),
// in the concurrency group PR GIFs' attach job shares, so edits take turns.
//
// Until ci#144, each bot posted its pictures in an upload comment with
// BOT_PR_TOKEN and this copied the newest one's section in. parseUpload still
// reads such a comment, for what remains of them: visual review's fallback for
// a PR with no record in its description yet, and the cleanup's dry run. An
// upload comment counts only if:
//   - BOT_PR_TOKEN's own account wrote it (no one else can post as it);
//   - it starts with `<!-- describe-upload:<bot>:<sha> -->`, a bot name
//     and the commit it's for;
//   - its section, after `<!-- describe-section -->`, links only GitHub
//     attachments (`https://github.com/user-attachments/assets/…`) and
//     commits (`https://github.com/<owner>/<repo>/commit/<sha>`).
//
// The description is read again just before it's written, and the edit is
// worked out afresh if it changed meanwhile, so a person's edit is lost
// only if it lands in the same moment. GitHub has no conditional edit.
//
// A section may come in parts (ci#80, ci#87), so a bot's pictures sit under
// the change that made them rather than in one block. The section is then
// lines `<!-- describe-part:<key> -->` each followed by that part's text, the
// key `head` (the summary), `rest` (text no slot can take), `screen:<state>`
// (a screen's whole text), or, for tables, `header:big` and `header:minor`
// (a table's two header lines), `big:<state>` and `minor:<state>` (its rows;
// no state for rows a slot can't name) and `fold:open` or `fold:closed` (the
// label of the fold the minor rows no slot took go in, and whether it starts
// open). A slot gets a screen's tables, each with its header; the bot's block
// gets the rows no slot took in one table each, the minor ones in the fold
// with their count, and a note that they wait for a place when the
// description has any slot.
// A section with no part line is one part, as before. The author puts
// `<!-- describe:<bot>:<state> -->` … `<!-- /describe:<bot>:<state> -->`
// (a slot) under a change, and the part of that state goes in it; every
// other part goes in the bot's own block, in order, so nothing is lost. A
// slot whose state has no part this run is emptied, its markers kept. A slot
// counts only when it is a clean pair (placedSlots says what that is): a
// doubled, nested, torn or overlapping one, or one around another tool's
// block, is the author's text, and its
// part goes to the bot's block. The block is emptied before the slots are
// read, so a marker inside it is gone and can't count. A state is a file
// name's, so one outside letters, digits, `.`, `_` and `-`, or holding `--`,
// never gets a slot or a part (its rows stay in the bot's block). Part lines never reach the description. Slots added
// by editing the description are filled on the next run: visual review
// re-renders its section from the links its record keeps (record.mjs), so no
// new upload is needed.

import { blocksFor } from '../lib/blocks.mjs';

/** The first line of an upload comment, for a bot and a commit. */
export const uploadMarker = (bot: string, sha: string) => `<!-- describe-upload:${bot}:${sha} -->`;
/** Where the finished section starts in an upload comment. */
export const SECTION = '<!-- describe-section -->';
/** The sections' markers in the description. */
export const blocks = blocksFor('describe', { named: 'a bot named', where: 'a description' });
/** How many times a write is worked out again when the description moved. */
const ATTEMPTS = 3;

/** What a part's key may name: letters, digits, `.`, `_` and `-`, no `--`; a state is a file name, and blocks.mjs must take the key. */
export const isScreenState = (state: string) =>
  /^[A-Za-z0-9._-]+$/.test(state) && !state.includes('--');
/** The line that starts a part in an upload's section. */
export const partMarker = (key: string) => `<!-- describe-part:${key} -->`;
const PART = /^<!-- describe-part:([^\s<>]+) -->$/;

/**
 * What a part key says: its kind and, for a screen's, its state; null when
 * it isn't one describe knows (a state it can't name included).
 */
function parseKey(key: string): { kind: string; state?: string } | null {
  if (['head', 'rest', 'big', 'minor', 'header:big', 'header:minor'].includes(key)) {
    return { kind: key };
  }
  if (key === 'fold:open' || key === 'fold:closed') return { kind: key };
  const m = /^(screen|big|minor):(.+)$/.exec(key);
  return m && isScreenState(m[2]) ? { kind: m[1], state: m[2] } : null;
}

/**
 * The key a line starts a part with, or null when it isn't a part line.
 */
function partKey(line: string) {
  const m = PART.exec(line.trimEnd());
  return m && parseKey(m[1]) ? m[1] : null;
}

/** Any tool's block marker (lib/blocks.mjs): `<!-- prefix:key -->` or `<!-- /prefix:key -->`. */
const ANY_MARKER = /<!-- \/?[a-z][a-z0-9-]*:[^\s<>]+ -->/;

const UPLOAD = /^<!-- describe-upload:([a-z][a-z0-9-]{0,39}):([0-9a-f]{40}) -->/;
const ATTACHMENT = /^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]{8,64}$/;
/** A commit's page: a section may link the commit it was compared with. */
const COMMIT = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/commit\/[0-9a-f]{40}$/;

/** A comment, as far as this reads it. */
export type Comment = {
  id: number;
  node_id: string;
  body?: string | null;
  user?: { login?: string } | null;
};

/** An upload comment that counts. */
export type Upload = { id: number; nodeId: string; bot: string; sha: string; section: string };

/**
 * Every link or picture source in a section.
 */
function urlsIn(text: string) {
  return [
    ...[...text.matchAll(/\]\(([^)\s]*)/g)].map((m) => m[1]),
    ...[...text.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]),
    ...[...text.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]),
  ];
}

/**
 * The upload a comment is, or null when it doesn't count.
 *
 * @param comment
 * @param login BOT_PR_TOKEN's account
 */
export function parseUpload(comment: Comment, login: string): Upload | null {
  if (comment.user?.login !== login) return null;
  const body = comment.body ?? '';
  const m = UPLOAD.exec(body);
  if (!m) return null;
  const at = body.indexOf(SECTION);
  if (at === -1) return null;
  const section = body.slice(at + SECTION.length).trim();
  // A marker inside would cut the block short or start another. The part
  // lines are the one thing of ours a section may hold.
  const plain = section
    .split('\n')
    .filter((line) => partKey(line) === null)
    .join('\n');
  if (plain.includes('<!-- describe') || plain.includes('<!-- /describe')) return null;
  if (!urlsIn(section).every((url) => ATTACHMENT.test(url) || COMMIT.test(url))) return null;
  return { id: comment.id, nodeId: comment.node_id, bot: m[1], sha: m[2], section };
}

/**
 * A section's parts, in order, or null when it has no part line.
 */
function partsOf(
  section: string,
): { key: string; kind: string; state?: string; text: string }[] | null {
  const parts: { key: string; kind: string; state?: string; lines: string[] }[] = [];
  let any = false;
  for (const line of section.split('\n')) {
    const key = partKey(line);
    if (key !== null) {
      any = true;
      const { kind, state } = parseKey(key) as { kind: string; state?: string };
      // A part named twice reads as two, and a slot takes both.
      parts.push({ key, kind, state, lines: [] });
    } else if (parts.length > 0) parts[parts.length - 1].lines.push(line);
    else if (line.trim() !== '') parts.push({ key: 'rest', kind: 'rest', lines: [line] });
  }
  if (!any) return null;
  return parts.map(({ key, kind, state, lines }) => ({
    key,
    kind,
    state,
    text: lines.join('\n').trim(),
  }));
}

/**
 * The states with a slot in the description that counts for this bot: one
 * start and one end of its own, with nothing of any tool's markers between
 * them, the bot's other markers (a slot's, or its block's) and another
 * tool's blocks (`pr-gif:`, `pictures:`) alike. Writing such a slot destroys
 * no marker and no one's block, so the next run reads the same slots; a
 * doubled, nested, torn or overlapping one, or one around a block, is left
 * as the author wrote it.
 */
function placedSlots(body: string, bot: string): Set<string> {
  const marks = [
    ...body.matchAll(new RegExp(`<!-- (/?)describe:${bot}(?::([^\\s<>]+))? -->`, 'g')),
  ].map((m) => ({
    end: m[1] === '/',
    state: m[2],
    from: m.index as number,
    to: (m.index as number) + m[0].length,
  }));
  const placed: Set<string> = new Set();
  marks.forEach((mark, i) => {
    const { state } = mark;
    if (mark.end || state === undefined || !isScreenState(state)) return;
    const own = marks.filter((m) => m.state === state);
    const next = marks[i + 1];
    if (own.length !== 2 || !next || !next.end || next.state !== state) return;
    if (!ANY_MARKER.test(body.slice(mark.to, next.from))) placed.add(state);
  });
  return placed;
}

/**
 * A table from its header and the rows of the parts that make it.
 */
const table = (header: string, rows: string[]) =>
  rows.length > 0 ? `${header}\n${rows.join('\n')}` : '';

/**
 * The description with one bot's section in it.
 */
function writeSection(body: string, bot: string, section: string) {
  const parts = partsOf(section) ?? [];
  const has = (kind: string) => parts.find((p) => p.kind === kind)?.text ?? '';
  // The block is emptied first, and the slots that count are read from what
  // is left: writing it later can't destroy a marker that made a slot not
  // count, which would make the next run decide differently.
  let out = blocks.write(body, bot, '');
  const slots = placedSlots(out, bot);
  /**
   * The tables of one screen, or of the screens no slot took.
   */
  const tables = (takes: (p: { state?: string }) => boolean) => ({
    big: table(
      has('header:big'),
      parts.filter((p) => p.kind === 'big' && takes(p)).map((p) => p.text),
    ),
    minor: table(
      has('header:minor'),
      parts.filter((p) => p.kind === 'minor' && takes(p)).map((p) => p.text),
    ),
    // A screen's rows (its sizes) are one screen; a part with no state holds
    // one screen a row.
    minorScreens: parts
      .filter((p) => p.kind === 'minor' && takes(p))
      .reduce((n, p) => n + (p.state === undefined ? p.text.split('\n').length : 1), 0),
  });
  for (const state of slots) {
    const mine = tables((p) => p.state === state);
    const text = [
      ...parts.filter((p) => p.kind === 'screen' && p.state === state).map((p) => p.text),
      mine.big,
      mine.minor,
    ];
    out = blocks.write(out, `${bot}:${state}`, text.filter(Boolean).join('\n\n'));
  }
  if (!partsOf(section)) return blocks.write(out, bot, section);
  const left = tables((p) => p.state === undefined || !slots.has(p.state));
  const fold = parts.find((p) => p.kind === 'fold:open' || p.kind === 'fold:closed');
  // What's left for the bot's block: the heading and the rows no slot took.
  // With slots in the description, say they're waiting for a place.
  const waiting =
    slots.size > 0 && (left.big || left.minor) ? '_Not placed under a change yet._' : '';
  const rest = [
    ...parts
      .filter(
        (p) =>
          ['head', 'rest'].includes(p.kind) ||
          (p.kind === 'screen' && !slots.has(p.state as string)),
      )
      .map((p) => p.text),
    waiting,
    left.big,
    fold && !parts.some((p) => p.kind === 'minor')
      ? `${fold.text}: none`
      : left.minor && fold
        ? `<details${fold.kind === 'fold:open' ? ' open' : ''}><summary>${fold.text}: ${left.minorScreens} screen${left.minorScreens === 1 ? '' : 's'}</summary>\n\n${left.minor}\n\n</details>`
        : left.minor,
  ];
  return blocks.write(out, bot, rest.filter(Boolean).join('\n\n'));
}

/**
 * The description with each bot's section in it.
 *
 * @param body
 * @param sections by bot
 */
export function withSections(body: string, sections: ReadonlyMap<string, { section: string }>) {
  let out = body;
  for (const [bot, { section }] of [...sections].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out = writeSection(out, bot, section);
  }
  return out;
}

/** What place needs from GitHub. */
export type Io = {
  /** the description, read now */
  body: () => string;
  /** sets it (the Actions token) */
  write: (body: string) => void;
  log: (line: string) => void;
};

/**
 * Writes a bot's section into the description, each part in its slot.
 * Returns whether the description changed.
 *
 * @param io
 * @param bot
 * @param section
 * @param tidy applied to the description as read,
 *   before the section goes in (attach.mjs drops what gh appended)
 */
export function place(
  io: Io,
  bot: string,
  section: string,
  tidy: (body: string) => string = (body) => body,
) {
  const sections = new Map([[bot, { section }]]);
  for (let attempt = 1; ; attempt++) {
    const before = io.body();
    const after = withSections(tidy(before), sections);
    if (after === before) {
      io.log(`describe: ${bot}'s section already up to date`);
      return false;
    }
    // Read again just before writing: an edit meanwhile is worked in.
    if (io.body() !== before) {
      if (attempt >= ATTEMPTS) {
        throw new Error(
          `the description kept changing while describe wrote it (${ATTEMPTS} tries): run this job again`,
        );
      }
      continue;
    }
    io.write(after);
    io.log(`describe: ${bot}'s section written`);
    return true;
  }
}
