import { describe, expect, it } from 'vitest';
import { client } from './github.mjs';
import { editPost, endpoint, listPosts, ownOrBot, readPost, toPost } from './posts.mjs';
import { comment, emptyRepo, fakeGitHub, issue } from './test-fakes.mjs';

const R = 'o/app';

describe('toPost', () => {
  it('keys an issue by its number and the rest by id, and reads a release author', () => {
    expect(toPost(R, 'issue', issue(R, 7, 'x'))).toMatchObject({
      key: 'o__app__issue-7',
      id: 7,
      author: 'jbhirsh',
      body: 'x',
    });
    const release = {
      id: 3,
      body: null,
      author: { login: 'bot[bot]' },
      html_url: 'h',
      published_at: 'p',
    };
    expect(toPost(R, 'release', release)).toEqual({
      key: 'o__app__release-3',
      repo: R,
      kind: 'release',
      id: 3,
      number: null,
      html: 'h',
      author: 'bot[bot]',
      updatedAt: 'p',
      body: '',
    });
    expect(toPost(R, 'issue-comment', { id: 1, user: null, body: 'b' }).author).toBe('');
  });
});

describe('endpoint', () => {
  it('names the path and method that edit each kind', () => {
    const at = (/** @type {import('./posts.mjs').Kind} */ kind) =>
      endpoint({ repo: R, kind, id: 5, number: 2 });
    expect(at('issue')).toEqual({ path: 'repos/o/app/issues/5', method: 'PATCH' });
    expect(at('issue-comment').path).toBe('repos/o/app/issues/comments/5');
    expect(at('review-comment').path).toBe('repos/o/app/pulls/comments/5');
    expect(at('review')).toEqual({ path: 'repos/o/app/pulls/2/reviews/5', method: 'PUT' });
    expect(at('commit-comment').path).toBe('repos/o/app/comments/5');
    expect(at('release').path).toBe('repos/o/app/releases/5');
  });
});

describe('listPosts', () => {
  it('reads every kind, reviews per PR only, and drops empty bodies', async () => {
    const data = emptyRepo();
    data.issues.push(issue(R, 1, 'pr'), issue(R, 2, 'issue', { pr: false }), issue(R, 3, ''));
    data['issues/comments'].push(comment(R, 10, 'c'));
    data['pulls/comments'].push(comment(R, 11, 'rc'));
    data.comments.push(comment(R, 12, 'cc'));
    data.releases.push(comment(R, 13, 'notes'));
    data.reviews[1] = [comment(R, 14, 'review'), comment(R, 15, '')];
    data.reviews[2] = [comment(R, 16, 'never read: #2 is an issue')];
    const { fetch } = fakeGitHub({ [R]: data });
    /** @type {string[]} */
    const lines = [];
    const posts = await listPosts(client({ fetch, log: () => {} }), R, (l) => void lines.push(l));
    expect(posts.map((p) => p.key)).toEqual([
      'o__app__issue-1',
      'o__app__issue-2',
      'o__app__issue-comment-10',
      'o__app__review-comment-11',
      'o__app__commit-comment-12',
      'o__app__release-13',
      'o__app__review-14',
    ]);
    expect(posts.at(-1)?.number).toBe(1);
    expect(lines).toEqual([
      "o/app: 7 posts with text, from 3 issues and PRs, their comments and 2 PRs' reviews",
    ]);
  });

  it('reads a post again and edits it', async () => {
    const data = emptyRepo();
    data.reviews[4] = [comment(R, 20, 'old')];
    const { fetch, writes } = fakeGitHub({ [R]: data });
    const api = client({ fetch, log: () => {} });
    const post = toPost(R, 'review', data.reviews[4][0], 4);
    const edited = await editPost(api, post, 'new');
    expect(edited.body).toBe('new');
    expect(writes).toEqual([{ method: 'PUT', path: 'o/app/pulls/4/reviews/20', body: 'new' }]);
    expect((await readPost(api, post)).body).toBe('new');
  });
});

describe('ownOrBot', () => {
  it("is the repo owner's or a bot's, without case", () => {
    expect(ownOrBot('JBHirsh', 'jbhirsh/app')).toBe(true);
    expect(ownOrBot('github-actions[bot]', 'jbhirsh/app')).toBe(true);
    expect(ownOrBot('someone', 'jbhirsh/app')).toBe(false);
  });
});
