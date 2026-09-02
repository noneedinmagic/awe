import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy } from '../scripts/lib/policy.js';
import { reduce, renderRefreshReply } from '../scripts/lib/state.js';
import {
  parseAiCommand, humanBlockingResult, isCodexDismissal, latestSummonedReviewId, latestSummonedReviewHasThread,
  allSummonedReviewsDismissed,
} from '../scripts/orchestrate.js';
import { qualifyUnresolvedThreads, fetchReviewThreads } from '../scripts/lib/review-threads.js';
import { inspectReview } from '../scripts/lib/inspect-review.js';

const policy = parsePolicy(`
version: 1
mode: active
authors: ["normandy-tali[bot]"]
humans: [oleh]
backends: { reviewer: [local-agent], fixer: [claude-code-action] }
reviewers: { actors: ["normandy-garrus[bot]", "normandy-tali[bot]"] }
`);
const lowRisk = { level: 'low', humanRequired: false, reasons: [] };
const pr = { number: 5, headSha: 'sha1' };
const base = { pr, policy, risk: lowRisk, event: 'test', codexResult: null, ci: 'pending', fixResult: null };
const types = (e) => e.map((x) => x.type);

test('parseAiCommand: commands, instructions, and non-commands', () => {
  assert.deepEqual(parseAiCommand('/ai retry'), { type: 'retry' });
  assert.deepEqual(parseAiCommand('  /ai status  '), { type: 'status' });
  assert.deepEqual(parseAiCommand('/ai fix'), { type: 'fix' });
  assert.deepEqual(parseAiCommand('/ai fix use strict brand matching\nsee thread above'),
    { type: 'fix', instruction: 'use strict brand matching\nsee thread above' });
  assert.deepEqual(parseAiCommand('/ai refresh'), { type: 'refresh' });
  assert.equal(parseAiCommand('/ai destroy'), null);
  assert.equal(parseAiCommand('/ai refreshing'), null, 'must match the whole command word');
  assert.equal(parseAiCommand('please /ai retry'), null, 'must start the comment');
  assert.equal(parseAiCommand('LGTM'), null);
});

test('parseAiCommand: round-cap — valid, malformed, and edge-case arguments', () => {
  assert.deepEqual(parseAiCommand('/ai round-cap 10'), { type: 'round-cap', cap: 10 });
  assert.deepEqual(parseAiCommand('  /ai round-cap 0  '), { type: 'round-cap', cap: 0 }, '0 is a valid cap');
  assert.equal(parseAiCommand('/ai round-cap'), null, 'missing argument');
  assert.equal(parseAiCommand('/ai round-cap abc'), null, 'non-numeric');
  assert.equal(parseAiCommand('/ai round-cap -1'), null, 'negative');
  assert.equal(parseAiCommand('/ai round-cap 1e9'), null, 'not digit-only');
  assert.equal(parseAiCommand(`/ai round-cap ${'9'.repeat(400)}`), null, 'digit string but not a safe integer');
});

test('/ai retry clears a needs-human latch and re-enters the cycle', () => {
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', round: 2, handoff: { done: true, reason: 'fixer-failed' },
  };
  const { next, effects } = reduce({ ...base, prev: stuck, humanCommand: { type: 'retry' } });
  assert.equal(next.state, 'ai:reviewing');
  assert.equal(next.round, 0);
  assert.equal(next.handoff.done, false);
  assert.ok(types(effects).includes('request-codex'), 'fresh review request latched');
});

test('/ai retry with an existing blocking review dispatches the fixer immediately', () => {
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', round: 2, handoff: { done: true, reason: 'fixer-failed' },
  };
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }] };
  const { next, effects } = reduce({ ...base, prev: stuck, codexResult, humanCommand: { type: 'retry' } });
  assert.equal(next.state, 'ai:fixing');
  assert.equal(next.round, 1);
  assert.ok(types(effects).includes('dispatch-fixer'));
});

test('#105 finding: /ai retry from a summoned-review-no-thread handoff preserves the latch when an unrelated blocking codexResult is dispatched in the same event', () => {
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', round: 2, handoff: { done: true, reason: 'summoned-review-no-thread' },
    summonedDuringFix: 42, // latched by the original escalation, same as the /ai fix case
  };
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }] };
  // The summoned review is still standing (not dismissed) — orchestrate.js re-derives it
  // on every run, so this event carries it too, same as a real one would. Unlike `/ai fix`,
  // a bare retry never hands the summoned review's own findings to the fixer (it dispatches
  // on this unrelated codexResult instead), so it earns none of `/ai fix`'s trust to clear
  // the latch outright — see state.js's own retry-handling comment.
  const { next: fixing } = reduce({
    ...base, prev: stuck, codexResult, humanCommand: { type: 'retry' }, summonedReviewId: 42,
  });
  assert.equal(fixing.state, 'ai:fixing');
  assert.equal(fixing.summonedDuringFix, 42, 'must survive — the dispatched round is for an unrelated finding, not this one');

  // That round concludes by pushing — the summoned review is now stale by commit_id, and
  // having never been passed to the fixer, it must hand off rather than vanish.
  const { next, effects } = reduce({
    ...base, prev: fixing, pr: { ...pr, headSha: 'sha2' }, codexResult: null, ci: 'pending', summonedReviewId: null,
  });
  assert.equal(next.state, 'ai:needs-human', 'the summoned finding must not vanish just because retry dispatched an unrelated round');
  assert.equal(next.handoff.reason, 'summoned-review-during-fix');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
});

test('P1 finding on #119 round 4: /ai retry must not clear the latch on a plain summonedReviewId == null without confirmed dismissal', () => {
  // `summonedReviewId` can go null on an unchanged head for a reason unrelated to
  // dismissal — a base-policy edit reclassifying the latched review's author out of the
  // summoned-actor set. A bare `/ai retry` must require `summonedDuringFixDismissed`
  // (the caller's raw-review-state confirmation), same as the top-of-function no-push
  // release branch, or it silently drops a still-standing, unaddressed summoned review.
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', round: 2, handoff: { done: true, reason: 'summoned-review-no-thread' },
    summonedDuringFix: 42,
  };
  const { next: reclassified } = reduce({
    ...base, prev: stuck, humanCommand: { type: 'retry', id: 1 },
    summonedReviewId: null, summonedDuringFixDismissed: false,
  });
  assert.equal(reclassified.summonedDuringFix, 42, 'must survive a reclassification — the review was never actually dismissed');

  const { next: dismissed } = reduce({
    ...base, prev: stuck, humanCommand: { type: 'retry', id: 1 },
    summonedReviewId: null, summonedDuringFixDismissed: true,
  });
  assert.equal(dismissed.summonedDuringFix, null, 'a genuinely confirmed dismissal still clears the latch');
});

test('/ai fix dispatches immediately with the instruction, uncapped', () => {
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', round: 9, handoff: { done: true, reason: 'round-limit' },
  };
  const { next, effects } = reduce({
    ...base, prev: stuck,
    humanCommand: { type: 'fix', instruction: 'apply the brand check' },
  });
  assert.equal(next.state, 'ai:fixing');
  assert.equal(next.round, 10, 'counted but not capped');
  const dispatch = effects.find((e) => e.type === 'dispatch-fixer');
  assert.equal(dispatch.instruction, 'apply the brand check');
  assert.ok(dispatch.humanInitiated);
});

test('/ai fix resets readyNotified — the human explicitly asked for another look', () => {
  const ready = { ...reduce({ ...base, prev: null }).next, state: 'ai:ready', readyNotified: true };
  const { next } = reduce({ ...base, prev: ready, humanCommand: { type: 'fix', id: 1 } });
  assert.equal(next.state, 'ai:fixing');
  assert.equal(next.readyNotified, false, 'a human-requested fix round must not have the prior episode\'s latch suppress the next ready ping');
});

test('/ai round-cap on a round-limit handoff raises the budget and resumes with the standing review, round unchanged', () => {
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', round: 2, handoff: { done: true, notified: true, reason: 'round-limit' },
  };
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }] };
  const { next, effects } = reduce({
    ...base, prev: stuck, codexResult, humanCommand: { type: 'round-cap', cap: 10, id: 1 },
  });
  assert.equal(next.cap, 10);
  assert.equal(next.effective_cap, 10);
  assert.equal(next.round, 3, 'the standing review dispatches a fresh round, not a reset');
  assert.equal(next.state, 'ai:fixing');
  assert.equal(next.handoff.reason, null);
  assert.ok(types(effects).includes('dispatch-fixer'));
});

test('/ai round-cap on an unrelated handoff reason stores the cap but does not resume', () => {
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', round: 1, handoff: { done: true, notified: true, reason: 'agents-disagree' },
  };
  const { next, effects } = reduce({ ...base, prev: stuck, humanCommand: { type: 'round-cap', cap: 10, id: 1 } });
  assert.equal(next.cap, 10);
  assert.equal(next.state, 'ai:needs-human', 'a genuine dispute is not silently resumed by a cap change');
  assert.equal(next.handoff.reason, 'agents-disagree');
  assert.deepEqual(types(effects), []);
});

test('/ai round-cap 0 sends the very next blocking review straight to a human', () => {
  const prev = reduce({ ...base, prev: null, humanCommand: { type: 'round-cap', cap: 0, id: 1 } }).next;
  const { next, effects } = reduce({
    ...base, prev, codexResult: { blocking: true, sha: 'sha1', findings: [{ id: 1 }] },
  });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'round-limit');
  assert.equal(next.round, 0, 'no round was dispatched');
  assert.ok(types(effects).includes('request-human-review'));
});

test('/ai round-cap survives /ai retry, a human push, and a new head', () => {
  const capped = reduce({ ...base, prev: null, humanCommand: { type: 'round-cap', cap: 7, id: 1 } }).next;
  assert.equal(capped.cap, 7);

  const retried = reduce({ ...base, prev: capped, humanCommand: { type: 'retry', id: 2 } }).next;
  assert.equal(retried.cap, 7, 'survives /ai retry');
  assert.equal(retried.round, 0, 'retry still resets the episode counter');

  const pushed = reduce({ ...base, prev: capped, pr: { ...pr, headSha: 'sha2' }, pushedByHuman: true }).next;
  assert.equal(pushed.cap, 7, 'survives a human push');

  const newHead = reduce({ ...base, prev: capped, pr: { ...pr, headSha: 'sha3' } }).next;
  assert.equal(newHead.cap, 7, 'survives a plain new head');

  // /ai refresh (#97) is a newer reset path than the three above — none of its resets
  // touch s.cap, and it must stay that way: the cap is a fact about the PR, not the
  // episode a reconciliation re-derives.
  const refreshed = reduce({ ...base, prev: capped, openThreads: [], humanCommand: { type: 'refresh', id: 2 } }).next;
  assert.equal(refreshed.cap, 7, 'survives /ai refresh');
});

test('/ai fix stays uncapped even with a low per-PR round-cap set', () => {
  const capped = { ...reduce({ ...base, prev: null }).next, cap: 1, round: 1 };
  const { next, effects } = reduce({ ...base, prev: capped, humanCommand: { type: 'fix', id: 1 } });
  assert.equal(next.state, 'ai:fixing');
  assert.equal(next.round, 2, 'human-initiated fixes ignore the cap entirely');
  assert.ok(effects.find((e) => e.type === 'dispatch-fixer')?.humanInitiated);
});

test('human REQUEST_CHANGES review is blocking evidence and bypasses the round cap', () => {
  const review = { id: 9, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'oleh' } };
  const inline = [{ id: 1, pull_request_review_id: 9, path: 'a.js', line: 3, body: 'fix this' }];
  const result = humanBlockingResult([review], inline, { humans: ['oleh'], headSha: 'sha1' });
  assert.equal(result.source, 'human');
  assert.equal(result.findings.length, 1);

  const atCap = { ...reduce({ ...base, prev: null }).next, round: policy.maxRounds };
  const { next } = reduce({ ...base, prev: atCap, codexResult: result });
  assert.equal(next.state, 'ai:fixing', 'human findings never hit round-limit');

  assert.equal(humanBlockingResult([{ ...review, state: 'APPROVED' }], [], { humans: ['oleh'], headSha: 'sha1' }),
    null, 'approvals do not drive the machine');
  assert.equal(humanBlockingResult([review], inline, { humans: ['oleh'], headSha: 'other' }),
    null, 'stale-SHA human review ignored');
  assert.equal(humanBlockingResult([{ ...review, user: { login: 'rando' } }], [], { humans: ['oleh'], headSha: 'sha1' }),
    null, 'non-listed users ignored');
  assert.equal(humanBlockingResult([review, { id: 10, state: 'DISMISSED', commit_id: 'sha1', user: { login: 'oleh' } }],
    [], { humans: ['oleh'], headSha: 'sha1' })?.blocking, true, 'a dismissed later review does not erase the standing one');
});

test('human REQUEST_CHANGES review dispatches a fix round even after ai:ready or while latched at ai:needs-human', () => {
  const review = { id: 9, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'oleh' } };
  const inline = [{ id: 1, pull_request_review_id: 9, path: 'a.js', line: 3, body: 'fix this' }];
  const result = humanBlockingResult([review], inline, { humans: ['oleh'], headSha: 'sha1' });

  const ready = { ...reduce({ ...base, prev: null }).next, state: 'ai:ready' };
  const fromReady = reduce({ ...base, prev: ready, codexResult: result });
  assert.equal(fromReady.next.state, 'ai:fixing', 'a review after ai:ready still dispatches');
  assert.ok(types(fromReady.effects).includes('dispatch-fixer'));

  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', round: 1, handoff: { done: true, reason: 'risk-requires-human' },
  };
  const fromNeedsHuman = reduce({ ...base, prev: stuck, codexResult: result });
  assert.equal(fromNeedsHuman.next.state, 'ai:fixing', 'a review while latched still dispatches');
  assert.equal(fromNeedsHuman.next.handoff.done, false, 'the latch is cleared, not left stale');

  // An agent (non-human) result must NOT get this treatment — it can only ever arrive
  // while queued/reviewing in the first place, so widening would be a no-op at best.
  const agentResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }] };
  const agentFromReady = reduce({ ...base, prev: ready, codexResult: agentResult });
  assert.notEqual(agentFromReady.next.state, 'ai:fixing', 'agent evidence outside queued/reviewing is ignored');
  assert.equal(agentFromReady.next.codex.result, null, 'the stored codex result is untouched');
});

test('a REQUEST_CHANGES review dispatched from ai:ready resets readyNotified', () => {
  const review = { id: 9, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'oleh' } };
  const result = humanBlockingResult([review], [], { humans: ['oleh'], headSha: 'sha1' });
  const ready = { ...reduce({ ...base, prev: null }).next, state: 'ai:ready', readyNotified: true };
  const { next } = reduce({ ...base, prev: ready, codexResult: result });
  assert.equal(next.state, 'ai:fixing');
  assert.equal(next.readyNotified, false,
    'the fixer\'s own push isn\'t a human push, so without this reset the corrected head reaching ready again would never re-ping');
});

test('humanBlockingResult surfaces the review summary body for a fixer fallback', () => {
  const review = { id: 9, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'oleh' }, body: 'please rename the export' };
  const result = humanBlockingResult([review], [], { humans: ['oleh'], headSha: 'sha1' });
  assert.equal(result.findings.length, 0, 'no inline comments on this review');
  assert.equal(result.body, 'please rename the export');
});

test('/ai fix replayed with the same comment id is a no-op the second time', () => {
  const start = reduce({ ...base, prev: null }).next;
  const first = reduce({ ...base, prev: start, humanCommand: { type: 'fix', instruction: 'do X', id: 42 } });
  assert.equal(first.next.round, 1);
  assert.ok(types(first.effects).includes('dispatch-fixer'));

  const replay = reduce({ ...base, prev: first.next, humanCommand: { type: 'fix', instruction: 'do X', id: 42 } });
  assert.equal(replay.next.round, 1, 'round is not incremented again');
  assert.deepEqual(types(replay.effects), [], 'no second dispatch-fixer effect');

  const second = reduce({ ...base, prev: replay.next, humanCommand: { type: 'fix', instruction: 'do Y', id: 43 } });
  assert.equal(second.next.round, 2, 'a genuinely new command id still dispatches');
});

test('a standing human review dispatches a fix round once, not on every later orchestrator run', () => {
  const review = { id: 9, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'oleh' } };
  const inline = [{ id: 1, pull_request_review_id: 9, path: 'a.js', line: 3, body: 'fix this' }];
  const result = humanBlockingResult([review], inline, { humans: ['oleh'], headSha: 'sha1' });

  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', round: 1, handoff: { done: true, reason: 'fixer-failed' },
  };
  const first = reduce({ ...base, prev: stuck, codexResult: result });
  assert.equal(first.next.state, 'ai:fixing', 'the standing review dispatches once');

  // Simulate the fixer failing again, landing back at needs-human, then a later
  // orchestrator run (e.g. /ai status, a CI event) re-gathering the *same* review.
  const stuckAgain = { ...first.next, state: 'ai:needs-human', handoff: { done: true, reason: 'fixer-failed' } };
  const replay = reduce({ ...base, prev: stuckAgain, codexResult: result });
  assert.notEqual(replay.next.state, 'ai:fixing', 'the same review id must not re-dispatch');
  assert.deepEqual(types(replay.effects).filter((t) => t === 'dispatch-fixer'), []);

  // A genuinely new review (new id) from the human still dispatches.
  const newReview = { ...review, id: 11 };
  const newResult = humanBlockingResult([newReview], inline.map((c) => ({ ...c, pull_request_review_id: 11 })),
    { humans: ['oleh'], headSha: 'sha1' });
  const fresh = reduce({ ...base, prev: stuckAgain, codexResult: newResult });
  assert.equal(fresh.next.state, 'ai:fixing', 'a new review id still dispatches');
});

test('humanBlockingResult: one human\'s approval does not clear another\'s standing REQUEST_CHANGES', () => {
  const alice = { id: 1, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'alice' } };
  const bob = { id: 2, state: 'APPROVED', commit_id: 'sha1', user: { login: 'bob' } };
  const result = humanBlockingResult([alice, bob], [], { humans: ['alice', 'bob'], headSha: 'sha1' });
  assert.equal(result?.blocking, true, 'alice\'s standing REQUEST_CHANGES still blocks');
  assert.equal(result.reviewId, 1);
});

test('humanBlockingResult: a later COMMENT-only review does not clear a standing REQUEST_CHANGES', () => {
  // Matches real GitHub behavior: a comment-only review never resolves an outstanding
  // change request — only an approval or an explicit dismissal does.
  const requested = { id: 1, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'oleh' } };
  const laterComment = { id: 2, state: 'COMMENTED', commit_id: 'sha1', user: { login: 'oleh' } };
  const result = humanBlockingResult([requested, laterComment], [], { humans: ['oleh'], headSha: 'sha1' });
  assert.equal(result?.blocking, true, 'the standing change request is still in effect');
});

test('humanBlockingResult: A→B→A interleaved reviews pick A\'s later review as latest, not Map insertion order (#220)', () => {
  const a1 = { id: 100, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'alice' } };
  const b1 = { id: 101, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'bob' } };
  const a2 = { id: 102, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'alice' } };
  const result = humanBlockingResult([a1, b1, a2], [], { humans: ['alice', 'bob'], headSha: 'sha1' });
  assert.equal(result.reviewId, 102, 'alice\'s later review, not bob\'s, is the actual latest submission');
});

test('humanBlockingResult: multiple listed humans\' summary-only requests are all forwarded', () => {
  const alice = { id: 1, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'alice' }, body: 'rename the export' };
  const bob = { id: 2, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'bob' }, body: 'fix the typo' };
  const result = humanBlockingResult([alice, bob], [], { humans: ['alice', 'bob'], headSha: 'sha1' });
  assert.match(result.body, /rename the export/);
  assert.match(result.body, /fix the typo/);
});

test('/ai retry ignores a stale clean result (forces a fresh review) but still trusts standing blocking evidence', () => {
  const ready = { ...reduce({ ...base, prev: null }).next, state: 'ai:ready', codex: { requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'clean' } };
  const cleanResult = { blocking: false, sha: 'sha1' };
  const { next, effects } = reduce({ ...base, prev: ready, codexResult: cleanResult, humanCommand: { type: 'retry', id: 1 } });
  assert.notEqual(next.state, 'ai:ready', 'stale clean evidence must not instantly re-promote to ready');
  assert.ok(types(effects).includes('request-codex'), 'a fresh review is requested instead');
});

test('/ai retry: a later CI/status event re-deriving the same stale review must not restore reviewed_sha', () => {
  // Regression for the deadlock that survives the same-event skip above: `skipStaleCleanOnRetry`
  // only protects the retry's own reduce() call. A *subsequent* event (CI check, another
  // cron tick, `/ai status`) that re-gathers the exact same still-standing GitHub review
  // before the local reviewer ever posts a fresh one must keep excluding it too, or it
  // silently re-populates codex.reviewed_sha and defeats the retry.
  const ready = { ...reduce({ ...base, prev: null }).next, state: 'ai:ready', codex: { requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'clean' } };
  const staleClean = { blocking: false, sha: 'sha1', id: 50 };
  const retried = reduce({ ...base, prev: ready, codexResult: staleClean, humanCommand: { type: 'retry', id: 1 } }).next;
  assert.equal(retried.codex.review_floor, 50, 'the standing review at retry time becomes the stale-evidence floor');

  // A later event, no humanCommand this time — the same stale review is still all GitHub
  // has to offer (local reviewer hasn't run yet).
  const laterEvent = reduce({ ...base, prev: retried, codexResult: staleClean, humanCommand: null });
  assert.equal(laterEvent.next.codex.reviewed_sha, null, 'stale evidence must not restore reviewed_sha');
  assert.notEqual(laterEvent.next.state, 'ai:ready', 'must not silently resolve back to ready off stale evidence');

  // Once the local reviewer posts an actually fresh review (a higher id) for the same
  // head, it must be consumed normally — the floor only blocks evidence at or below it.
  const freshClean = { blocking: false, sha: 'sha1', id: 51 };
  const fresh = reduce({ ...base, prev: retried, codexResult: freshClean, humanCommand: null });
  assert.equal(fresh.next.codex.reviewed_sha, 'sha1', 'a genuinely new review above the floor is still consumed');
});

test('/ai retry starting a fresh episode resets readyNotified — the retried episode can re-ping', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const ready = reduce({ ...base, prev, codexResult, ci: 'success' }).next;
  assert.equal(ready.readyNotified, true);

  const retried = reduce({ ...base, prev: ready, humanCommand: { type: 'retry', id: 1 } }).next;
  assert.equal(retried.readyNotified, false, 'a retried episode must not inherit the prior episode\'s ready latch');

  const freshClean = { blocking: false, sha: 'sha1', id: 2, findings: [] };
  const { next, effects } = reduce({ ...base, prev: retried, codexResult: freshClean, ci: 'success' });
  assert.equal(next.state, 'ai:ready');
  assert.ok(types(effects).includes('notify'), 'the retried episode re-pings once it reaches ready again');
});

test('/ai retry resets the CI snapshot so a still-red head is re-counted', () => {
  // Same head SHA throughout (retry does not push) — before the fix, `s.ci.sha` stayed
  // equal to `pr.headSha`, so the still-red CI was never re-counted after a retry.
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', round: 1, handoff: { done: true, reason: 'ci-failing' },
    ci: { sha: 'sha1', conclusion: 'failure', consecutive_failures: 3 },
  };
  const { next } = reduce({ ...base, prev: stuck, ci: 'failure', humanCommand: { type: 'retry', id: 1 } });
  assert.equal(next.ci.consecutive_failures, 1, 'the still-failing head is counted again, not silently skipped');
});

test('/ai retry ignores a stale local-reviewer escalation and re-latches a fresh review request', () => {
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', round: 0, handoff: { done: true, reason: 'local-reviewer-escalation' },
  };
  const escalation = { blocking: true, escalate: true, sha: 'sha1', findings: [] };
  const { next, effects } = reduce({ ...base, prev: stuck, codexResult: escalation, humanCommand: { type: 'retry', id: 1 } });
  assert.notEqual(next.state, 'ai:needs-human', 'retry must not immediately re-escalate on the same stale result');
  assert.ok(types(effects).includes('request-codex'), 'a fresh review is requested instead');
});

test('/ai fix in dry-run only narrates: no durable ai:fixing latch, command stays unconsumed', () => {
  const dryPolicy = parsePolicy(`
version: 1
mode: dry-run
authors: ["normandy-tali[bot]"]
humans: [oleh]
backends: { reviewer: [local-agent], fixer: [claude-code-action] }
reviewers: { actors: ["normandy-garrus[bot]", "normandy-tali[bot]"] }
`);
  const dryBase = { ...base, policy: dryPolicy };
  const start = reduce({ ...dryBase, prev: null }).next;
  const { next, effects } = reduce({ ...dryBase, prev: start, humanCommand: { type: 'fix', instruction: 'do X', id: 42 } });
  assert.notEqual(next.state, 'ai:fixing', 'dry-run must not latch a state no fixer job will ever clear');
  assert.deepEqual(next.command_ids, [], 'the command is not marked processed, so activation still dispatches it');
  assert.ok(types(effects).includes('dispatch-fixer'), 'still narrated for the dry-run note');

  // Switching to active and replaying the same event now really dispatches.
  const activated = reduce({ ...base, prev: next, humanCommand: { type: 'fix', instruction: 'do X', id: 42 } });
  assert.equal(activated.next.state, 'ai:fixing');
  assert.deepEqual(activated.next.command_ids, [42]);
});

test('isCodexDismissal: bot dismissals always count; human dismissals only when the recorded result was blocking', () => {
  const opts = { policy, headSha: 'sha1', prAuthor: 'normandy-tali[bot]' };
  const botReview = { user: { login: 'normandy-garrus[bot]' }, commit_id: 'sha1' };
  assert.equal(isCodexDismissal(botReview, { ...opts, recordedResult: 'clean' }), true,
    'a dismissed bot review always revokes, clean or blocking');

  const humanApproval = { user: { login: 'oleh' }, commit_id: 'sha1' };
  assert.equal(isCodexDismissal(humanApproval, { ...opts, recordedResult: 'clean' }), false,
    'dismissing a human approval must not wipe an unrelated clean bot result');
  assert.equal(isCodexDismissal(humanApproval, { ...opts, recordedResult: 'blocking' }), true,
    'dismissing the human review that itself produced the blocking result does revoke it');

  assert.equal(isCodexDismissal(botReview, { ...opts, headSha: 'other' }), false, 'stale-head dismissal ignored');
  assert.equal(isCodexDismissal({ user: { login: 'normandy-tali[bot]' }, commit_id: 'sha1' }, { ...opts, recordedResult: 'clean' }),
    false, 'self-review dismissal ignored');
});

test('latestSummonedReviewId: a summoned connector review with a root finding on the current head', () => {
  const opts = { prAuthor: 'normandy-tali[bot]', headSha: 'sha1' };
  const review = { id: 42, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'CHANGES_REQUESTED', commit_id: 'sha1' };
  const inline = [{ id: 1, pull_request_review_id: 42, path: 'a.js', line: 1, in_reply_to_id: null, body: 'P1' }];
  assert.equal(latestSummonedReviewId([review], inline, policy, opts), 42);
});

test('latestSummonedReviewId: a clean summoned review (no findings, not CHANGES_REQUESTED) is not a trigger', () => {
  const opts = { prAuthor: 'normandy-tali[bot]', headSha: 'sha1' };
  const review = { id: 42, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'COMMENTED', commit_id: 'sha1' };
  assert.equal(latestSummonedReviewId([review], [], policy, opts), null,
    'a summoned reviewer\'s silence must never trigger anything — see docs/adr/0007');
});

test('latestSummonedReviewId: a fix round\'s own thread replies never look like a fresh summoned review — the loop guard', () => {
  const opts = { prAuthor: 'normandy-tali[bot]', headSha: 'sha1' };
  // The auto-created review GitHub attaches claude[bot]'s reply-only comments to: not
  // CHANGES_REQUESTED, and its only inline comment is a REPLY (in_reply_to_id set) —
  // claude-fix-prompt.md never has the fixer post a root review comment.
  const autoReview = { id: 43, user: { login: 'claude[bot]' }, state: 'COMMENTED', commit_id: 'sha1' };
  const inline = [{ id: 2, pull_request_review_id: 43, path: 'a.js', line: 1, in_reply_to_id: 1, body: 'fixed' }];
  assert.equal(latestSummonedReviewId([autoReview], inline, policy, opts), null);
});

test('inspectReview: a COMMENTED auto-review with only a reply comment is not relevant at all (#123) — the case the loop guard relies on, now stronger than not-blocking', () => {
  const opts = { actors: ['claude[bot]'], localReviewActors: [], headSha: 'sha1' };
  const commentedAutoReview = { id: 43, user: { login: 'claude[bot]' }, state: 'COMMENTED', commit_id: 'sha1' };
  const replyOnly = [{ id: 2, pull_request_review_id: 43, path: 'a.js', line: 1, in_reply_to_id: 1, body: 'fixed' }];
  // Before #123 this only asserted `.blocking === false` — true, but insufficient: a
  // non-blocking `relevant: true` result still shadows an earlier real review as "newest
  // relevant" (#123, live on PR #119/#122). The wrapper guard now drops it at `relevant`
  // itself, which is what actually closes that shadowing.
  assert.equal(inspectReview(commentedAutoReview, replyOnly, opts).relevant, false);

  // Hypothetical only — claude-fix-prompt.md's reply endpoint never actually produces a
  // CHANGES_REQUESTED-state review — but if it ever did, the wrapper guard would NOT
  // suppress it, since it only fires on `review.state === 'COMMENTED'`. This test exists
  // to fail loudly if that assumption is ever wrong, per docs/adr/0007's low-severity note.
  const hypotheticalChangesRequested = { ...commentedAutoReview, state: 'CHANGES_REQUESTED' };
  assert.equal(inspectReview(hypotheticalChangesRequested, replyOnly, opts).blocking, true);
});

test('latestSummonedReviewId: a still-open blocking summoned review is not shadowed by the fixer\'s own later non-blocking auto-review', () => {
  const opts = { prAuthor: 'normandy-tali[bot]', headSha: 'sha1' };
  const connectorReview = { id: 42, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'CHANGES_REQUESTED', commit_id: 'sha1' };
  const connectorFinding = [{ id: 1, pull_request_review_id: 42, path: 'a.js', line: 1, in_reply_to_id: null, body: 'P1' }];
  // A later (higher id), non-blocking auto-review under claude[bot] — e.g. from an
  // unrelated fix round that ran after the connector's review, on the SAME head.
  const fixerAutoReview = { id: 50, user: { login: 'claude[bot]' }, state: 'COMMENTED', commit_id: 'sha1' };
  const fixerReply = [{ id: 2, pull_request_review_id: 50, path: 'b.js', line: 1, in_reply_to_id: 99, body: 'unrelated fix' }];
  const result = latestSummonedReviewId(
    [connectorReview, fixerAutoReview], [...connectorFinding, ...fixerReply], policy, opts,
  );
  assert.equal(result, 42, 'the connector\'s still-open finding must win — "newest relevant" is not the same as "newest blocking"');
});

test('latestSummonedReviewId: two independent standing summoned reviews — the OLDER one wins, not the newer', () => {
  // #105 finding: picking the newest blocking summoned review let releasing a NEWER
  // review (e.g. its own thread resolving, bumping state.js's single `summoned_floor`)
  // silently drop an OLDER, still-unaddressed body-only review too, since the state
  // machine only ever tracks one summonedReviewId at a time. Tracking the oldest instead
  // keeps the PR pinned on it until it is actually released (push or dismissal), and only
  // then does the next-oldest take over.
  const opts = { prAuthor: 'normandy-tali[bot]', headSha: 'sha1' };
  const olderBodyOnly = { id: 42, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'CHANGES_REQUESTED', commit_id: 'sha1' };
  const newerThreaded = { id: 50, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'CHANGES_REQUESTED', commit_id: 'sha1' };
  const newerFinding = [{ id: 1, pull_request_review_id: 50, path: 'a.js', line: 1, in_reply_to_id: null, body: 'P1' }];
  assert.equal(latestSummonedReviewId([olderBodyOnly, newerThreaded], newerFinding, policy, opts), 42);

  // Once the older one is explicitly dismissed, the newer one takes over.
  const olderDismissed = { ...olderBodyOnly, state: 'DISMISSED' };
  assert.equal(latestSummonedReviewId([olderDismissed, newerThreaded], newerFinding, policy, opts), 50);
});

test('latestSummonedReviewId: summonedFloor lets the next-oldest take over once the oldest is released without a push or dismissal', () => {
  // #105 round-2 finding: an older THREADED summoned review is released via state.js's
  // no-push `summoned_floor` catching up to its id (its GraphQL thread resolved) —
  // that never touches `review.state` or the REST inline comments, so without
  // `summonedFloor` this candidate list would keep returning it forever, starving out
  // a later, still-unaddressed body-only summoned review that never gets a chance to
  // become `candidates[0]`.
  const opts = { prAuthor: 'normandy-tali[bot]', headSha: 'sha1' };
  const olderThreaded = { id: 42, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'CHANGES_REQUESTED', commit_id: 'sha1' };
  const olderFinding = [{ id: 1, pull_request_review_id: 42, path: 'a.js', line: 1, in_reply_to_id: null, body: 'P1' }];
  const newerBodyOnly = { id: 50, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'CHANGES_REQUESTED', commit_id: 'sha1' };
  const reviews = [olderThreaded, newerBodyOnly];

  // Before release: the older threaded review still wins, same as the no-floor case.
  assert.equal(latestSummonedReviewId(reviews, olderFinding, policy, opts), 42);

  // state.js recorded review 42 as released (`summoned_floor` caught up to its id) —
  // it must drop out of consideration so the newer body-only review surfaces.
  assert.equal(latestSummonedReviewId(reviews, olderFinding, policy, { ...opts, summonedFloor: 42 }), 50);
});

test('latestSummonedReviewId: a summoned review anchored to a superseded commit does not fire after the head moves — re-fire guard mechanism 2', () => {
  const opts = { prAuthor: 'normandy-tali[bot]', headSha: 'sha2' }; // head has since moved
  const review = { id: 42, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'CHANGES_REQUESTED', commit_id: 'sha1' };
  const inline = [{ id: 1, pull_request_review_id: 42, path: 'a.js', line: 1, in_reply_to_id: null, body: 'P1' }];
  assert.equal(latestSummonedReviewId([review], inline, policy, opts), null);
});

test('latestSummonedReviewHasThread: true for a threaded summoned review, false for a body-only one', () => {
  // #105 round-2 finding: state.js's no-push `summoned_floor` release path must be able
  // to tell a summoned review that opened an inline thread apart from a summary-only
  // `CHANGES_REQUESTED` review with no inline comments — the latter can never be
  // confirmed resolved via `openThreads`, since it never opened a thread to begin with.
  const opts = { prAuthor: 'normandy-tali[bot]', headSha: 'sha1' };
  const threadedReview = { id: 42, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'CHANGES_REQUESTED', commit_id: 'sha1' };
  const inline = [{ id: 1, pull_request_review_id: 42, path: 'a.js', line: 1, in_reply_to_id: null, body: 'P1' }];
  assert.equal(latestSummonedReviewHasThread([threadedReview], inline, policy, opts), true);

  const bodyOnlyReview = { id: 43, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'CHANGES_REQUESTED', commit_id: 'sha1' };
  assert.equal(latestSummonedReviewHasThread([bodyOnlyReview], [], policy, opts), false);
});

test('allSummonedReviewsDismissed: a lone standing review reports true once dismissed, false while still standing', () => {
  const opts = { prAuthor: 'normandy-tali[bot]', headSha: 'sha1' };
  const review = { id: 42, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'CHANGES_REQUESTED', commit_id: 'sha1' };
  assert.equal(allSummonedReviewsDismissed([review], [], policy, opts), false);

  const dismissed = { ...review, state: 'DISMISSED' };
  assert.equal(allSummonedReviewsDismissed([dismissed], [], policy, opts), true);
});

test('allSummonedReviewsDismissed: P1 finding on #119 — a newer body-only review hidden behind the dismissed oldest one is not swallowed', () => {
  // `summonedDuringFix` only remembers the OLDEST standing review's id (`latestSummonedReviewId`),
  // so checking just that one id's dismissal state (the round-2 fix) is unsound when a
  // newer body-only review is standing alongside it: dismissing only the older one must not
  // read as releasing the latch while the newer one is still outstanding.
  const opts = { prAuthor: 'normandy-tali[bot]', headSha: 'sha1' };
  const olderBodyOnly = { id: 42, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'DISMISSED', commit_id: 'sha1' };
  const newerBodyOnly = { id: 50, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'CHANGES_REQUESTED', commit_id: 'sha1' };
  assert.equal(allSummonedReviewsDismissed([olderBodyOnly, newerBodyOnly], [], policy, opts), false,
    'the newer, un-dismissed review is still standing');

  const newerDismissedToo = { ...newerBodyOnly, state: 'DISMISSED' };
  assert.equal(allSummonedReviewsDismissed([olderBodyOnly, newerDismissedToo], [], policy, opts), true,
    'both dismissed — genuinely fully released');
});

test('allSummonedReviewsDismissed: P1 finding on #119 round 2 — a base-branch policy edit must not let the latched review silently vanish from candidates', () => {
  // `summonedReviewCandidates` classifies candidates via `reviewerRoleAgents`/
  // `recognizedReviewActors`, both derived from the CURRENT policy (reloaded from the base
  // branch every run). If a maintainer edits reviewers.codex_actor/vendors between the round
  // that latched this review and this one, the latched review's author can stop being a
  // summoned actor and drop out of `candidates` for a reason unrelated to dismissal.
  const mutatedPolicy = parsePolicy(`
version: 1
mode: active
authors: ["normandy-tali[bot]"]
humans: [oleh]
backends: { reviewer: [local-agent], fixer: [claude-code-action] }
reviewers:
  actors: ["normandy-garrus[bot]", "normandy-tali[bot]"]
  codex_actor: other-actor[bot]
  vendors: { claude: ["normandy-tali[bot]", "claude[bot]"], codex: ["normandy-garrus[bot]"] }
`);
  const opts = { prAuthor: 'normandy-tali[bot]', headSha: 'sha1', latchedIds: [42] };
  const standing = { id: 42, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'CHANGES_REQUESTED', commit_id: 'sha1' };
  assert.equal(allSummonedReviewsDismissed([standing], [], mutatedPolicy, opts), false,
    'the latched review is still standing and un-dismissed, regardless of what the current policy classifies');

  const dismissed = { ...standing, state: 'DISMISSED' };
  assert.equal(allSummonedReviewsDismissed([dismissed], [], mutatedPolicy, opts), true,
    'the latched review is explicitly dismissed — genuinely released');
});

test('allSummonedReviewsDismissed: P1 finding on #119 round 3 — a policy edit must not hide an undismissed SECOND latched review either', () => {
  // Round 2's fix checked only the single remembered `latchedId` directly, bypassing policy
  // classification for THAT id — but `summonedDuringFix` can latch two distinct reviews (the
  // oldest standing one, plus a newer body-only one hiding behind it). If only the oldest is
  // dismissed and a base-branch policy edit reclassifies the newer review's author out of
  // `summonedReviewCandidates`, the old fallback (`summonedReviewCandidates(...).length === 0`)
  // would read as fully released even though the newer review was never dismissed or
  // addressed. Passing every latched id lets each be checked directly, independent of policy.
  const mutatedPolicy = parsePolicy(`
version: 1
mode: active
authors: ["normandy-tali[bot]"]
humans: [oleh]
backends: { reviewer: [local-agent], fixer: [claude-code-action] }
reviewers:
  actors: ["normandy-garrus[bot]", "normandy-tali[bot]"]
  codex_actor: other-actor[bot]
  vendors: { claude: ["normandy-tali[bot]", "claude[bot]"], codex: ["normandy-garrus[bot]"] }
`);
  const opts = { prAuthor: 'normandy-tali[bot]', headSha: 'sha1', latchedIds: [42, 50] };
  const olderDismissed = { id: 42, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'DISMISSED', commit_id: 'sha1' };
  const newerStanding = { id: 50, user: { login: 'chatgpt-codex-connector[bot]' }, state: 'CHANGES_REQUESTED', commit_id: 'sha1' };
  assert.equal(allSummonedReviewsDismissed([olderDismissed, newerStanding], [], mutatedPolicy, opts), false,
    'the newer review is still standing and un-dismissed, regardless of what the current policy classifies it as');

  const newerDismissedToo = { ...newerStanding, state: 'DISMISSED' };
  assert.equal(allSummonedReviewsDismissed([olderDismissed, newerDismissedToo], [], mutatedPolicy, opts), true,
    'both latched reviews are explicitly dismissed — genuinely released');
});

test('fetchReviewThreads follows the GraphQL cursor across pages', async () => {
  const pages = [
    { nodes: [{ isResolved: false, path: 'a.js', comments: { nodes: [] } }], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
    { nodes: [{ isResolved: true, path: 'b.js', comments: { nodes: [] } }], pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  let calls = 0;
  const gh = { graphql: async (_q, vars) => {
    assert.equal(vars.after, calls === 0 ? null : 'c1');
    return { repository: { pullRequest: { reviewThreads: pages[calls++] } } };
  } };
  const threads = await fetchReviewThreads(gh, 'o/r', 1);
  assert.equal(calls, 2, 'both pages fetched');
  assert.deepEqual(threads.map((t) => t.path), ['a.js', 'b.js']);
});

test('fetchReviewThreads normalizes GraphQL Bot-actor logins to the REST "[bot]" convention', () => {
  // Confirmed live: GitHub's GraphQL Actor union drops the
  // "[bot]" suffix — `{ login: "normandy-garrus", __typename: "Bot" }`, not
  // "normandy-garrus[bot]". Every downstream comparison (ownThreadsOf,
  // isHumanAdjudicated, qualifyUnresolvedThreads' reviewerActors voice) checks against
  // the REST-style suffixed login used everywhere else (policy.yml, inspect-review.js),
  // so an unnormalized author here silently turns the dedup gate into a no-op — exactly
  // what happened in production despite 137 passing tests, because every prior test used
  // hand-typed literals that already matched policy instead of the real GraphQL shape.
  const page = {
    nodes: [{
      id: 't1', isResolved: true, path: 'agents.py', line: 59,
      resolvedBy: { login: 'claude', __typename: 'Bot' },
      comments: {
        nodes: [
          { databaseId: 1, author: { login: 'normandy-garrus', __typename: 'Bot' }, body: 'finding' },
          { databaseId: 2, author: { login: 'noneedinmagic', __typename: 'User' }, body: 'agreed' },
        ],
      },
    }],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  const gh = { graphql: async () => ({ repository: { pullRequest: { reviewThreads: page } } }) };
  return fetchReviewThreads(gh, 'o/r', 1).then((threads) => {
    assert.equal(threads[0].resolvedBy, 'claude[bot]', 'bot resolvedBy gets the REST suffix appended');
    assert.equal(threads[0].comments[0].author, 'normandy-garrus[bot]', 'bot comment author gets the suffix appended');
    assert.equal(threads[0].comments[1].author, 'noneedinmagic', 'human (User) login is left unchanged');
  });
});

test('qualifyUnresolvedThreads: only unresolved threads with human/reviewer voices', () => {
  const threads = [
    { isResolved: false, path: 'a.js', comments: [{ author: 'normandy-garrus[bot]', body: 'P1 x' }, { author: 'oleh', body: 'agreed' }] },
    { isResolved: true, path: 'b.js', comments: [{ author: 'oleh', body: 'done' }] },
    // A summoned `@codex review`'s own thread — ORIGINATED by the connector, unanswered.
    // #58/#103: must qualify even though the connector never submitted a review this
    // policy's backends.reviewer recognizes as fresh evidence — its finding must still
    // block a clean verdict.
    { isResolved: false, path: 'c.js', comments: [{ author: 'chatgpt-codex-connector[bot]', body: 'old cloud finding' }] },
    { isResolved: false, path: 'd.js', comments: [{ author: 'normandy-tali[bot]', body: 'note' }] },
  ];
  const q = qualifyUnresolvedThreads(threads, policy);
  assert.deepEqual(q.map((t) => t.path), ['a.js', 'c.js', 'd.js'],
    'only the resolved thread is excluded — a summoned-reviewer-originated thread now qualifies too (#58)');
});

test('qualifyUnresolvedThreads: origination vs participation for the dual-role claude[bot] login', () => {
  const threads = [
    // ORIGINATED by claude[bot] (a summoned `@claude review`), no other comment yet —
    // qualifies via origination, not participation (claude[bot] is deliberately never in
    // the participation "voices" set).
    { isResolved: false, path: 'a.js', comments: [{ author: 'claude[bot]', body: 'finding' }] },
    // Opened by garrus (a reviewer voice — qualifies via participation regardless), with
    // claude[bot]'s FIXER reply as the only other comment. The thread still qualifies,
    // but because of garrus's participation, not because claude[bot] replied.
    { isResolved: false, path: 'b.js', comments: [{ author: 'normandy-garrus[bot]', body: 'finding' }, { author: 'claude[bot]', body: 'fixed' }] },
    // Opened by an unrecognized stranger, with only a claude[bot] reply — must NOT
    // qualify. A fixer reply alone, on a thread neither a human nor a reviewer voice
    // opened or joined, is not reviewer conversation.
    { isResolved: false, path: 'c.js', comments: [{ author: 'stranger[bot]', body: 'chatter' }, { author: 'claude[bot]', body: 'reply' }] },
  ];
  const q = qualifyUnresolvedThreads(threads, policy);
  assert.deepEqual(q.map((t) => t.path), ['a.js', 'b.js']);
});

// --- /ai refresh (issue #97): reconciliation, not a labels-only operation ---

test('/ai refresh from ai:fixing with no open threads re-queues, dispatches nothing', () => {
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:fixing', round: 1,
    codex: { requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'blocking', human_review_id: null, review_floor: 0 },
  };
  const staleBlocking = { blocking: true, sha: 'sha1', id: 7, findings: [{ id: 1 }] };
  const { next, effects } = reduce({ ...base, prev: stuck, codexResult: staleBlocking, openThreads: [], humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(next.state, 'ai:reviewing', 're-queued and immediately re-latched a fresh review request');
  assert.equal(next.codex.review_floor, 7, 'the discarded standing review becomes the stale-evidence floor');
  assert.equal(next.round, 1, 'round counter is untouched — that stays /ai retry\'s job');
  assert.deepEqual(types(effects).filter((t) => t === 'dispatch-fixer'), [], 'reconciliation never dispatches a fixer round');
  assert.ok(types(effects).includes('request-codex'));
  const report = effects.find((e) => e.type === 'refresh-report');
  assert.equal(report.outcome, 're-queued');
  assert.equal(report.wasFixing, true, 'flagged — a still-running fixer\'s later report would land on a state that already moved on');
});

test('/ai refresh re-queuing from a non-fixing state does not raise the in-flight-fixer warning', () => {
  const stuck = { ...reduce({ ...base, prev: null }).next, state: 'ai:reviewing' };
  const { effects } = reduce({ ...base, prev: stuck, openThreads: [], humanCommand: { type: 'refresh', id: 1 } });
  const report = effects.find((e) => e.type === 'refresh-report');
  assert.equal(report.wasFixing, false);
});

test('/ai refresh with an open blocking thread declines: no state change, reports the thread', () => {
  const stuck = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const openThreads = [{ id: 't1', path: 'scripts/lib/state.js', line: 277 }];
  const { next, effects } = reduce({ ...base, prev: stuck, openThreads, humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(next.state, 'ai:fixing', 'blocking conversation is not over — nothing to reconcile');
  assert.deepEqual(next.command_ids, [1], 'a confirmed decline is still marked processed');
  assert.deepEqual(types(effects), ['refresh-report']);
  const report = effects.find((e) => e.type === 'refresh-report');
  assert.equal(report.outcome, 'threads-open');
  assert.deepEqual(report.threads, openThreads);
});

test('/ai refresh with unconfirmed thread state declines loudly and stays retryable', () => {
  const stuck = { ...reduce({ ...base, prev: null }).next, state: 'ai:reviewing' };
  const { next, effects } = reduce({ ...base, prev: stuck, openThreads: null, humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(next.state, 'ai:reviewing', 'an unknown thread state must never read as agreement');
  assert.deepEqual(next.command_ids, [], 'not marked processed — a re-run of the same event can retry it');
  const report = effects.find((e) => e.type === 'refresh-report');
  assert.equal(report.outcome, 'unconfirmed');
});

test('/ai refresh on an already-ready PR with nothing actually open: nothing to reconcile, no demote', () => {
  const ready = { ...reduce({ ...base, prev: null }).next, state: 'ai:ready', readyNotified: true };
  // ci: 'success' — a pending/failing CI has its own (unrelated) demotion logic below in
  // reduce(); this test isolates refresh's own guard, not that pre-existing behavior.
  const { next, effects } = reduce({ ...base, prev: ready, ci: 'success', openThreads: [], humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(next.state, 'ai:ready');
  const report = effects.find((e) => e.type === 'refresh-report');
  assert.equal(report.outcome, 'nothing-to-reconcile');
});

test('#123: /ai refresh on ai:ready DOES demote when a qualifying thread is still open — the recorded verdict was stale', () => {
  const ready = {
    ...reduce({ ...base, prev: null }).next, state: 'ai:ready', readyNotified: true,
    codex: { requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'clean', human_review_id: null, review_floor: 0, summoned_floor: 0 },
  };
  const openThreads = [{ id: 't1', path: 'scripts/orchestrate.js', line: 230, isResolved: false }];
  const { next, effects } = reduce({ ...base, prev: ready, ci: 'success', openThreads, humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(next.state, 'ai:reviewing', 'demoted, then immediately re-latched to reviewing by the shared ai:queued fall-through in the same call');
  assert.equal(next.readyNotified, false, 'a later re-promotion must send a fresh ready ping, not replay the stale one');
  assert.equal(next.codex.result, null);
  assert.deepEqual(types(effects), ['refresh-report', 'request-codex'], 'no dispatch-fixer — refresh never dispatches a fix round, only re-queues for a fresh review');
  const report = effects.find((e) => e.type === 'refresh-report');
  assert.equal(report.outcome, 'threads-open-demoted');
  assert.deepEqual(report.threads, openThreads);
});

test('#123: the ai:ready demote does not fall through and re-promote to ai:ready in the same call', () => {
  // Mirrors the existing 'declining for open threads does not fall through' tests below,
  // for the new branch: even though the reset clears s.codex.result to null (so nothing
  // stale can promote), confirm the call actually lands on ai:reviewing, not back on ready.
  const ready = {
    ...reduce({ ...base, prev: null }).next, state: 'ai:ready', readyNotified: true,
    codex: { requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'clean', human_review_id: null, review_floor: 0, summoned_floor: 0 },
  };
  const openThreads = [{ id: 't1', path: 'a.js', line: 1, isResolved: false }];
  const { next } = reduce({ ...base, prev: ready, ci: 'success', openThreads, humanCommand: { type: 'refresh', id: 1 } });
  assert.notEqual(next.state, 'ai:ready');
});

test('#123: an unconfirmed thread fetch on ai:ready declines loudly instead of trusting the stale clean verdict', () => {
  const ready = { ...reduce({ ...base, prev: null }).next, state: 'ai:ready', readyNotified: true };
  const { next, effects } = reduce({ ...base, prev: ready, ci: 'success', openThreads: null, humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(next.state, 'ai:ready', 'state unchanged while unconfirmed');
  const report = effects.find((e) => e.type === 'refresh-report');
  assert.equal(report.outcome, 'unconfirmed');
  assert.equal(next.command_ids.includes(1), false, 'left unmarked so a manual re-run can retry it, same as every other unconfirmed case');
});

test('/ai refresh on an already-ready PR does not let a standing human review dispatch a fixer in the same call', () => {
  // Regression: the ai:ready early-exit reported "nothing-to-reconcile" but left the
  // codexResult-consuming block free to fire right after, dispatching a fix round the
  // reply never mentioned — exactly what refreshedThisEvent exists to prevent (see
  // ADR-0006 and the /ai refresh re-queue tests above).
  const review = { id: 9, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'oleh' } };
  const result = humanBlockingResult([review], [], { humans: ['oleh'], headSha: 'sha1' });
  const ready = { ...reduce({ ...base, prev: null }).next, state: 'ai:ready', readyNotified: true };
  const { next, effects } = reduce({ ...base, prev: ready, ci: 'success', codexResult: result, openThreads: [], humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(next.state, 'ai:ready', 'reconciliation never dispatches a fixer round, even by consuming a standing review in the same call');
  assert.deepEqual(types(effects).filter((t) => t === 'dispatch-fixer'), []);
  const report = effects.find((e) => e.type === 'refresh-report');
  assert.equal(report.outcome, 'nothing-to-reconcile');
});

test('/ai refresh from ai:queued is NOT guarded — a floor-suppressed verdict is still reconcilable', () => {
  // Only ai:ready is guarded (see state.js): a PR resting in ai:queued with a stale
  // requested_sha is exactly the "genuinely stuck" case reconciliation exists for.
  const queued = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:queued',
    codex: { requested_sha: 'sha1', reviewed_sha: null, result: null, human_review_id: null, review_floor: 5 },
  };
  const { next, effects } = reduce({ ...base, prev: queued, openThreads: [], humanCommand: { type: 'refresh', id: 1 } });
  const report = effects.find((e) => e.type === 'refresh-report');
  assert.equal(report.outcome, 're-queued', 'ai:queued proceeds to reconcile, unlike ai:ready');
  assert.equal(next.state, 'ai:reviewing', 'the stale request is cleared and immediately re-latched');
});

test('/ai refresh from ai:needs-human with threads resolved clears the handoff latch', () => {
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', round: 1, handoff: { done: true, notified: true, reason: 'agents-disagree' },
  };
  const { next } = reduce({ ...base, prev: stuck, openThreads: [], humanCommand: { type: 'refresh', id: 1 } });
  assert.notEqual(next.state, 'ai:needs-human');
  assert.equal(next.handoff.done, false);
  assert.equal(next.handoff.reason, null);
});

test('/ai refresh declines while a ci-failing handoff is still red: no state change, reports why', () => {
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', round: 1, handoff: { done: true, notified: true, reason: 'ci-failing' },
  };
  const { next, effects } = reduce({ ...base, prev: stuck, ci: 'failure', openThreads: [], humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(next.state, 'ai:needs-human', 'CI is still red — refresh must not clear the handoff just because threads are clear');
  assert.equal(next.handoff.reason, 'ci-failing', 'handoff latch untouched');
  assert.deepEqual(next.command_ids, [1], 'a confirmed decline is still marked processed');
  const report = effects.find((e) => e.type === 'refresh-report');
  assert.equal(report.outcome, 'ci-failing');
});

test('/ai refresh declines while a ci-failing handoff is rerunning (pending), not just outright red', () => {
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', round: 1, handoff: { done: true, notified: true, reason: 'ci-failing' },
  };
  const { next, effects } = reduce({ ...base, prev: stuck, ci: 'pending', openThreads: [], humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(next.state, 'ai:needs-human', 'a rerun-in-progress is not a confirmed pass — refresh must not clear the handoff');
  assert.equal(next.handoff.reason, 'ci-failing', 'handoff latch untouched');
  const report = effects.find((e) => e.type === 'refresh-report');
  assert.equal(report.outcome, 'ci-failing');
});

test('/ai refresh clears a ci-failing handoff once CI is no longer failing', () => {
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', round: 1, handoff: { done: true, notified: true, reason: 'ci-failing' },
  };
  const { next, effects } = reduce({ ...base, prev: stuck, ci: 'success', openThreads: [], humanCommand: { type: 'refresh', id: 1 } });
  assert.notEqual(next.state, 'ai:needs-human', 'CI recovered — nothing left blocking reconciliation');
  const report = effects.find((e) => e.type === 'refresh-report');
  assert.equal(report.outcome, 're-queued');
});

test('/ai refresh re-queues over a standing human REQUEST_CHANGES without dispatching on it', () => {
  const review = { id: 9, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'oleh' } };
  const result = humanBlockingResult([review], [], { humans: ['oleh'], headSha: 'sha1' });
  const stuck = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const { next, effects } = reduce({ ...base, prev: stuck, codexResult: result, openThreads: [], humanCommand: { type: 'refresh', id: 1 } });
  assert.notEqual(next.state, 'ai:fixing', 'reconciliation itself dispatches nothing');
  assert.deepEqual(types(effects).filter((t) => t === 'dispatch-fixer'), []);
  const report = effects.find((e) => e.type === 'refresh-report');
  assert.equal(report.outcome, 're-queued');
  assert.equal(report.standingHumanReview, true, 'flagged — a human review has no numeric id field, so the caller still needs telling to dismiss it');
  assert.equal(next.codex.review_floor, 9, 'the discarded review\'s reviewId still raises the floor, via codexResultId\'s fallback');
});

test('/ai refresh re-queuing preserves summoned_floor, not just review_floor', () => {
  // Regression: the re-queue reset built a fresh `s.codex` object that carried forward
  // `review_floor` but omitted `summoned_floor` entirely, silently dropping it to 0 (via
  // the `?? 0` fallback everywhere it's read). A released summoned review's floor reverting
  // to 0 makes it look unreleased again to `skipStaleCleanAfterSummonedInvalidation`,
  // suppressing a fresh clean recognized-reviewer result forever.
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:reviewing',
    codex: {
      requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'clean', human_review_id: null,
      review_floor: 0, summoned_floor: 42,
    },
  };
  const { next } = reduce({ ...base, prev: stuck, openThreads: [], humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(next.codex.summoned_floor, 42, 'a released summoned review\'s floor must survive a refresh re-queue');
});

test('/ai refresh out of ai:fixing with a body-only summoned review latched hands off instead of silently dropping it', () => {
  // Regression: the re-queue branch moved `s.state` off `ai:fixing` without reading
  // `s.summonedDuringFix` first — the head-change block's later handling of a still-running
  // fixer's eventual push only reads that latch when the PRIOR state was `ai:fixing`, so
  // once refresh has already moved state to `ai:queued`, that block would find nothing to
  // hand off and the body-only finding (no thread of its own to recover from) is lost.
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:fixing', round: 1, summonedDuringFix: 77,
  };
  // The summoned review is still standing (not dismissed) — orchestrate.js re-derives it
  // on every run, so this event carries it too, same as a real one would (see the /ai
  // retry test above). Omitting it here defaults to null, which the summoned-review
  // release branch above (state.js) reads as "dismissed" and clears `summonedDuringFix`
  // before this refresh branch ever gets to capture it — a test-input gap, not a
  // reachable production state, since a still-standing review always re-derives non-null.
  const { next, effects } = reduce({
    ...base, prev: stuck, openThreads: [], humanCommand: { type: 'refresh', id: 1 }, summonedReviewId: 77,
  });
  assert.equal(next.state, 'ai:needs-human', 'no thread to recover from once state moves off ai:fixing — hand off now');
  assert.equal(next.handoff.reason, 'summoned-review-during-fix');
  // #115: NOT cleared to null here, unlike an earlier version of this fix — the review
  // (77) is still standing, not dismissed, so clearing now would let a SECOND /ai refresh
  // on this same unaddressed review read a stale null and silently resume automation
  // (`re-queued`) right past it. Only clears once genuinely released (summonedReviewId ==
  // null) or explicitly addressed (/ai fix from this exact handoff).
  assert.equal(next.summonedDuringFix, 77);
  assert.deepEqual(types(effects).filter((t) => t === 'refresh-report'), [],
    'the handoff effects replace the normal re-queued report');
  assert.deepEqual(types(effects).filter((t) => t === 'notify'), ['notify']);
});

test('#115: a second /ai refresh on the same still-standing summoned review hands off again, not silently re-queued', () => {
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:fixing', round: 1, summonedDuringFix: 77,
  };
  const first = reduce({
    ...base, prev: stuck, openThreads: [], humanCommand: { type: 'refresh', id: 1 }, summonedReviewId: 77,
  }).next;
  assert.equal(first.handoff.reason, 'summoned-review-during-fix');

  const { next, effects } = reduce({
    ...base, prev: first, openThreads: [], humanCommand: { type: 'refresh', id: 2 }, summonedReviewId: 77,
  });
  assert.equal(next.state, 'ai:needs-human', 'must not silently resume automation past a still-unaddressed summoned review');
  assert.equal(next.handoff.reason, 'summoned-review-during-fix');
  assert.deepEqual(types(effects).filter((t) => t === 'refresh-report'), []);
});

test('P1 finding on #119 round 4: /ai refresh must not clear the latch on a plain summonedReviewId == null without confirmed dismissal', () => {
  // Same reclassification gap as /ai retry: `summonedReviewId` can go null on an
  // unchanged head because a base-policy edit reclassified the latched review's author
  // out of the summoned-actor set, not because it was dismissed. This call still hands
  // off (a still-set latch going into this branch always converts to a handoff), but the
  // persisted `summonedDuringFix` must survive so a SECOND refresh hands off again
  // instead of silently re-queuing past it.
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:fixing', round: 1, summonedDuringFix: 77,
  };
  const first = reduce({
    ...base, prev: stuck, openThreads: [], humanCommand: { type: 'refresh', id: 1 },
    summonedReviewId: null, summonedDuringFixDismissed: false,
  }).next;
  assert.equal(first.state, 'ai:needs-human');
  assert.equal(first.handoff.reason, 'summoned-review-during-fix');
  assert.equal(first.summonedDuringFix, 77, 'must survive a reclassification — the review was never actually dismissed');

  const { next, effects } = reduce({
    ...base, prev: first, openThreads: [], humanCommand: { type: 'refresh', id: 2 },
    summonedReviewId: null, summonedDuringFixDismissed: false,
  });
  assert.equal(next.state, 'ai:needs-human', 'must hand off again, not silently resume automation');
  assert.equal(next.handoff.reason, 'summoned-review-during-fix');
  assert.deepEqual(types(effects).filter((t) => t === 'refresh-report'), []);
});

test('/ai refresh\'s review_floor bump (via a human review\'s reviewId) blocks a later event from re-consuming an older bot review on the same head', () => {
  // Regression: review_floor bumps used to read only `codexResult?.id`, which is always
  // undefined for a human-sourced result (see humanBlockingResult's `reviewId`). Refresh
  // re-queuing over a standing human REQUEST_CHANGES never raised the floor, so once that
  // review was dismissed and GitHub's "latest" review for the head reverted to an older
  // bot 'clean' review, a later event could re-consume it and promote straight to
  // ai:ready — without the fresh review reconciliation promises.
  const humanReview = { id: 9, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'oleh' } };
  const humanResult = humanBlockingResult([humanReview], [], { humans: ['oleh'], headSha: 'sha1' });
  const stuck = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const refreshed = reduce({
    ...base, prev: stuck, codexResult: humanResult, openThreads: [], humanCommand: { type: 'refresh', id: 1 },
  }).next;
  assert.equal(refreshed.codex.review_floor, 9);

  // The human review is now dismissed; GitHub's latest review for the head reverts to an
  // older bot 'clean' review (id 3, below the floor) on an unrelated later event.
  const staleBotClean = { blocking: false, sha: 'sha1', id: 3 };
  const { next, effects } = reduce({ ...base, prev: refreshed, ci: 'success', codexResult: staleBotClean, openThreads: [] });
  assert.notEqual(next.state, 'ai:ready', 'the pre-refresh bot review must not silently promote the PR');
  assert.equal(next.codex.result, null, 'never consumed — reviewed_sha/result stay unset from the re-queue');
  assert.deepEqual(types(effects).filter((t) => t === 'notify'), []);
});

test('/ai refresh replayed with the same comment id is a no-op the second time', () => {
  const stuck = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const first = reduce({ ...base, prev: stuck, openThreads: [], humanCommand: { type: 'refresh', id: 5 } });
  assert.notEqual(first.next.state, 'ai:fixing');

  const replay = reduce({ ...base, prev: first.next, openThreads: [], humanCommand: { type: 'refresh', id: 5 } });
  assert.deepEqual(types(replay.effects).filter((t) => t === 'refresh-report'), [], 'no second report on a replayed command id');
});

test('/ai refresh replayed with the same comment id does not let a still-standing human review dispatch a fixer', () => {
  // Regression: the "already processed" no-op branch didn't set refreshedThisEvent, so a
  // replayed /ai refresh (duplicate webhook delivery, or a manual Actions re-run of the
  // same job) fell through to the codexResult-consuming block below and dispatched a
  // fixer on the exact review the original call had just re-queued over — breaking
  // refresh's no-dispatch contract on replay.
  const review = { id: 9, state: 'CHANGES_REQUESTED', commit_id: 'sha1', user: { login: 'oleh' } };
  const result = humanBlockingResult([review], [], { humans: ['oleh'], headSha: 'sha1' });
  const stuck = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const first = reduce({ ...base, prev: stuck, codexResult: result, openThreads: [], humanCommand: { type: 'refresh', id: 5 } });
  assert.notEqual(first.next.state, 'ai:fixing');

  const replay = reduce({ ...base, prev: first.next, codexResult: result, openThreads: [], humanCommand: { type: 'refresh', id: 5 } });
  assert.deepEqual(types(replay.effects).filter((t) => t === 'dispatch-fixer'), [],
    'a replayed refresh must not dispatch even with the same standing review still visible to this call');
  assert.deepEqual(types(replay.effects).filter((t) => t === 'refresh-report'), [], 'no second report on a replayed command id');
});

test('/ai refresh declining for open threads does not fall through and promote to ai:ready in the same call', () => {
  // Regression: the threads-open decline reported "changed nothing" and left `s.state`
  // at `ai:reviewing` with a stale recorded 'clean' result — falling through to the
  // CI-driven promotion block below then jumped straight to ai:ready in the very same
  // call whenever CI happened to read 'success', contradicting the decline it just
  // reported.
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:reviewing',
    codex: { requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'clean', human_review_id: null, review_floor: 0 },
  };
  const openThreads = [{ id: 't1', path: 'scripts/lib/state.js', line: 277 }];
  const { next, effects } = reduce({ ...base, prev: stuck, ci: 'success', openThreads, humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(next.state, 'ai:reviewing', 'threads-open must decline outright, not promote to ai:ready in the same call');
  assert.deepEqual(types(effects), ['refresh-report'], 'no ready notification either');
  const report = effects.find((e) => e.type === 'refresh-report');
  assert.equal(report.outcome, 'threads-open');
});

test('/ai refresh with unconfirmed thread state does not fall through and promote to ai:ready in the same call', () => {
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:reviewing',
    codex: { requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'clean', human_review_id: null, review_floor: 0 },
  };
  const { next, effects } = reduce({ ...base, prev: stuck, ci: 'success', openThreads: null, humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(next.state, 'ai:reviewing', 'unconfirmed thread state must never read as agreement, including for this promotion');
  assert.deepEqual(types(effects).filter((t) => t === 'notify'), []);
  const report = effects.find((e) => e.type === 'refresh-report');
  assert.equal(report.outcome, 'unconfirmed');
});

test('/ai refresh declining for open threads does not fall through and request a fresh codex review in the same call', () => {
  // Regression: `refreshDeclinedThisEvent` only gated the CI-driven ai:ready promotion
  // further below, not this request-codex block. A stuck `ai:queued`/`ai:reviewing` state
  // with no recorded result still requested a fresh review and moved state to
  // `ai:reviewing` right here, contradicting the decline the reply just reported.
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:reviewing',
    codex: { requested_sha: null, reviewed_sha: null, result: null, human_review_id: null, review_floor: 0 },
  };
  const openThreads = [{ id: 't1', path: 'scripts/lib/state.js', line: 277 }];
  const { next, effects } = reduce({ ...base, prev: stuck, openThreads, humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(next.state, 'ai:reviewing');
  assert.deepEqual(types(effects), ['refresh-report'], 'no request-codex either — a declined refresh changes nothing');
});

test('/ai refresh with unconfirmed thread state does not fall through and request a fresh codex review in the same call', () => {
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:queued',
    codex: { requested_sha: null, reviewed_sha: null, result: null, human_review_id: null, review_floor: 0 },
  };
  const { next, effects } = reduce({ ...base, prev: stuck, openThreads: null, humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(next.state, 'ai:queued', 'must not advance to ai:reviewing off an unconfirmed decline');
  assert.deepEqual(types(effects), ['refresh-report']);
});

test('/ai refresh replayed after an original threads-open decline does not fall through and promote to ai:ready', () => {
  // Regression: the "already processed" no-op branch only replayed `refreshedThisEvent`,
  // not `refreshDeclinedThisEvent`. CI flipping to success between the original decline and
  // a replay of the same comment id (duplicate webhook, or a manual Actions re-run of the
  // same job) then promoted straight to ai:ready off the stale recorded 'clean' result,
  // despite the same still-open threads the original call declined over.
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:reviewing',
    codex: { requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'clean', human_review_id: null, review_floor: 0 },
  };
  const openThreads = [{ id: 't1', path: 'scripts/lib/state.js', line: 277 }];
  const first = reduce({ ...base, prev: stuck, ci: 'pending', openThreads, humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(first.next.state, 'ai:reviewing');

  const replay = reduce({ ...base, prev: first.next, ci: 'success', openThreads, humanCommand: { type: 'refresh', id: 1 } });
  assert.equal(replay.next.state, 'ai:reviewing', 'must not promote to ai:ready off the stale clean result on replay');
  assert.deepEqual(types(replay.effects).filter((t) => t === 'notify'), []);
});

test('renderRefreshReply covers every outcome', () => {
  assert.match(renderRefreshReply({ outcome: 'nothing-to-reconcile' }), /already `ai:ready`/);
  assert.match(renderRefreshReply({ outcome: 'unconfirmed' }), /could not confirm/);
  assert.match(renderRefreshReply({ outcome: 'ci-failing' }), /CI is still failing/);
  const threadsReply = renderRefreshReply({ outcome: 'threads-open', threads: [{ path: 'a.js', line: 3 }] });
  assert.match(threadsReply, /1 unresolved thread/);
  assert.match(threadsReply, /a\.js:3/);
  assert.doesNotMatch(renderRefreshReply({ outcome: 're-queued', standingHumanReview: false }), /REQUEST_CHANGES/);
  assert.match(renderRefreshReply({ outcome: 're-queued', standingHumanReview: true }), /REQUEST_CHANGES.*still standing/s);
  assert.doesNotMatch(renderRefreshReply({ outcome: 're-queued', wasFixing: false }), /discarded/);
  assert.match(renderRefreshReply({ outcome: 're-queued', wasFixing: true }), /ai:fixing.*discarded/s);
});
