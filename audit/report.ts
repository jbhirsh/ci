// Turns each weekly-audit tool's JSON report into the findings its tracking
// issue shows (audit/run.ts runs the tools and audit/issue.ts keeps the
// issue): a count, and Markdown saying what was found, where, and what to do
// about it. Each takes the report as the tool wrote it, untrusted in shape,
// so each tolerates fields it doesn't know.

export type Findings = { count: number; markdown: string };

const isRecord = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const record = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? (value as Record<string, unknown>) : {};

const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : []);

// --- Dead code (knip) ------------------------------------------------------

/** knip's issue types, as the issue lists them. */
const KNIP_LABELS = {
  files: 'Unused files',
  dependencies: 'Unused dependencies',
  devDependencies: 'Unused devDependencies',
  optionalPeerDependencies: 'Referenced optional peer dependencies',
  unlisted: 'Unlisted dependencies',
  binaries: 'Unlisted binaries',
  unresolved: 'Unresolved imports',
  exports: 'Unused exports',
  types: 'Unused exported types',
  nsExports: 'Unused exports in namespaces',
  nsTypes: 'Unused exported types in namespaces',
  enumMembers: 'Unused enum members',
  namespaceMembers: 'Unused namespace members',
  classMembers: 'Unused class members',
  duplicates: 'Duplicate exports',
  cycles: 'Circular dependencies',
  catalog: 'Unused catalog entries',
  catalogReferences: 'Unresolved catalog references',
} as Record<string, string>;

/** Fields of a knip issue that say where, not what. */
const KNIP_NOT_FINDINGS = new Set(['file', 'owners']);

/**
 * The named items in one finding: an item, or a list of them (a duplicate
 * export, a cycle).
 */
function namedItems(item: unknown): { name: string; line?: number }[] {
  return (Array.isArray(item) ? item : [item]).flatMap((one) => {
    const r = record(one);
    if (typeof r.name !== 'string') return [];
    return [{ name: r.name, line: typeof r.line === 'number' ? r.line : undefined }];
  });
}

/**
 * The findings under one field of a knip issue: a list of items, or (in
 * older knip) an object of lists keyed by their enum or class, or `true` for
 * an unused file.
 */
function knipItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.values(record(value)).flatMap(knipItems);
  return [];
}

/**
 * knip's `--reporter json` output as findings, grouped by type, each named
 * with its file and line. `config` is the knip config file, for the advice.
 */
export function knipFindings(report: unknown, config: string): Findings {
  const byType: Map<string, string[]> = new Map();
  const add = (type: string, entry: string) =>
    byType.set(type, [...(byType.get(type) ?? []), entry]);
  // Older knip listed unused files at the top level.
  for (const file of list(record(report).files)) {
    if (typeof file === 'string') add('files', `\`${file}\``);
  }
  for (const issue of list(record(report).issues)) {
    const fields = record(issue);
    const file = typeof fields.file === 'string' ? fields.file : '?';
    for (const [type, value] of Object.entries(fields)) {
      if (KNIP_NOT_FINDINGS.has(type)) continue;
      // An unused file is the finding itself, with no name beside it.
      if (type === 'files' && (value === true || namedItems(knipItems(value)).length > 0)) {
        add('files', `\`${file}\``);
        continue;
      }
      for (const item of knipItems(value)) {
        const named = namedItems(item);
        if (named.length === 0) continue;
        const where = named[0].line ? `${file}:${named[0].line}` : file;
        add(type, `${named.map((n) => `\`${n.name}\``).join(', ')} in \`${where}\``);
      }
    }
  }
  const count = [...byType.values()].reduce((sum, entries) => sum + entries.length, 0);
  if (count === 0) return { count, markdown: '' };
  const sections = [...byType].map(
    ([type, entries]) =>
      `### ${KNIP_LABELS[type] ?? type} (${entries.length})\n\n${entries.map((e) => `- ${e}`).join('\n')}`,
  );
  return {
    count,
    markdown: [
      `[knip](https://knip.dev) found code and dependencies nothing uses. Delete them, or, if something does use them in a way knip can’t see, use them a way it reads (an import, a package script) or make their file an \`entry\` in \`${config}\`: an ignore fails the audit.`,
      ...sections,
    ].join('\n\n'),
  };
}

// --- Duplicated code (jscpd) -----------------------------------------------

/**
 * A report path relative to the repository (jscpd writes absolute ones when
 * the app's config asks for them).
 */
function relative(file: string, root: string) {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/**
 * jscpd's JSON report as findings: every clone, largest first.
 *
 * @param report
 * @param root the app's checkout
 */
export function jscpdFindings(report: unknown, root: string): Findings {
  const clones = list(record(report).duplicates)
    .map(record)
    .map((c) => ({
      lines: typeof c.lines === 'number' ? c.lines : 0,
      first: record(c.firstFile),
      second: record(c.secondFile),
    }))
    .sort((a, b) => b.lines - a.lines);
  if (clones.length === 0) return { count: 0, markdown: '' };
  const at = (loc: Record<string, unknown>) =>
    `\`${relative(String(loc.name ?? '?'), root)}:${loc.start}-${loc.end}\``;
  const total = record(record(record(report).statistics).total);
  const percentage = typeof total.percentage === 'number' ? total.percentage : 0;
  const n = clones.length;
  return {
    count: n,
    markdown: [
      `[jscpd](https://github.com/kucherenko/jscpd) found ${n} duplicated block${n === 1 ? '' : 's'} (${percentage.toFixed(2)}% of the lines it read, \`.jscpd.json\`). Pull a repeated one into a shared function or component; a repeat that reads better spelled out twice can stay, with a line in \`.jscpd.json\`'s \`ignore\`.`,
      '| Lines | First | Second |\n|---:|---|---|\n' +
        clones.map((c) => `| ${c.lines} | ${at(c.first)} | ${at(c.second)} |`).join('\n'),
    ].join('\n\n'),
  };
}

// --- Broken links (lychee) -------------------------------------------------

/**
 * One failure's status as lychee wrote it: text, or a code and its text.
 */
function statusText(status: unknown) {
  if (typeof status === 'string') return status;
  const s = record(status);
  if (s.code) return `${s.code}${s.text ? ` ${s.text}` : ''}`;
  return typeof s.text === 'string' ? s.text : JSON.stringify(status);
}

/**
 * The broken links in lychee's JSON report (`error_map`, which older
 * releases called `fail_map`: doc → failures, each with its url and status),
 * listed by doc, since lychee's own Markdown doesn't say which doc each is in.
 */
export function lycheeFindings(report: unknown): Findings {
  const r = record(report);
  const docs = Object.entries(record(r.error_map ?? r.fail_map))
    .map(([doc, failures]) => [doc, list(failures)] as [string, unknown[]])
    .filter(([, failures]) => failures.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  const count = docs.reduce((sum, [, failures]) => sum + failures.length, 0);
  if (count === 0) return { count, markdown: '' };
  const lines = [
    'Links in the docs that no longer resolve: dead pages, missing files or images, or anchors that no heading matches. Fix or remove each; a host that refuses scripts goes in a `.lycheeignore` (one URL pattern per line).',
  ];
  for (const [doc, failures] of docs) {
    lines.push('', `**${doc}**`, '');
    for (const failure of failures) {
      const f = record(failure);
      lines.push(`- ${String(f.url)} — ${statusText(f.status)}`);
    }
  }
  return { count, markdown: lines.join('\n') };
}
