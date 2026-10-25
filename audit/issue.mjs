// Keeps one GitHub issue per weekly-audit category ("Dead code (weekly
// audit)", …), labelled `weekly-audit`. A sweep with findings opens the
// category's issue, or rewrites the body of the open one, so the issue
// always shows the latest report and never collects a comment a week; a
// closed one is reopened, so the category's history stays in one place. A
// clean sweep closes it as completed, with a comment saying so. Issues are
// found by exact title among those labelled `weekly-audit`, so renaming a
// category opens a new issue. The run itself stays green whatever it finds:
// the issue is the alert.
//
// `gh` does the work (audit/run.mjs hands it in), so GH_TOKEN needs issues
// write.

export const LABEL = 'weekly-audit';

/** GitHub refuses an issue body over 65,536 characters; this leaves room. */
export const MAX_BODY = 65_000;

/**
 * @typedef {{ number: number, title: string, state: 'OPEN' | 'CLOSED' }} Issue
 * @typedef {'create' | 'update' | 'reopen' | 'close' | 'none'} Action
 * @typedef {(args: string[], input?: string) => string} Gh runs gh with
 *   `input` on stdin and returns its stdout
 */

/**
 * What to do with a category's issue: open one for new findings, keep the
 * open one current (or reopen a closed one), close it once a sweep is clean.
 *
 * @param {Pick<Issue, 'state'> | undefined} existing
 * @param {boolean} found
 * @returns {Action}
 */
export function issueAction(existing, found) {
  if (found) {
    if (!existing) return 'create';
    return existing.state === 'OPEN' ? 'update' : 'reopen';
  }
  return existing?.state === 'OPEN' ? 'close' : 'none';
}

/**
 * The issue body: the findings, then where they came from. A report too long
 * for an issue is cut at a line, with a note sending the reader to the run.
 *
 * @param {string} findings
 * @param {string} runUrl
 * @param {number} [maxLength]
 */
export function issueBody(findings, runUrl, maxLength = MAX_BODY) {
  const footer = `\n\n---\n_Updated by the [weekly audit](${runUrl}). It closes this issue once a sweep finds nothing._\n`;
  const cut = `\n\n_Cut short: the full report is in [the run](${runUrl})._`;
  let text = findings.trim();
  if (text.length + footer.length > maxLength) {
    text = text.slice(0, Math.max(0, maxLength - footer.length - cut.length));
    const lastLine = text.lastIndexOf('\n');
    if (lastLine > 0) text = text.slice(0, lastLine);
    text += cut;
  }
  return text + footer;
}

/**
 * The issue labelled `weekly-audit` with exactly this title, open or closed
 * (the newest, should there be several).
 *
 * @param {Gh} gh
 * @param {string} title
 * @returns {Issue | undefined}
 */
export function findIssue(gh, title) {
  /** @type {unknown} */
  const issues = JSON.parse(
    gh([
      'issue',
      'list',
      '--label',
      LABEL,
      '--state',
      'all',
      '--limit',
      '100',
      '--json',
      'number,title,state',
    ]),
  );
  if (!Array.isArray(issues)) throw new Error('gh issue list gave no list');
  return /** @type {Issue[]} */ (issues)
    .filter((issue) => issue.title === title)
    .sort((a, b) => b.number - a.number)[0];
}

/**
 * Brings the category's issue in line with this sweep, and says what it did.
 *
 * @param {{ title: string, findings: string, runUrl: string, date: string }} sweep
 *   `findings` is the report, empty for a clean sweep
 * @param {Gh} gh
 */
export function sync({ title, findings, runUrl, date }, gh) {
  const existing = findIssue(gh, title);
  const action = issueAction(existing, findings.trim() !== '');
  const body = issueBody(findings, runUrl);
  switch (action) {
    case 'create':
      gh([
        'label',
        'create',
        LABEL,
        '--force',
        '--color',
        'C5DEF5',
        '--description',
        'Found by the weekly audit',
      ]);
      // The body goes on stdin: a long report could pass the argument limit.
      gh(['issue', 'create', '--title', title, '--label', LABEL, '--body-file', '-'], body);
      break;
    case 'reopen':
      gh(['issue', 'reopen', String(existing?.number)]);
      gh(['issue', 'edit', String(existing?.number), '--body-file', '-'], body);
      break;
    case 'update':
      gh(['issue', 'edit', String(existing?.number), '--body-file', '-'], body);
      break;
    case 'close':
      gh([
        'issue',
        'close',
        String(existing?.number),
        '--reason',
        'completed',
        '--comment',
        `The ${date} weekly audit found nothing, so this is resolved: ${runUrl}`,
      ]);
      break;
    default:
      break;
  }
  return `${title}: ${action}${existing ? ` (#${existing.number})` : ''}.`;
}
