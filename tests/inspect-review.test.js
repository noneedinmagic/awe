import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectReview, latestCodexResult } from '../scripts/lib/inspect-review.js';

const opts = { codexActor: 'chatgpt-codex-connector[bot]', headSha: 'head1' };
const codexReview = (over = {}) => ({
  id: 7, state: 'COMMENTED', commit_id: 'head1',
  user: { login: 'chatgpt-codex-connector[bot]' }, ...over,
});

test('review by another actor is irrelevant', () => {
  const r = inspectReview(codexReview({ user: { login: 'someone' } }), [], opts);
  assert.equal(r.relevant, false);
});

test('review for an old SHA is stale, never satisfies current head', () => {
  const r = inspectReview(codexReview({ commit_id: 'old' }), [], opts);
  assert.deepEqual([r.relevant, r.stale], [false, true]);
});

test('clean review: commented, no inline findings', () => {
  const r = inspectReview(codexReview(), [], opts);
  assert.deepEqual([r.relevant, r.blocking], [true, false]);
});

test('CHANGES_REQUESTED blocks even with zero inline comments', () => {
  const r = inspectReview(codexReview({ state: 'CHANGES_REQUESTED' }), [], opts);
  assert.ok(r.blocking);
});

test('any inline comment on the review counts as a finding (conservative)', () => {
  const comments = [
    { id: 1, pull_request_review_id: 7, path: 'a.js', line: 3, body: '![P1 Badge](x) off-by-one' },
    { id: 2, pull_request_review_id: 99, path: 'b.js', line: 1, body: 'unrelated other review' },
  ];
  const r = inspectReview(codexReview(), comments, opts);
  assert.ok(r.blocking);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].priority, 'P1');
});

test('dismissed review is ignored, even with inline findings still attached', () => {
  const comments = [{ id: 1, pull_request_review_id: 7, path: 'a.js', line: 3, body: '![P1 Badge](x) off-by-one' }];
  const r = inspectReview(codexReview({ state: 'DISMISSED' }), comments, opts);
  assert.equal(r.relevant, false);
});

test('latestCodexResult picks newest relevant review', () => {
  const reviews = [
    codexReview({ id: 1, state: 'CHANGES_REQUESTED' }),
    codexReview({ id: 2, state: 'COMMENTED' }),
  ];
  const r = latestCodexResult(reviews, [], opts);
  assert.equal(r.blocking, false);
  assert.equal(latestCodexResult([], [], opts), null);
});

test('#107: a reply-only auto-wrapped review never shadows the reviewer\'s real verdict — live PR #105 shape', () => {
  // Reproduces the exact reviews from issue #107: three reviews submitted by the same
  // actor within two seconds, the last two being GitHub's own auto-wrap of standalone
  // adjudication-reply comments (empty body, COMMENTED, one reply comment each) around
  // the reviewer's real, no-findings verdict. Before #107's fix, `latestCodexResult` (no
  // `rootFindingsOnly` passed — this is orchestrate.js:562's real call shape) picked the
  // newest, misread its lone reply comment as a fresh finding, and reported `blocking`.
  // Before #123's fix, the two wrappers stayed `relevant` (just non-blocking) and the
  // higher-id one still shadowed the real review as "newest relevant" — harmless here only
  // because the real review was also clean; #123 is the case where it wasn't (below).
  const reviews = [
    codexReview({ id: 4860029306, body: 'No blocking findings.' }),
    codexReview({ id: 4860029347, body: '' }),
    codexReview({ id: 4860029402, body: '' }),
  ];
  const replies = [
    { id: 1, pull_request_review_id: 4860029347, path: 'a.js', line: 1, in_reply_to_id: 3707162632, body: 'adjudication reply' },
    { id: 2, pull_request_review_id: 4860029402, path: 'b.js', line: 1, in_reply_to_id: 3717078179, body: 'adjudication reply' },
  ];
  const r = latestCodexResult(reviews, replies, opts);
  assert.equal(r.id, 4860029306, 'the two wrappers are dropped at relevance — the real review is the only one left, and it\'s picked on its own merits, not by id order');
  assert.equal(r.blocking, false, 'a reply-only auto-wrap must never be misread as a fresh blocking finding');
  assert.equal(r.findings.length, 0);
});

test('#123: a wrapper review never shadows a real CHANGES_REQUESTED submitted moments earlier — live PR #119 shape', () => {
  // orchestrate.js:230's own P1, reproduced verbatim: normandy-garrus[bot] posted a real
  // CHANGES_REQUESTED with one root finding, then one second later GitHub auto-wrapped its
  // own reply-to-a-different-thread into a fresh COMMENTED review with the higher id.
  // Before #123, `latestCodexResult`'s `.at(-1)` picked the wrapper, read it as a clean
  // verdict, and PR #119 was labelled `ai:ready` over the live P1.
  const reviews = [
    codexReview({ id: 4870162415, state: 'CHANGES_REQUESTED', body: 'Local agent review — 1 blocking finding(s).' }),
    codexReview({ id: 4870162450, body: '' }),
  ];
  const comments = [
    { id: 3725210478, pull_request_review_id: 4870162415, path: 'scripts/orchestrate.js', line: 230, in_reply_to_id: null, body: '**P1** ...' },
    { id: 3725210503, pull_request_review_id: 4870162450, path: 'scripts/orchestrate.js', line: 611, in_reply_to_id: 3725169619, body: 'reply' },
  ];
  const r = latestCodexResult(reviews, comments, opts);
  assert.equal(r.id, 4870162415);
  assert.equal(r.blocking, true);
  assert.equal(r.findings.length, 1);
});

test('#123: a wrapper review never shadows a CONTESTED verdict — live PR #122 shape', () => {
  // Same shape as PR #119 above, but the real review carries CONTESTED_MARKER (the
  // reviewer's adjudication sustained a finding against the fixer's rebuttal) — the marker
  // that routes straight to a reviewer-sustained handoff without burning a round (ADR-0009;
  // this repo's own `agents-disagree` reason at the time #123 was filed). Before #123 the
  // wrapper's empty body zeroed this marker along with `blocking`, and PR #122 was
  // labelled `ai:ready` over a live dispute instead of handed to a human.
  const markerOpts = { ...opts, localReviewActors: ['chatgpt-codex-connector[bot]'] };
  const reviews = [
    codexReview({
      id: 4870193176, state: 'CHANGES_REQUESTED',
      body: 'Local agent review — 1 blocking finding(s).\n\n<!-- ai-orch:local-review -->\n<!-- ai-orch:contested -->',
    }),
    codexReview({ id: 4870193226, body: '' }),
  ];
  const comments = [
    { id: 3725240308, pull_request_review_id: 4870193176, path: 'scripts/lib/telegram.js', line: 56, in_reply_to_id: null, body: '**P1** ...' },
    { id: 3725240341, pull_request_review_id: 4870193226, path: 'scripts/lib/telegram.js', line: 206, in_reply_to_id: 3725203807, body: 'reply' },
  ];
  const r = latestCodexResult(reviews, comments, markerOpts);
  assert.equal(r.id, 4870193176);
  assert.equal(r.contested, true, 'a body-sourced marker is what an empty-bodied wrapper actually destroys, not just blocking');
});

test('#123: a wrapper as the only standing review is not evidence at all', () => {
  const reviews = [codexReview({ id: 1, body: '' })];
  const comments = [{ id: 1, pull_request_review_id: 1, path: 'a.js', line: 1, in_reply_to_id: 99, body: 'reply' }];
  assert.equal(inspectReview(reviews[0], comments, opts).relevant, false);
  assert.equal(latestCodexResult(reviews, comments, opts), null);
});

test('a COMMENTED review with an empty body and no comments at all is still a genuine clean verdict', () => {
  // The guard is deliberately narrow: `attached.length > 0` is required to fire. A terse
  // clean review that posts no body and no comments must never be suppressed.
  const r = inspectReview(codexReview({ body: '' }), [], opts);
  assert.equal(r.relevant, true);
  assert.equal(r.blocking, false);
});
