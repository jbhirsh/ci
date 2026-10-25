// Fails a PR when one of its commits breaks a commit-message rule the apps
// share (each app's CLAUDE.md, "Commit hygiene") that a script can judge:
//   - the subject is at most 72 characters;
//   - a blank line and a body follow the subject (trailers alone don't
//     count as a body);
//   - no fixup!/squash!/amend! commits or "wip"/"oops" subjects, which
//     belong squashed into the commit they patch;
//   - no merge commits: history is linear (rebase, not merge).
// Whether the subject is imperative and the body explains why stays with
// Claude Review, as does a typo fix that should have been squashed.
// Dependabot's commits are exempt (their format is Dependabot's);
// claude-autofix's commits are checked like any other.
//
// Reads the PR's commits from the API, so the app's checkout can stay
// shallow: `node check.mjs` with GH_TOKEN (pull-requests: read), PR_NUMBER
// and GITHUB_REPOSITORY set, as commits/action.yml runs it.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * One commit as the check reads it.
 *
 * @typedef {object} Commit
 * @property {string} sha the short SHA, for the annotation
 * @property {string} login the author's GitHub login ('' when GitHub knows none)
 * @property {number} parents how many parents it has
 * @property {string} message the whole message
 */

const SQUASH_ME = /^((fixup|squash|amend)!|(wip|oops)([^a-z]|$))/i;
const TRAILER = /^[A-Za-z][A-Za-z-]*: /;
const KNOWN_TRAILER = /^(co-authored-by|signed-off-by|claude-session): /;

/**
 * The body: everything after the subject's blank line, minus a closing
 * trailer block (Co-Authored-By: and the like). A last paragraph counts as
 * trailers when every line is "Key: value" and either it follows a body
 * paragraph or it names a known trailer, so a body line that happens to read
 * "Why: ..." still counts as body.
 *
 * @param {string} message
 * @returns {string}
 */
export function body(message) {
  const rest = message.split('\n').slice(2).join('\n');
  const paragraphs = rest.split(/\n{2,}/).filter((p) => p.replace(/\n/g, '') !== '');
  const last = paragraphs.at(-1);
  if (last !== undefined) {
    const lines = last.split('\n').filter((line) => line !== '');
    const allTrailers = lines.every((line) => TRAILER.test(line));
    const known = lines.some((line) => KNOWN_TRAILER.test(line.toLowerCase()));
    if (allTrailers && (paragraphs.length > 1 || known)) paragraphs.pop();
  }
  return paragraphs.join('\n\n');
}

/**
 * What's wrong with one commit's message: nothing for Dependabot's, and for
 * a merge commit only that it is one.
 *
 * @param {Commit} commit
 * @returns {string[]}
 */
export function problems(commit) {
  if (commit.login === 'dependabot[bot]') return [];
  if (commit.parents > 1) return ['merge commit. Rebase onto main instead of merging it in.'];
  const [subject = '', second = ''] = commit.message.split('\n');
  /** @type {string[]} */
  const found = [];
  // Characters, not UTF-16 units: an emoji is one.
  const length = [...subject].length;
  if (length > 72) found.push(`subject is ${length} characters; the limit is 72.`);
  if (SQUASH_ME.test(subject)) found.push('squash this into the commit it patches.');
  if (second !== '') found.push('the subject needs a blank line after it.');
  if (body(commit.message) === '') {
    found.push('no body. Add one explaining why the change is needed.');
  }
  return found;
}

/**
 * The GitHub annotations for every problem in these commits.
 *
 * @param {Commit[]} commits
 * @returns {string[]}
 */
export function annotations(commits) {
  return commits.flatMap((commit) => {
    const subject = commit.message.split('\n')[0];
    return problems(commit).map(
      (problem) => `::error title=Commit ${commit.sha}::"${subject}": ${problem}`,
    );
  });
}

/**
 * Reads one line of `gh api … --jq '.[] | {…} | @json'` output.
 *
 * @param {string} line
 * @returns {Commit}
 */
export function parseCommit(line) {
  /** @type {unknown} */
  const value = JSON.parse(line);
  const record = /** @type {Record<string, unknown>} */ (value);
  if (
    typeof record?.sha !== 'string' ||
    typeof record.login !== 'string' ||
    typeof record.parents !== 'number' ||
    typeof record.message !== 'string'
  ) {
    throw new Error(`unexpected commit from the API: ${line}`);
  }
  return {
    sha: record.sha,
    login: record.login,
    parents: record.parents,
    message: record.message,
  };
}

/**
 * The PR's commits, read through `gh` (`run` takes gh's arguments and
 * returns its stdout). Paginated, so a long PR is read whole.
 *
 * @param {string} repo
 * @param {string} pr
 * @param {(args: string[]) => string} run
 * @returns {Commit[]}
 */
export function prCommits(repo, pr, run) {
  const out = run([
    'api',
    '--paginate',
    `repos/${repo}/pulls/${pr}/commits`,
    '--jq',
    '.[] | {sha: .sha[0:7], login: (.author.login // ""), parents: (.parents | length), message: .commit.message} | @json',
  ]);
  return out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(parseCommit);
}

/**
 * Runs the check and returns the exit code, printing as it goes.
 *
 * @param {Record<string, string | undefined>} env
 * @param {(args: string[]) => string} run
 * @param {(line: string) => void} [print]
 */
export function main(env, run, print = console.log) {
  const { GITHUB_REPOSITORY: repo, PR_NUMBER: pr } = env;
  if (!repo || !pr) throw new Error('GITHUB_REPOSITORY and PR_NUMBER are needed');
  const errors = annotations(prCommits(repo, pr, run));
  for (const line of errors) print(line);
  if (errors.length > 0) {
    print('Reword with `git rebase -i origin/main`, then force-push the branch.');
    return 1;
  }
  print('All commit messages pass.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gh = (/** @type {string[]} */ args) =>
    execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  process.exitCode = main(process.env, gh);
}
