import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, parseStateComment, parseEchoMarker, renderComment, renderEcho, reduce } from '../scripts/lib/state.js';
import { describeHandoff } from '../scripts/lib/handoff.js';
import { parsePolicy } from '../scripts/lib/policy.js';
import { classifyRisk } from '../scripts/lib/risk.js';

const policy = parsePolicy('version: 1\nmode: active\nauthors: ["tali[bot]"]\nhumans: [oleh]\n');
const lowRisk = { level: 'low', humanRequired: false, reasons: [] };
const highRisk = { level: 'high', humanRequired: true, reasons: ['auth touched'] };
const pr = { number: 5, headSha: 'sha1' };

// `openThreads: []` (confirmed empty), not the function's own `null` default: every
// production caller reaching the ci:'success' ai:ready promotion check has already
// fetched and confirmed threads (see reduce()'s own comment on this), so that's the
// realistic default here too — tests exercising the null (unconfirmed) or open-thread
// cases override it explicitly.
const base = {
  pr, policy, risk: lowRisk, event: 'test', codexResult: null, ci: 'pending', fixResult: null, openThreads: [],
};
const types = (effects) => effects.map((e) => e.type);
const notifyKinds = (effects) => effects.filter((e) => e.type === 'notify').map((e) => e.kind);

test('sticky comment marker round-trips through render', () => {
  const s = newState(5, 'sha1', 'active');
  const body = renderComment(s);
  assert.deepEqual(parseStateComment(body), s);
  assert.equal(parseStateComment('no marker here'), null);
  assert.equal(parseStateComment('<!-- ai-orch:state\nnot json\n-->'), null);
});

test('parseStateComment backfills failureConfirmedSha for a pre-migration comment already at one failure', () => {
  // Simulates a sticky comment persisted before `failureConfirmedSha` existed: `ci.sha`
  // already equals the head and `ci.conclusion` is 'failure' (the old dedupe marker),
  // but the new key is simply absent — STATE_VERSION wasn't bumped for this addition.
  const legacy = newState(5, 'sha1', 'active');
  legacy.ci = { sha: 'sha1', conclusion: 'failure', consecutive_failures: 1 };
  const body = `<!-- ai-orch:state\n${JSON.stringify(legacy)}\n-->`;
  const parsed = parseStateComment(body);
  assert.equal(parsed.ci.failureConfirmedSha, 'sha1', 'recreated from the legacy sha/conclusion pair, not left undefined');
  const again = reduce({ ...base, prev: parsed, ci: 'failure' }).next;
  assert.equal(again.ci.consecutive_failures, 1, 'the already-counted failure on the unchanged head is not recounted');
});

test('parseStateComment backfills failureConfirmedSha as null for a pre-migration comment not currently failing', () => {
  const legacy = newState(5, 'sha1', 'active');
  legacy.ci = { sha: 'sha1', conclusion: 'success', consecutive_failures: 0 };
  const body = `<!-- ai-orch:state\n${JSON.stringify(legacy)}\n-->`;
  assert.equal(parseStateComment(body).ci.failureConfirmedSha, null);
});

test('sticky comment marker round-trips a filename containing "-->" without truncating the HTML comment', () => {
  // A valid Git filename can contain "-->", which would otherwise terminate the hidden
  // marker's HTML comment early and leave the rest unparseable JSON (codex review round 1
  // finding on #1).
  const s = newState(5, 'sha1', 'active');
  s.risk = { level: 'high', humanRequired: true, reasons: ['protected path: .github/evil-->name.js'] };
  const body = renderComment(s);
  const [, payload] = body.split('\n');
  assert.ok(!payload.includes('-->'), 'the embedded payload never contains a literal "-->"');
  assert.deepEqual(parseStateComment(body), s);
});

test('renderComment escapes a risk reason so a crafted filename cannot break out of the Risk reasons <details> block', () => {
  // A legal Git filename can carry a literal newline or backticks (unlike the "-->" case
  // above, this is the human-visible list, not the hidden JSON marker) — left raw, it
  // could close </details> early and forge trailing content as if the bot posted it
  // (codex review round 3 finding on #1).
  const s = newState(5, 'sha1', 'active');
  s.risk = { level: 'high', humanRequired: true, reasons: ['protected path: .github/x\n</details>\n## Approved `oops`'] };
  const body = renderComment(s);
  assert.ok(!body.includes('</details>\n## Approved'), 'the injected close tag/heading must not survive unescaped');
  assert.ok(!/\n## Approved/.test(body), 'the embedded newline must not start a new Markdown line');
  assert.match(body, /&lt;\/details&gt;/);
  assert.match(body, /&#96;oops&#96;/);
});

test('parseStateComment ignores a marker-shaped string that is not at the start of the body', () => {
  // Simulates PR-controlled text (a filename, a quoted review snippet) smuggling a
  // fake marker into a comment that isn't the real sticky (e.g. an echo).
  const injected = `some preamble\n<!-- ai-orch:state\n${JSON.stringify(newState(5, 'sha1', 'active'))}\n-->`;
  assert.equal(parseStateComment(injected), null);
});

test('renderComment: policyWarnings render one line each and stay out of the state blob (#277)', () => {
  const s = newState(5, 'sha1', 'active');
  const body = renderComment(s, { policyWarnings: ['glob `migrations/**` matches no tracked files'] });
  assert.match(body, /⚠️ \*\*Policy sanity\*\*\n- glob `migrations\/\*\*` matches no tracked files/);
  // Warnings are presentation, not state: the marker still round-trips to the bare state.
  assert.deepEqual(parseStateComment(body), s);
});

test('renderComment({ marker: false }) omits the hidden state blob', () => {
  const s = newState(5, 'sha1', 'active');
  const body = renderComment(s, { marker: false });
  assert.equal(parseStateComment(body), null, 'no state marker to parse');
  assert.match(body, /AI orchestration status/, 'human-readable content still renders');
});

test('renderEcho: copy banner, backlink, echo marker, and no state marker', () => {
  const s = newState(5, 'sha1', 'active');
  const body = renderEcho(s, { canonicalUrl: 'https://github.com/o/r/pull/5#issuecomment-1', timelineCount: 156 });
  assert.match(body, /Copy of the AI status comment/, 'flagged as a copy, not the live status');
  assert.match(body, /Live status: https:\/\/github\.com\/o\/r\/pull\/5#issuecomment-1/, 'backlinks to the canonical comment');
  assert.deepEqual(parseEchoMarker(body), { n: 156 });
  assert.equal(parseStateComment(body), null, 'an echo never doubles as the state store');
});

test('parseEchoMarker round-trips and returns null on absent/garbage input', () => {
  assert.equal(parseEchoMarker('nothing here'), null);
  assert.equal(parseEchoMarker(null), null);
  assert.equal(parseEchoMarker('<!-- ai-orch:echo n=not-a-number -->'), null);
  assert.deepEqual(parseEchoMarker('<!-- ai-orch:echo n=42 -->'), { n: 42 });
});

test('fresh PR: requests Codex exactly once, moves to reviewing', () => {
  const { next, effects } = reduce({ ...base, prev: null });
  assert.equal(next.state, 'ai:reviewing');
  assert.equal(next.codex.requested_sha, 'sha1');
  assert.deepEqual(types(effects), ['request-codex']);
});

test('duplicate event delivery is idempotent — no second request', () => {
  const first = reduce({ ...base, prev: null });
  const second = reduce({ ...base, prev: first.next });
  assert.deepEqual(types(second.effects), []);
  assert.deepEqual(second.next, { ...first.next, history: second.next.history });
});

test('blocking review dispatches fixer and increments round', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }] };
  const { next, effects } = reduce({ ...base, prev, codexResult });
  assert.equal(next.state, 'ai:fixing');
  assert.equal(next.round, 1);
  assert.equal(next.rounds_total, 1, 'never-resets counter tracks the same dispatch');
  assert.deepEqual(types(effects), ['dispatch-fixer']);
});

test('rounds_total: never resets across /ai retry, a human push, or a new head — round does', () => {
  let s = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }] };
  s = reduce({ ...base, prev: s, codexResult }).next; // round 1, total 1
  s = reduce({ ...base, prev: s, pr: { ...pr, headSha: 'sha2' } }).next; // fixer's push → back to ai:reviewing
  s = reduce({ ...base, prev: s, pr: { ...pr, headSha: 'sha2' }, codexResult: { ...codexResult, sha: 'sha2' } }).next; // round 2, total 2
  assert.equal(s.round, 2);
  assert.equal(s.rounds_total, 2);

  const retried = reduce({ ...base, prev: s, pr: { ...pr, headSha: 'sha2' }, humanCommand: { type: 'retry', id: 1 } }).next;
  assert.equal(retried.round, 0, 'retry resets the episode counter');
  assert.equal(retried.rounds_total, 2, 'retry does not reset the lifetime counter');

  const pushed = reduce({ ...base, prev: s, pr: { ...pr, headSha: 'sha3' }, pushedByHuman: true }).next;
  assert.equal(pushed.round, 0, 'a human push resets the episode counter');
  assert.equal(pushed.rounds_total, 2, 'a human push does not reset the lifetime counter');
});

test('rounds_total: /ai fix increments it too, uncapped', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const { next } = reduce({ ...base, prev, humanCommand: { type: 'fix', id: 1 } });
  assert.equal(next.round, 1);
  assert.equal(next.rounds_total, 1);
});

test('rounds_total: back-fills from history for state persisted before the field existed', () => {
  const fresh = reduce({ ...base, prev: null }).next;
  // Simulate legacy state: three prior fixer dispatches recorded in history, round
  // reset to 1 by a retry, and rounds_total never having existed.
  const legacy = {
    ...fresh, round: 1,
    history: [
      { t: 't1', event: 'e', from: 'ai:reviewing', to: 'ai:fixing' },
      { t: 't2', event: 'e', from: 'ai:queued', to: 'ai:reviewing' },
      { t: 't3', event: 'e', from: 'ai:reviewing', to: 'ai:fixing' },
      { t: 't4', event: 'e', from: 'ai:queued', to: 'ai:reviewing' },
      { t: 't5', event: 'e', from: 'ai:reviewing', to: 'ai:fixing' },
    ],
  };
  delete legacy.rounds_total;
  const { next } = reduce({ ...base, prev: legacy });
  assert.equal(next.rounds_total, 3, 'floor derived from history, not the reset round counter');
});

test('rounds_total: back-fills to round when history is empty (oldest legacy states)', () => {
  const fresh = reduce({ ...base, prev: null }).next;
  const legacy = { ...fresh, round: 4, history: [] };
  delete legacy.rounds_total;
  const { next } = reduce({ ...base, prev: legacy });
  assert.equal(next.rounds_total, 4);
});

test('per-PR round-cap overrides policy.maxRounds in the round-limit check', () => {
  // round-cap alone (no standing review) leaves state at ai:reviewing — a consuming
  // state — so each variant below can independently feed it a fresh codexResult.
  const capped = reduce({ ...base, prev: null, humanCommand: { type: 'round-cap', cap: 5, id: 1 } }).next;
  assert.equal(capped.state, 'ai:reviewing');
  assert.equal(capped.effective_cap, 5);
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }] };

  // policy.maxRounds is 2 (default) — round 3 would hand off without the override.
  const belowCap = { ...capped, round: 3, rounds_total: 3 };
  const { next: viaCap } = reduce({ ...base, prev: belowCap, codexResult });
  assert.equal(viaCap.state, 'ai:fixing', 'round 3 dispatches under a cap of 5');
  assert.equal(viaCap.round, 4);

  const atCap = { ...capped, round: 5, rounds_total: 5 };
  const { next } = reduce({ ...base, prev: atCap, codexResult });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'round-limit', 'hands off once the override itself is reached');
});

test('round-cap: 0 hands off on the very first blocking review', () => {
  const s = reduce({ ...base, prev: null, humanCommand: { type: 'round-cap', cap: 0, id: 1 } }).next;
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }] };
  const { next } = reduce({ ...base, prev: s, codexResult });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'round-limit');
});

test('round limit reached → single handoff, no more fixing', () => {
  let s = reduce({ ...base, prev: null }).next;
  s.round = policy.maxRounds;
  const codexResult = { blocking: true, sha: 'sha1', findings: [] };
  const { next, effects } = reduce({ ...base, prev: s, codexResult });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'round-limit');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
  assert.deepEqual(notifyKinds(effects), ['needs-human']);
  // replay: handoff fires once
  const replay = reduce({ ...base, prev: next, codexResult });
  assert.deepEqual(types(replay.effects), []);
});

test('escalated local-reviewer result → needs-human, never dispatches the fixer', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: true, escalate: true, sha: 'sha1', findings: [] };
  const { next, effects } = reduce({ ...base, prev, codexResult });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'local-reviewer-escalation');
  assert.equal(next.round, 0, 'no fix round burned on an escalation with nothing to fix');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
  assert.deepEqual(notifyKinds(effects), ['needs-human']);
});

test('clean review + green CI + low risk → ready', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const { next, effects } = reduce({ ...base, prev, codexResult, ci: 'success' });
  assert.equal(next.state, 'ai:ready');
  assert.deepEqual(types(effects), ['notify']);
  assert.deepEqual(notifyKinds(effects), ['ready'], 'a human doing a manual merge gets pinged that the PR is mergeable');
});

// #124: a clean AI verdict is never sufficient alone — an open adjudicated-voice thread
// (openThreads, fetched by orchestrate.js's approachingReady condition) must still block
// promotion, independent of which backend produced the clean verdict.
test('clean review + green CI does NOT promote to ready while a thread is still open (#124)', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const { next, effects } = reduce({
    ...base, prev, codexResult, ci: 'success', openThreads: [{ id: 1 }],
  });
  assert.notEqual(next.state, 'ai:ready');
  assert.deepEqual(notifyKinds(effects), [], 'no ready ping while a thread is still open');
});

test('clean review + green CI promotes to ready once openThreads is confirmed empty (#124)', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const { next, effects } = reduce({
    ...base, prev, codexResult, ci: 'success', openThreads: [],
  });
  assert.equal(next.state, 'ai:ready');
  assert.deepEqual(notifyKinds(effects), ['ready']);
});

test('clean review + green CI promotes to ready when openThreads is null and no fetch was ever attempted (the common case — no regression from #124)', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const { next, effects } = reduce({
    ...base, prev, codexResult, ci: 'success', openThreads: null,
  });
  assert.equal(next.state, 'ai:ready', 'pre-#124 behavior for every event that had no reason to fetch threads at all');
  assert.deepEqual(notifyKinds(effects), ['ready']);
});

// #14 round 2 (Garrus P1): the ai:ready-promotion thread fetch itself (orchestrate.js's
// approachingReady) collapses to the same `openThreads: null` on a real GraphQL failure
// as on "never fetched" — threadFetchFailed is how orchestrate.js tells reduce() which
// one actually happened, without changing what a bare `openThreads: null` means for
// every other caller (test above).
test('clean review + green CI does NOT promote to ready when the ready-promotion thread fetch specifically failed (threadFetchFailed)', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const { next, effects } = reduce({
    ...base, prev, codexResult, ci: 'success', openThreads: null, threadFetchFailed: true,
  });
  assert.notEqual(next.state, 'ai:ready', 'a failed confirmation attempt must hedge, never fall back to promoting');
  assert.deepEqual(notifyKinds(effects), []);
});

test('ai:ready does not re-notify on replay — idempotent like every other effect', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const ready = reduce({ ...base, prev, codexResult, ci: 'success' }).next;
  assert.equal(ready.state, 'ai:ready');
  const { next, effects } = reduce({ ...base, prev: ready, codexResult, ci: 'success' });
  assert.equal(next.state, 'ai:ready');
  assert.deepEqual(types(effects), [], 'replaying the same clean/green/low-risk input must not re-ping');
});

// #144/#203 (ADR 0012): risk stopped gating `ai:ready` — it's the AI axis only now
// (clean review + green CI). A PR classified `high`/`humanRequired: true` still
// promotes, carrying its risk classification along for labels/notify to report.
test('clean review + green CI + high risk → ready (risk no longer gates ai:ready)', () => {
  const prev = reduce({ ...base, prev: null, risk: highRisk }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const { next, effects } = reduce({ ...base, prev, risk: highRisk, codexResult, ci: 'success' });
  assert.equal(next.state, 'ai:ready');
  assert.deepEqual(next.risk, highRisk, 'the elevated classification survives the promotion for downstream labels/notify');
  assert.deepEqual(notifyKinds(effects), ['ready']);
});

// #144/#203: the old risk-requires-human handoff also requested the human's GitHub
// review (toHandoff's request-human-review) — preserved on the same promotion so that
// surface doesn't silently disappear alongside the gate/label change.
test('an elevated-risk ai:ready promotion still requests the human review, once', () => {
  const prev = reduce({ ...base, prev: null, risk: highRisk }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const { next, effects } = reduce({ ...base, prev, risk: highRisk, codexResult, ci: 'success' });
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);

  // A CI rerun bouncing ai:ready → ai:reviewing → ai:ready without a new head must not
  // re-request the review, mirroring the notify latch it piggybacks on.
  const { next: replayed, effects: replayEffects } = reduce({ ...base, prev: next, risk: highRisk, codexResult, ci: 'success' });
  assert.equal(replayed.state, 'ai:ready');
  assert.deepEqual(types(replayEffects), []);
});

// codex review round 1 finding on #206: readyNotified used to gate both effects, so
// orchestrate.js's failed-delivery rollback (which only rolls back the notify latch)
// left an elevated-risk PR replaying request-human-review on every retry.
test('an elevated-risk ai:ready promotion: a failed/disabled Telegram send retries only the notify, not the review request', () => {
  const stuck = {
    ...reduce({ ...base, prev: null, risk: highRisk }).next,
    state: 'ai:ready', risk: highRisk,
    readyNotified: false, readyReviewRequested: true,
  };
  const { next, effects } = reduce({ ...base, prev: stuck, risk: highRisk, codexResult: null, ci: 'success' });
  assert.deepEqual(types(effects), ['notify'], 'must not re-issue request-human-review once it has already gone out');
  assert.equal(next.readyReviewRequested, true);
  assert.equal(next.readyNotified, true);
});

test('a low-risk ai:ready promotion does not request a human review — notify only', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const { effects } = reduce({ ...base, prev, codexResult, ci: 'success' });
  assert.deepEqual(types(effects), ['notify']);
});

test('clean review + pending CI stays reviewing; later CI success completes', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const mid = reduce({ ...base, prev, codexResult, ci: 'pending' }).next;
  assert.equal(mid.state, 'ai:reviewing');
  const { next } = reduce({ ...base, prev: mid, codexResult, ci: 'success' });
  assert.equal(next.state, 'ai:ready');
});

test('fixer dispute without push, thread still open → agents-disagree handoff (definite)', () => {
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const openThreads = [{ path: 'a.js', comments: [{ author: 'normandy-garrus[bot]', body: 'still not fixed' }] }];
  const { next } = reduce({ ...base, prev, fixResult: { outcome: 'disputed' }, openThreads });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'agents-disagree');
});

test('fixer dispute without push, real findings, no threads left → agents-may-disagree (possible)', () => {
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }] }; // no openThreadBlock
  const { next, effects } = reduce({ ...base, prev, codexResult, fixResult: { outcome: 'disputed', reviewUrl: 'https://x/review' }, openThreads: [] });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'agents-may-disagree');
  assert.equal(next.handoff.runUrl, 'https://x/review');
  const notify = effects.find((e) => e.type === 'notify');
  assert.equal(notify.runUrl, 'https://x/review');
});

test('fixer dispute without push, thread state unknown (fetch failed) → agents-may-disagree, never silent', () => {
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const codexResult = { blocking: true, sha: 'sha1', findings: [], openThreadBlock: true };
  const { next } = reduce({ ...base, prev, codexResult, fixResult: { outcome: 'disputed' }, openThreads: null });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'agents-may-disagree', 'unknown thread state must never be read as agreement');
});

test('fixer dispute without push, open-thread block, threads still open → agents-disagree (fixer refused to resolve)', () => {
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const codexResult = { blocking: true, sha: 'sha1', findings: [], openThreadBlock: true };
  const openThreads = [{ path: 'a.js', comments: [{ author: 'normandy-garrus[bot]', body: 'unresolved' }] }];
  const { next } = reduce({ ...base, prev, codexResult, fixResult: { outcome: 'disputed' }, openThreads });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'agents-disagree');
});

// Reconstructed from a live PR's stored state blob: round 2 was
// dispatched purely by the review sweep's open-thread block over one still-unresolved thread
// from round 1; Claude resolved it and correctly changed no code. The real round-2 review
// predates OPEN_THREAD_BLOCK_MARKER and carries no marker — `openThreadBlock: true` here
// is a reconstruction of what the marker would have recorded, not a live fetch.
test('#73 regression: open-thread block resolved with nothing left open → re-queue, not a handoff', () => {
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 2, roundOrigin: 'auto', codex: { requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'blocking', human_review_id: null, review_floor: 0 } };
  const codexResult = { blocking: true, sha: 'sha1', id: 4809124951, findings: [], openThreadBlock: true };
  const { next, effects } = reduce({ ...base, prev, codexResult, fixResult: { outcome: 'disputed' }, openThreads: [] });
  assert.equal(next.state, 'ai:reviewing', 're-queued and immediately re-requests a review of the same head');
  assert.equal(next.handoff.done, false, 'must not hand off — the fixer did exactly what was asked');
  assert.equal(next.fixer.outcome, 'no-change');
  assert.equal(next.codex.review_floor, 4809124951, 'stale-evidence floor latched, mirroring /ai retry');
  assert.deepEqual(types(effects), ['request-codex', 'notify']);
  assert.deepEqual(notifyKinds(effects), ['no-op-round']);

  // Replay: the same fix-result delivered twice must not double-dispatch or re-notify —
  // by the time of a replay, s.state is no longer 'ai:fixing', so the whole fixResult
  // block is skipped outright.
  const replay = reduce({ ...base, prev: next, codexResult, fixResult: { outcome: 'disputed' }, openThreads: [] });
  assert.deepEqual(notifyKinds(replay.effects), [], 'no second no-op-round ping');
});

// A human's /ai fix dispatches its own round independent of any standing review. If a
// stale review still carries openThreadBlock (from an earlier, unrelated round) and its
// threads happen to already be resolved, a no-push answer to the human's instruction must
// not be misread as "that review's open threads got resolved" — it must still surface to
// the human, since the fixer may simply have disputed the /ai fix instruction itself.
test('human /ai fix dispute is never misclassified as the review-open-thread-block no-op', () => {
  let s = { ...reduce({ ...base, prev: null }).next, state: 'ai:ready', round: 0 };
  s = reduce({ ...base, prev: s, humanCommand: { type: 'fix', id: 1 } }).next;
  assert.equal(s.state, 'ai:fixing');
  assert.equal(s.roundOrigin, 'human');

  const staleReview = { blocking: true, sha: 'sha1', id: 42, findings: [], openThreadBlock: true };
  const { next, effects } = reduce({ ...base, prev: s, codexResult: staleReview, fixResult: { outcome: 'disputed' }, openThreads: [] });
  assert.equal(next.state, 'ai:needs-human', 'must hand off, not silently re-queue as a no-op');
  assert.equal(next.handoff.reason, 'agents-may-disagree');
  assert.deepEqual(notifyKinds(effects), ['needs-human']);
});

// A state persisted before `roundOrigin` existed (or a fresh `newState()`, which defaults
// it to null) has no way to prove the in-flight round was auto-dispatched. Requiring the
// explicit 'auto' value (not just `!== 'human'`) means that ambiguity falls through to the
// handoff below instead of being silently read as the review's own threads having resolved.
test('missing/legacy roundOrigin never qualifies for the open-thread-block no-op', () => {
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 2, codex: { requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'blocking', human_review_id: null, review_floor: 0 } };
  assert.equal(prev.roundOrigin, null, 'precondition: default/legacy state has no explicit origin');
  const codexResult = { blocking: true, sha: 'sha1', id: 4809124951, findings: [], openThreadBlock: true };
  const { next } = reduce({ ...base, prev, codexResult, fixResult: { outcome: 'disputed' }, openThreads: [] });
  assert.equal(next.state, 'ai:needs-human', 'must hand off, not silently re-queue as a no-op');
  assert.equal(next.handoff.reason, 'agents-may-disagree');
});

test('#73 regression: re-queue does not swallow a later ready ping (readyNotified reset)', () => {
  // Reach ai:ready once (latches readyNotified), then a required check restarts —
  // ci:pending drops it back to ai:reviewing without clearing the latch (state.js:353).
  let s = reduce({ ...base, prev: null }).next;
  const cleanResult = { blocking: false, sha: 'sha1', findings: [] };
  s = reduce({ ...base, prev: s, codexResult: cleanResult, ci: 'success' }).next;
  assert.equal(s.state, 'ai:ready');
  assert.equal(s.readyNotified, true);
  s = reduce({ ...base, prev: s, codexResult: cleanResult, ci: 'pending' }).next;
  assert.equal(s.state, 'ai:reviewing');
  assert.equal(s.readyNotified, true, 'latch untouched by the ci-pending fallback');

  // A blocking open-thread-block round dispatches, then resolves with nothing left open.
  s = { ...s, state: 'ai:fixing', round: 1, roundOrigin: 'auto' };
  const blockResult = { blocking: true, sha: 'sha1', id: 99, findings: [], openThreadBlock: true };
  s = reduce({ ...base, prev: s, codexResult: blockResult, fixResult: { outcome: 'disputed' }, openThreads: [] }).next;
  assert.equal(s.state, 'ai:reviewing');
  assert.equal(s.readyNotified, false, 're-queue must clear the latch or the next ai:ready is silently swallowed');

  // Re-review comes back clean — the ready ping must actually fire, not be swallowed.
  const { next, effects } = reduce({ ...base, prev: s, codexResult: cleanResult, ci: 'success' });
  assert.equal(next.state, 'ai:ready');
  assert.deepEqual(notifyKinds(effects), ['ready']);
});

test('fixer failure carries the run URL into the handoff and the notify effect', () => {
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const { next, effects } = reduce({ ...base, prev, fixResult: { outcome: 'failed', runUrl: 'https://github.com/o/r/actions/runs/123' } });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'fixer-failed');
  assert.equal(next.handoff.runUrl, 'https://github.com/o/r/actions/runs/123');
  const notify = effects.find((e) => e.type === 'notify');
  assert.equal(notify.runUrl, 'https://github.com/o/r/actions/runs/123', 'Telegram needs the run link too, not just the sticky comment');
});

test('fixer skipped (workflow-validation guard) hands off distinctly from a dispute, not a silent stall', () => {
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const { next, effects } = reduce({ ...base, prev, fixResult: { outcome: 'skipped', runUrl: 'https://github.com/o/r/actions/runs/456' } });
  // Must actually transition — an unhandled outcome would leave state untouched at
  // 'ai:fixing' forever (#133's silent-stall risk), not merely land on the wrong reason.
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'fixer-skipped');
  assert.equal(next.handoff.runUrl, 'https://github.com/o/r/actions/runs/456');
  const notify = effects.find((e) => e.type === 'notify');
  assert.equal(notify.runUrl, 'https://github.com/o/r/actions/runs/456');
});

test('renderComment surfaces open threads and the failed-run link in the handoff block', () => {
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const { next } = reduce({ ...base, prev, fixResult: { outcome: 'failed', runUrl: 'https://github.com/o/r/actions/runs/123' } });
  const threads = [
    { path: 'src/foo.js', comments: [{ author: 'oleh', body: 'this looks unsafe' }, { author: 'oleh', body: 'agreed, please fix' }] },
  ];
  const body = renderComment(next, { handoffThreads: threads });
  assert.match(body, /https:\/\/github\.com\/o\/r\/actions\/runs\/123/);
  assert.match(body, /Open review threads \(1\)/);
  assert.match(body, /src\/foo\.js/);
  assert.match(body, /@oleh/);
  assert.match(body, /\+1 reply, latest @oleh/);
});

test('fixer push rolls to a new SHA cycle, round preserved', () => {
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const { next, effects } = reduce({ ...base, prev, pr: { number: 5, headSha: 'sha2' } });
  assert.equal(next.state, 'ai:reviewing');
  assert.equal(next.round, 1);
  assert.equal(next.codex.requested_sha, 'sha2');
  assert.deepEqual(types(effects), ['request-codex']);
});

test('human push resets round and handoff', () => {
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:needs-human', round: 2, handoff: { done: true, reason: 'round-limit' } };
  const { next } = reduce({ ...base, prev, pr: { number: 5, headSha: 'sha3' }, pushedByHuman: true });
  assert.equal(next.round, 0);
  assert.equal(next.handoff.done, false);
  assert.equal(next.state, 'ai:reviewing');
});

test('human push starting a new episode resets readyNotified — the new episode can re-ping', () => {
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const ready = reduce({ ...base, prev: null, codexResult, ci: 'success' }).next;
  assert.equal(ready.state, 'ai:ready');
  assert.equal(ready.readyNotified, true);
  const pushed = reduce({ ...base, prev: ready, pr: { number: 5, headSha: 'sha4' }, pushedByHuman: true }).next;
  assert.equal(pushed.readyNotified, false, 'a new human-initiated episode must not inherit the prior episode\'s latch');
  const newCodexResult = { blocking: false, sha: 'sha4', findings: [] };
  const { next, effects } = reduce({ ...base, prev: pushed, pr: { number: 5, headSha: 'sha4' }, codexResult: newCodexResult, ci: 'success' });
  assert.equal(next.state, 'ai:ready');
  assert.deepEqual(notifyKinds(effects), ['ready'], 'the new episode reaching ready must actually ping, not get silently swallowed');
});

test('repeated CI failures across SHAs hit the threshold', () => {
  let s = reduce({ ...base, prev: null, ci: 'failure' }).next;
  assert.equal(s.ci.consecutive_failures, 1);
  assert.equal(s.state, 'ai:reviewing');
  s = reduce({ ...base, prev: s, pr: { number: 5, headSha: 'sha2' }, ci: 'failure' }).next;
  assert.equal(s.ci.consecutive_failures, 2);
  assert.equal(s.state, 'ai:needs-human');
  assert.equal(s.handoff.reason, 'ci-failing');
});

test('same-SHA duplicate CI failure does not double-count', () => {
  const one = reduce({ ...base, prev: null, ci: 'failure' }).next;
  const two = reduce({ ...base, prev: one, ci: 'failure' }).next;
  assert.equal(two.ci.consecutive_failures, 1);
});

test('#209: a pending observation on a head does not shadow that head\'s later real failure', () => {
  const pending = reduce({ ...base, prev: null, ci: 'pending' }).next;
  assert.equal(pending.ci.consecutive_failures, 0);
  const failed = reduce({ ...base, prev: pending, ci: 'failure' }).next;
  assert.equal(failed.ci.consecutive_failures, 1);
  assert.equal(failed.state, 'ai:reviewing');
});

test('a same-SHA rerun going pending between two failures does not double-count either', () => {
  const failed = reduce({ ...base, prev: null, ci: 'failure' }).next;
  assert.equal(failed.ci.consecutive_failures, 1);
  const rerunning = reduce({ ...base, prev: failed, ci: 'pending' }).next;
  assert.equal(rerunning.ci.consecutive_failures, 1);
  const failedAgain = reduce({ ...base, prev: rerunning, ci: 'failure' }).next;
  assert.equal(failedAgain.ci.consecutive_failures, 1, 'same head, still only one confirmed failure counted');
  assert.equal(failedAgain.state, 'ai:reviewing');
});

test('a failure after a same-SHA success is counted as new, not deduped against the earlier failure', () => {
  // CI went failure -> success -> failure, all on the same head — the middle success
  // means the earlier failure was resolved, so this one is a fresh regression and must
  // still be counted (not silently deduped just because the SHA repeats).
  const failed = reduce({ ...base, prev: null, ci: 'failure' }).next;
  assert.equal(failed.ci.consecutive_failures, 1);
  const recovered = reduce({ ...base, prev: failed, ci: 'success' }).next;
  assert.equal(recovered.ci.consecutive_failures, 0);
  const failedAgain = reduce({ ...base, prev: recovered, ci: 'failure' }).next;
  assert.equal(failedAgain.ci.consecutive_failures, 1, 'a regression after green on the same head is a new failure');
});

test('a same-SHA rerun going pending after a failure still updates state.ci.conclusion to pending', () => {
  // The dedupe marker (failureConfirmedSha) must survive the pending observation so the
  // counter above doesn't double-count, but state.ci.conclusion still has to mirror the
  // live status — desiredLabels reads it directly for the ci:* label, and a stale
  // 'failure' would keep reporting ci:red for a head that's actually mid-rerun.
  const failed = reduce({ ...base, prev: null, ci: 'failure' }).next;
  assert.equal(failed.ci.conclusion, 'failure');
  const rerunning = reduce({ ...base, prev: failed, ci: 'pending' }).next;
  assert.equal(rerunning.ci.conclusion, 'pending', 'the ci:* label must not stay stuck on a stale failure while CI reruns');
  assert.equal(rerunning.ci.sha, 'sha1');
});

test('non-human push while needs-human stays latched — nothing resumes', () => {
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:needs-human', round: 2, handoff: { done: true, reason: 'round-limit' } };
  const { next, effects } = reduce({ ...base, prev, pr: { number: 5, headSha: 'sha-agent-push' }, pushedByHuman: false });
  assert.equal(next.state, 'ai:needs-human', 'only a human push may leave needs-human');
  assert.equal(next.handoff.done, true);
  assert.equal(next.head_sha, 'sha-agent-push', 'head is still tracked so the event is not replayed forever');
  assert.deepEqual(types(effects), []);
});

test('CI regresses after ai:ready → handoff instead of staying green', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const ready = reduce({ ...base, prev, codexResult, ci: 'success' }).next;
  assert.equal(ready.state, 'ai:ready');
  const { next, effects } = reduce({ ...base, prev: ready, codexResult, ci: 'failure' });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'ci-failing');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
  assert.deepEqual(notifyKinds(effects), ['needs-human']);
});

test('CI goes pending again after ai:ready → falls back to reviewing, not stuck green', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const ready = reduce({ ...base, prev, codexResult, ci: 'success' }).next;
  assert.equal(ready.state, 'ai:ready');
  const rerunning = reduce({ ...base, prev: ready, codexResult, ci: 'pending' }).next;
  assert.equal(rerunning.state, 'ai:reviewing', 'must not keep reporting ready while CI is unresolved');
  const { next, effects } = reduce({ ...base, prev: rerunning, codexResult, ci: 'success' });
  assert.equal(next.state, 'ai:ready', 'self-heals back to ready once CI is green again');
  assert.deepEqual(notifyKinds(effects), [], 'a routine CI rerun must not re-ping — already notified this episode');
});

test('dismissing the Codex review that ai:ready relied on revokes readiness', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const ready = reduce({ ...base, prev, codexResult, ci: 'success' }).next;
  assert.equal(ready.state, 'ai:ready');
  const { next, effects } = reduce({ ...base, prev: ready, codexResult: null, ci: 'success', codexDismissed: true });
  assert.equal(next.state, 'ai:reviewing', 'resets and immediately re-requests within the same event');
  assert.equal(next.codex.result, null, 'the dismissed review no longer counts as a clean result');
  assert.deepEqual(types(effects), ['request-codex'], 'immediately re-requests a fresh review');
});

test('codexDismissed for a stale/older head is a no-op', () => {
  const prev = reduce({ ...base, prev: null }).next; // codex.reviewed_sha unset yet (still ai:reviewing)
  const { next, effects } = reduce({ ...base, prev, codexResult: null, ci: 'pending', codexDismissed: true });
  assert.equal(next.state, 'ai:reviewing');
  assert.deepEqual(types(effects), []);
});

// --- summoned review (#58/#103): a human-triggered @codex/@claude review with open
// findings on the current head invalidates a stale clean/ai:ready verdict — never
// evidence itself, only a trigger. See docs/adr/0007-summoned-reviews-block-never-promote.md.

test('summoned review with findings re-queues an ai:ready PR', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const ready = reduce({ ...base, prev, codexResult, ci: 'success' }).next;
  assert.equal(ready.state, 'ai:ready');

  const { next, effects } = reduce({ ...base, prev: ready, codexResult: null, ci: 'success', summonedReviewId: 42 });
  assert.equal(next.state, 'ai:reviewing', 'resets and immediately re-requests within the same event');
  assert.equal(next.codex.result, null, 'no longer reports the stale clean result');
  assert.equal(next.codex.review_floor, 42, 'latched as the stale-evidence floor');
  assert.equal(next.readyNotified, false, 'the swallowed episode is free to re-ping once genuinely ready again');
  assert.deepEqual(types(effects), ['request-codex']);
});

test('summoned review re-fire guard, mechanism 1: replaying the same id within a head is a no-op; a higher id fires again', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const ready = reduce({ ...base, prev, codexResult, ci: 'success' }).next;
  const requeued = reduce({ ...base, prev: ready, codexResult: null, ci: 'success', summonedReviewId: 42 }).next;

  // Same id again (e.g. the fixer resolved threads without pushing — head unchanged,
  // review still standing) — already at/under the floor, must not re-fire.
  const replayed = reduce({ ...base, prev: requeued, codexResult: null, ci: 'pending', summonedReviewId: 42 });
  assert.equal(replayed.next.state, requeued.state, 'no additional transition from the same review id');
  assert.equal(replayed.next.codex.review_floor, 42);

  // A NEW `@codex review` (higher id) still fires.
  const rereadied = reduce({ ...base, prev: requeued, codexResult, ci: 'success' }).next;
  assert.equal(rereadied.state, 'ai:ready');
  const { next } = reduce({ ...base, prev: rereadied, codexResult: null, ci: 'success', summonedReviewId: 99 });
  assert.equal(next.state, 'ai:reviewing');
  assert.equal(next.codex.review_floor, 99);
});

test('summoned review invalidation is not undone by a fresher clean codexResult in the SAME event — and escalates immediately, since it is body-only', () => {
  // The realistic path: a summoned review's finding is body-only (CHANGES_REQUESTED, no
  // inline comments), so qualifyUnresolvedThreads never sees a thread for it — a
  // recognized reviewer's OWN fresh sweep can legitimately post clean without ever
  // noticing it, and that clean codexResult can arrive in the exact same orchestrator run
  // that also (re-)derives the still-standing summoned review. `staleByFloor` alone does
  // not catch this: the fresh clean result's id is ABOVE the newly-bumped floor.
  //
  // A body-only review has no thread for any automatic mechanism to ever resolve, so
  // rather than silently cycling ai:reviewing forever (the #105 follow-up finding), this
  // hands off to a human the first moment it's confirmed: a genuinely fresh clean result
  // exists and is being suppressed by this exact review.
  const prev = reduce({ ...base, prev: null }).next;
  const initialClean = { blocking: false, sha: 'sha1', findings: [], id: 10 };
  const ready = reduce({ ...base, prev, codexResult: initialClean, ci: 'success' }).next;
  assert.equal(ready.state, 'ai:ready');

  const freshClean = { blocking: false, sha: 'sha1', findings: [], id: 100 }; // higher id than the summoned review below
  const { next, effects } = reduce({
    ...base, prev: ready, codexResult: freshClean, ci: 'success', summonedReviewId: 42,
    summonedReviewUrl: 'https://github.com/o/r/pull/5#pullrequestreview-42',
  });
  assert.equal(next.state, 'ai:needs-human', 'must NOT fall straight back through to ai:ready — nor sit silently in ai:reviewing');
  assert.equal(next.handoff.reason, 'summoned-review-no-thread');
  assert.equal(next.handoff.runUrl, 'https://github.com/o/r/pull/5#pullrequestreview-42');
  assert.equal(next.codex.result, null, 'the fresh clean result must not be consumed this same event either');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
  assert.deepEqual(notifyKinds(effects), ['needs-human']);
});

test('a THREADED summoned review does not trigger the no-thread escalation — it has its own working release path', () => {
  // The escalation must be scoped to body-only reviews only: a threaded summoned review
  // already gets converted to blocking by qualifyUnresolvedThreads on the recognized
  // reviewer's own next scan, so it never even reaches this branch as a clean codexResult
  // in practice — but confirm the escalation itself respects `summonedReviewHasThread`
  // regardless, in case a clean result is gathered before the sweep's next tick.
  const prev = reduce({ ...base, prev: null }).next;
  const initialClean = { blocking: false, sha: 'sha1', findings: [], id: 10 };
  const ready = reduce({ ...base, prev, codexResult: initialClean, ci: 'success' }).next;

  const freshClean = { blocking: false, sha: 'sha1', findings: [], id: 100 };
  const { next, effects } = reduce({
    ...base, prev: ready, codexResult: freshClean, ci: 'success', summonedReviewId: 42,
    summonedReviewHasThread: true,
  });
  assert.equal(next.state, 'ai:reviewing', 'still correctly blocked, but not escalated — its own thread will do the job');
  assert.deepEqual(types(effects), ['request-codex']);
});

test('summoned review invalidation is not undone by the same fresh clean codexResult on a LATER event', () => {
  // #105 P1: `staleByFloor`/`skipStaleCleanAfterSummonedInvalidation` must keep excluding
  // the fresh clean result for as long as the summoned review stands, not just the one
  // event where the reset fires. Once `summonedReviewId` settles at the (now-equal)
  // `review_floor`, the reset guard above stops re-firing — a later event (a CI/status
  // update, another cron tick) that re-derives the SAME still-standing summoned review
  // and the SAME fresh clean codexResult must still not promote to ai:ready.
  //
  // Threaded deliberately (unlike the SAME-event test above): a body-only review would
  // escalate to ai:needs-human on the very first call, collapsing this into a no-op replay
  // of that handoff and no longer exercising `staleByFloor` across two separate ticks in
  // isolation the way this test intends.
  const prev = reduce({ ...base, prev: null }).next;
  const initialClean = { blocking: false, sha: 'sha1', findings: [], id: 10 };
  const ready = reduce({ ...base, prev, codexResult: initialClean, ci: 'success' }).next;
  assert.equal(ready.state, 'ai:ready');

  const freshClean = { blocking: false, sha: 'sha1', findings: [], id: 100 };
  const invalidated = reduce({
    ...base, prev: ready, codexResult: freshClean, ci: 'success', summonedReviewId: 42,
    summonedReviewHasThread: true,
  }).next;
  // The floor also folds in the suppressed codexResult's own id (100), not just
  // summonedReviewId (42) — otherwise needsReview() (the companion's review sweep) would see that same
  // still-standing result as already-posted-above-the-floor and refuse to ever re-scan,
  // deadlocking the thread's own self-resolving release path (#105 finding).
  assert.equal(invalidated.codex.review_floor, 100);
  assert.equal(invalidated.state, 'ai:reviewing', 'threaded — not escalated, its own thread will do the job');

  const { next, effects } = reduce({
    ...base, prev: invalidated, codexResult: freshClean, ci: 'success', summonedReviewId: 42,
    summonedReviewHasThread: true,
  });
  assert.notEqual(next.state, 'ai:ready', 'must not silently promote once the reset stops re-firing');
  assert.equal(next.codex.result, null, 'the stale clean result must still not be consumed');
  assert.deepEqual(notifyKinds(effects), [], 'no duplicate ready notify');
});

test('#105 finding: a clean-but-contested codexResult while a summoned review stands still hands off, not silently swallowed', () => {
  // `skipStaleCleanAfterSummonedInvalidation` must only suppress a GENUINELY clean
  // result (one that would promote ai:ready) — not a clean-state COMMENT review that
  // still carries `contested`/`awaitingHuman` (buildReviewPayload stamps those markers
  // "regardless of which branch runs", so `blocking` can be false while `contested` is
  // true). Gating the skip on `!codexResult.blocking` alone swallowed the whole
  // consuming block, including the contested/awaitingHuman `toHandoff` calls, silently
  // stranding the PR in `ai:reviewing`.
  const prev = reduce({ ...base, prev: null }).next;
  const contestedClean = { blocking: false, sha: 'sha1', findings: [], contested: true, id: 100 };
  const { next, effects } = reduce({
    ...base, prev, codexResult: contestedClean, ci: 'success', summonedReviewId: 42,
  });
  assert.equal(next.state, 'ai:needs-human', 'must still route to a human, not get stuck in ai:reviewing');
  assert.equal(next.handoff.reason, 'reviewer-sustained');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
});

test('#105 finding: an escalate codexResult while a summoned review stands still hands off', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const escalateResult = { blocking: true, sha: 'sha1', findings: [], escalate: true, id: 100 };
  const { next, effects } = reduce({
    ...base, prev, codexResult: escalateResult, ci: 'success', summonedReviewId: 42,
  });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'local-reviewer-escalation');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
});

test('summoned review does not fire while ai:fixing or latched at ai:needs-human', () => {
  const fixing = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const { next: stillFixing } = reduce({ ...base, prev: fixing, codexResult: null, ci: 'pending', summonedReviewId: 5 });
  assert.equal(stillFixing.state, 'ai:fixing', 'a round already in flight is not interrupted');
  assert.equal(stillFixing.summonedDuringFix, 5, 'latched, not dropped — see the push-loses-it regression test below');

  const stuck = { ...reduce({ ...base, prev: null }).next, state: 'ai:needs-human', handoff: { done: true, reason: 'risk-requires-human' } };
  const { next: stillStuck } = reduce({ ...base, prev: stuck, codexResult: null, ci: 'pending', summonedReviewId: 5 });
  assert.equal(stillStuck.state, 'ai:needs-human', 'a human is already on the hook — only /ai retry|fix moves it');
  assert.equal(stillStuck.summonedDuringFix, null, 'no latch needed — already latched at ai:needs-human');
});

test('P1 finding on #119 round 3: latching stores the FULL standing set, not just the oldest id', () => {
  // `summonedDuringFix` can represent two distinct reviews (the oldest, plus a newer
  // body-only one hiding behind it) — `summonedDuringFixIds` must snapshot every id
  // `standingSummonedReviewIds` (orchestrate.js) reports at latch time so
  // `allSummonedReviewsDismissed` can later verify each one independently of the single
  // remembered oldest id.
  const fixing = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const { next } = reduce({
    ...base, prev: fixing, codexResult: null, ci: 'pending', summonedReviewId: 5,
    summonedReviewHasBodyOnlyPending: true, summonedReviewIds: [5, 9],
  });
  assert.equal(next.summonedDuringFix, 5, 'the oldest id is still the reported one');
  assert.deepEqual(next.summonedDuringFixIds, [5, 9], 'but the full standing set is preserved alongside it');
});

test('P1 finding on #119 round 4: a re-latch on an already-running round must not drop a previously snapshotted id', () => {
  // The latch block re-fires every event while a round stays ai:fixing (see the
  // "idempotent re-latch" comment in state.js). `summonedReviewIds` is reclassified
  // through the CURRENT policy on every call (orchestrate.js) — if a base-policy edit
  // reclassifies review 5's author out of the summoned-actor set while review 9 stays
  // classified, a naive overwrite would shrink the snapshot from [5, 9] to [9] and
  // permanently lose review 5's dismissal requirement, even though it was never dismissed.
  const fixing = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const { next: latched } = reduce({
    ...base, prev: fixing, codexResult: null, ci: 'pending', summonedReviewId: 5,
    summonedReviewHasBodyOnlyPending: true, summonedReviewIds: [5, 9],
  });
  assert.deepEqual(latched.summonedDuringFixIds, [5, 9]);

  // A later event on the same still-running round: the policy reclassified review 5 out,
  // so this call's freshly-derived standing set only reports review 9.
  const { next: reclassified } = reduce({
    ...base, prev: latched, codexResult: null, ci: 'pending', summonedReviewId: 9,
    summonedReviewHasBodyOnlyPending: true, summonedReviewIds: [9],
  });
  assert.deepEqual(reclassified.summonedDuringFixIds, [5, 9],
    'review 5 must survive the reclassification, not be silently dropped from the snapshot');
});

test('#105 finding: a body-only summoned review does not escalate to needs-human while a round is already ai:fixing, even if a clean codexResult is re-fetched', () => {
  // The escalation (`summonedReviewNeedsHuman`) is derived from `skipStaleCleanAfterSummonedInvalidation`,
  // which has no state gate of its own — only `codexConsumingStates.includes(s.state)` does.
  // Before this fix, a clean recognized-reviewer result re-fetched on any event (a CI tick,
  // another cron sweep) while a round was already `ai:fixing` (never a consuming state) would
  // still trip the escalation and yank the in-flight round straight to `ai:needs-human`.
  const fixing = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const cleanResult = { blocking: false, sha: 'sha1', findings: [], id: 100 };
  const { next } = reduce({ ...base, prev: fixing, codexResult: cleanResult, ci: 'success', summonedReviewId: 5 });
  assert.equal(next.state, 'ai:fixing', 'the round already in flight must not be interrupted');
  assert.equal(next.summonedDuringFix, 5, 'still latched — the head-change guard picks this up once the round concludes');
  assert.notEqual(next.handoff?.reason, 'summoned-review-no-thread');
});

test('#105 round-2 finding: a summoned review that arrives during ai:fixing is not lost when that round pushes', () => {
  const fixing = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const { next: latched } = reduce({ ...base, prev: fixing, codexResult: null, ci: 'pending', summonedReviewId: 5 });
  assert.equal(latched.state, 'ai:fixing');
  assert.equal(latched.summonedDuringFix, 5);

  // The round concludes by pushing — `latestSummonedReviewId` would now return null for
  // the old (stale) review, so this event carries no summonedReviewId at all, same as a
  // real synchronize/fix-result event would see.
  const { next, effects } = reduce({
    ...base, prev: latched, pr: { ...pr, headSha: 'sha2' }, codexResult: null, ci: 'pending', summonedReviewId: null,
  });
  assert.equal(next.state, 'ai:needs-human', 'must not silently resume automation on a finding the fixer never saw');
  assert.equal(next.handoff.reason, 'summoned-review-during-fix');
  assert.equal(next.summonedDuringFix, null, 'consumed, not left dangling');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
  assert.deepEqual(notifyKinds(effects), ['needs-human']);
});

test('#105 finding: an explicit dismissal before the next push clears the fix latch — no false handoff', () => {
  const fixing = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const { next: latched } = reduce({ ...base, prev: fixing, codexResult: null, ci: 'pending', summonedReviewId: 5 });
  assert.equal(latched.summonedDuringFix, 5);

  // The review is explicitly dismissed before the round pushes — the head is unchanged.
  // `summonedDuringFixDismissed` is the caller's raw-review-state confirmation of that
  // (P1 finding on #119) — plain `summonedReviewId == null` alone is no longer trusted here.
  const { next: dismissed } = reduce({
    ...base, prev: latched, codexResult: null, ci: 'pending', summonedReviewId: null, summonedDuringFixDismissed: true,
  });
  assert.equal(dismissed.state, 'ai:fixing', 'the round already in flight keeps running');
  assert.equal(dismissed.summonedDuringFix, null, 'the latch must clear once the review it guards is released');

  // The round now concludes by pushing — no stale latch left to force a false handoff.
  const { next, effects } = reduce({
    ...base, prev: dismissed, pr: { ...pr, headSha: 'sha2' }, codexResult: null, ci: 'pending', summonedReviewId: null,
  });
  assert.notEqual(next.state, 'ai:needs-human', 'the already-dismissed review must not force a handoff on push');
  assert.deepEqual(types(effects), ['request-codex']);
});

test('P1 finding on #119: a policy reclassification on an unchanged head must not be read as dismissal', () => {
  // A body-only summoned review (id 5) is latched during a round already in flight.
  const fixing = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const { next: latched } = reduce({ ...base, prev: fixing, codexResult: null, ci: 'pending', summonedReviewId: 5 });
  assert.equal(latched.summonedDuringFix, 5);

  // The head is unchanged, and `summonedReviewId` reports null this event — but NOT because
  // review 5 was dismissed: a base-branch policy edit reclassified its author out of the
  // summoned-actor set, so orchestrate.js's `allSummonedReviewsDismissed` correctly reports
  // false (the review is still standing, just no longer a "candidate"). Plain
  // `summonedReviewId == null` alone must not be read as release here.
  const { next: reclassified } = reduce({
    ...base, prev: latched, codexResult: null, ci: 'pending', summonedReviewId: null, summonedDuringFixDismissed: false,
  });
  assert.equal(reclassified.state, 'ai:fixing', 'the round already in flight keeps running');
  assert.equal(reclassified.summonedDuringFix, 5, 'the latch must survive a reclassification — the review was never actually dismissed');

  // The round now concludes by pushing — the still-real, unaddressed latch must hand off.
  const { next, effects } = reduce({
    ...base, prev: reclassified, pr: { ...pr, headSha: 'sha2' }, codexResult: null, ci: 'pending',
    summonedReviewId: null, summonedDuringFixDismissed: false,
  });
  assert.equal(next.state, 'ai:needs-human', 'the reclassified-but-undismissed review must still hand off, not vanish');
  assert.equal(next.handoff.reason, 'summoned-review-during-fix');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
});

test('#105 finding: dismissing the body-only review resumes automation from the summoned-review-no-thread handoff, as handoff.js promises', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const initialClean = { blocking: false, sha: 'sha1', findings: [], id: 10 };
  const ready = reduce({ ...base, prev, codexResult: initialClean, ci: 'success' }).next;

  const freshClean = { blocking: false, sha: 'sha1', findings: [], id: 100 };
  const needsHuman = reduce({
    ...base, prev: ready, codexResult: freshClean, ci: 'success', summonedReviewId: 42,
    summonedReviewUrl: 'https://github.com/o/r/pull/5#pullrequestreview-42',
  }).next;
  assert.equal(needsHuman.state, 'ai:needs-human');
  assert.equal(needsHuman.handoff.reason, 'summoned-review-no-thread');

  // The human follows the handoff's own instructions and dismisses the review on GitHub —
  // no /ai command, just a GitHub action. The head is unchanged; `summonedDuringFixDismissed`
  // is the caller's raw-review-state confirmation of the dismissal (P1 finding on #119).
  const { next, effects } = reduce({
    ...base, prev: needsHuman, codexResult: null, ci: 'success', summonedReviewId: null, summonedDuringFixDismissed: true,
  });
  assert.equal(next.state, 'ai:reviewing', 'must resume automation, not sit stuck at ai:needs-human forever');
  assert.equal(next.handoff.done, false);
  assert.equal(next.handoff.reason, null);
  assert.equal(next.summonedDuringFix, null);
  assert.ok(types(effects).includes('request-codex'));
});

test('a human still stuck at ai:needs-human for an unrelated reason is not silently resumed by a stray summonedDuringFix release', () => {
  // Guards the scoping of the dismissal-resume fix above: only the exact
  // summoned-review-no-thread handoff may be auto-cleared this way. A human parked at
  // ai:needs-human for a different, unrelated reason (e.g. ci-failing) must stay there
  // even if summonedDuringFix happens to be set and its review gets dismissed —only an
  // explicit /ai retry|fix may release a human latch for any other reason.
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human', summonedDuringFix: 42, handoff: { done: true, notified: true, reason: 'ci-failing' },
  };
  const { next } = reduce({
    ...base, prev: stuck, codexResult: null, ci: 'success', summonedReviewId: null, summonedDuringFixDismissed: true,
  });
  assert.equal(next.state, 'ai:needs-human', 'unrelated handoff must not be silently cleared');
  assert.equal(next.handoff.reason, 'ci-failing');
  assert.equal(next.summonedDuringFix, null, 'the stale latch itself still clears — only the state/handoff stays put');
});

test('#105 round-4 finding: a summoned review discovered the same event an unrelated blocking review dispatches a round is still latched', () => {
  const reviewing = reduce({ ...base, prev: null }).next; // ai:reviewing, review_floor 0
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }] };
  // Both land in one call: the summoned-review block re-queues first (state was not yet
  // `ai:fixing`), then the codexResult block — reading that freshly re-queued `ai:queued`
  // state — dispatches a round of its own, all within this single reduce().
  const { next: fixing } = reduce({
    ...base, prev: reviewing, codexResult, ci: 'pending', summonedReviewId: 7,
  });
  assert.equal(fixing.state, 'ai:fixing', 'the unrelated blocking review still dispatches a round');
  assert.equal(fixing.summonedDuringFix, 7, 'latched even though the summoned block itself only re-queued, not fixed');

  // That round concludes by pushing — the old summoned review is now stale by commit_id.
  const { next, effects } = reduce({
    ...base, prev: fixing, pr: { ...pr, headSha: 'sha2' }, codexResult: null, ci: 'pending', summonedReviewId: null,
  });
  assert.equal(next.state, 'ai:needs-human', 'the summoned finding must not vanish just because it coincided with an unrelated dispatch');
  assert.equal(next.handoff.reason, 'summoned-review-during-fix');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
  assert.deepEqual(notifyKinds(effects), ['needs-human']);
});

test('#105 round-5 finding: a THREADED summoned review is not latched, so a round dispatched to address its own open thread does not falsely hand off on push', () => {
  const reviewing = reduce({ ...base, prev: null }).next; // ai:reviewing, review_floor 0
  // The summoned review re-queues first (state was not yet `ai:fixing`); the local sweep's
  // own open-thread-block conversion then dispatches a round for that exact thread, all
  // within this single reduce() — mirrors the round-4 scenario but for a threaded review.
  const openThreadBlockResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }], openThreadBlock: true };
  const { next: fixing } = reduce({
    ...base, prev: reviewing, codexResult: openThreadBlockResult, ci: 'pending',
    summonedReviewId: 7, summonedReviewHasThread: true,
  });
  assert.equal(fixing.state, 'ai:fixing', 'the open-thread-block round still dispatches');
  assert.equal(fixing.summonedDuringFix, null, 'a threaded review needs no latch — its thread is durable memory');

  // That round concludes by pushing — the old summoned review is now stale by commit_id,
  // but its thread is untouched and will keep blocking a future clean scan on its own.
  const { next, effects } = reduce({
    ...base, prev: fixing, pr: { ...pr, headSha: 'sha2' }, codexResult: null, ci: 'pending', summonedReviewId: null,
  });
  assert.notEqual(next.state, 'ai:needs-human', 'must not falsely hand off — the round was dispatched for this exact thread');
  assert.deepEqual(types(effects), ['request-codex'], 'no spurious handoff effects — just the normal post-push re-review request');
});

test('#105 finding: a newer body-only summoned review hidden behind an older threaded one still latches, so it is not lost when the round pushes to address the older thread', () => {
  const reviewing = reduce({ ...base, prev: null }).next; // ai:reviewing, review_floor 0
  // Two summoned reviews stand at once: an older threaded one (id 7, reported by
  // `summonedReviewId`/`summonedReviewHasThread` per `latestSummonedReview`'s
  // oldest-wins selection) and a newer body-only one, invisible to both — only
  // `summonedReviewHasBodyOnlyPending` sees it.
  const openThreadBlockResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }], openThreadBlock: true };
  const { next: fixing } = reduce({
    ...base, prev: reviewing, codexResult: openThreadBlockResult, ci: 'pending',
    summonedReviewId: 7, summonedReviewHasThread: true, summonedReviewHasBodyOnlyPending: true,
  });
  assert.equal(fixing.state, 'ai:fixing', 'the open-thread-block round still dispatches');
  assert.equal(fixing.summonedDuringFix, 7, 'latched despite the reported review being threaded — a hidden body-only one is also standing');

  // That round concludes by pushing to address the older review's own thread — both
  // standing reviews are now stale by commit_id, and the newer body-only one had no
  // thread of its own to survive it.
  const { next, effects } = reduce({
    ...base, prev: fixing, pr: { ...pr, headSha: 'sha2' }, codexResult: null, ci: 'pending', summonedReviewId: null,
  });
  assert.equal(next.state, 'ai:needs-human', 'the hidden body-only finding must not vanish just because the round pushed for the older thread');
  assert.equal(next.handoff.reason, 'summoned-review-during-fix');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
  assert.deepEqual(notifyKinds(effects), ['needs-human']);
});

test('#105 round-4 finding: /ai retry does not drop a still-standing body-only summoned review whose id review_floor already covers', () => {
  const reviewing = reduce({ ...base, prev: null }).next; // ai:reviewing, review_floor 0
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }] };
  // Same co-occurrence as the round-4 scenario above: the re-queue that latches
  // `summonedDuringFix` also bumps `review_floor` to cover `summonedReviewId` in the same
  // event, so the top block's own `summonedReviewId > review_floor` re-latch condition can
  // never fire again for this id.
  const { next: fixing } = reduce({
    ...base, prev: reviewing, codexResult, ci: 'pending', summonedReviewId: 7,
  });
  assert.equal(fixing.state, 'ai:fixing');
  assert.equal(fixing.summonedDuringFix, 7);
  assert.equal(fixing.codex.review_floor, 7, 'review_floor already covers the summoned review id');

  // A human issues /ai retry while that round is still in flight — the summoned review is
  // still standing this same event, unrelated to whatever the retry is actually about.
  const { next: retried } = reduce({
    ...base, prev: fixing, humanCommand: { type: 'retry', id: 1 }, codexResult, ci: 'pending',
    summonedReviewId: 7,
  });
  assert.equal(retried.summonedDuringFix, 7, 'must survive the retry — the review is still standing, unaddressed');
  assert.equal(retried.state, 'ai:fixing', 'retry immediately re-dispatches on the still-standing blocking result');

  // Whatever round the retry dispatched concludes by pushing — the old summoned review is
  // now stale by commit_id, and the head-change guard must still catch it.
  const { next, effects } = reduce({
    ...base, prev: retried, pr: { ...pr, headSha: 'sha2' }, codexResult: null, ci: 'pending', summonedReviewId: null,
  });
  assert.equal(next.state, 'ai:needs-human', 'the summoned finding must not vanish just because /ai retry ran while it was still latched');
  assert.equal(next.handoff.reason, 'summoned-review-during-fix');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
});

test('#105 finding: /ai fix from the summoned-review-no-thread handoff clears the stale latch, so its own push does not bounce right back', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const initialClean = { blocking: false, sha: 'sha1', findings: [], id: 10 };
  const ready = reduce({ ...base, prev, codexResult: initialClean, ci: 'success' }).next;

  const freshClean = { blocking: false, sha: 'sha1', findings: [], id: 100 };
  const needsHuman = reduce({
    ...base, prev: ready, codexResult: freshClean, ci: 'success', summonedReviewId: 42,
    summonedReviewUrl: 'https://github.com/o/r/pull/5#pullrequestreview-42',
  }).next;
  assert.equal(needsHuman.state, 'ai:needs-human');
  assert.equal(needsHuman.handoff.reason, 'summoned-review-no-thread');
  assert.equal(needsHuman.summonedDuringFix, 42, 'latched by the escalation itself');

  // The human, responding to exactly this handoff, issues /ai fix. The review is still
  // standing (not dismissed) — orchestrate.js re-derives summonedReviewId on every run,
  // command events included, so this call carries it too, same as a real one would.
  const fixing = reduce({
    ...base, prev: needsHuman, humanCommand: { type: 'fix', id: 1 }, summonedReviewId: 42,
  }).next;
  assert.equal(fixing.state, 'ai:fixing');
  assert.equal(fixing.summonedDuringFix, null, 'the human is the round that sees this review — the stale latch must not survive /ai fix');

  // That round concludes by pushing — the old summoned review is stale by commit_id, and
  // no fresh one has arrived, so this must proceed normally, not bounce back to a human.
  const { next, effects } = reduce({
    ...base, prev: fixing, pr: { ...pr, headSha: 'sha2' }, codexResult: null, ci: 'pending', summonedReviewId: null,
  });
  assert.notEqual(next.state, 'ai:needs-human', 'must not immediately re-escalate the review the human just acted on');
  assert.deepEqual(types(effects), ['request-codex']);
});

test('#105 finding: /ai retry from the summoned-review-no-thread handoff does not drop the latch when an unrelated blocking codexResult is dispatched in the same event', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const initialClean = { blocking: false, sha: 'sha1', findings: [], id: 10 };
  const ready = reduce({ ...base, prev, codexResult: initialClean, ci: 'success' }).next;

  const freshClean = { blocking: false, sha: 'sha1', findings: [], id: 100 };
  const needsHuman = reduce({
    ...base, prev: ready, codexResult: freshClean, ci: 'success', summonedReviewId: 42,
    summonedReviewUrl: 'https://github.com/o/r/pull/5#pullrequestreview-42',
  }).next;
  assert.equal(needsHuman.state, 'ai:needs-human');
  assert.equal(needsHuman.handoff.reason, 'summoned-review-no-thread');
  assert.equal(needsHuman.summonedDuringFix, 42);

  // A human issues /ai retry — but an UNRELATED recognized-reviewer review is also
  // standing blocking in this same event (id 200, nothing to do with the summoned review
  // at 42). Unlike `/ai fix`, a bare retry never dispatches its own round directly — it
  // falls through to the codexResult-consuming block below, which dispatches for THAT
  // result's findings only. The summoned review's own body is never seen by this round.
  const unrelatedBlocking = { blocking: true, sha: 'sha1', findings: [{ id: 1 }], id: 200 };
  const { next: retried } = reduce({
    ...base, prev: needsHuman, humanCommand: { type: 'retry', id: 1 }, codexResult: unrelatedBlocking,
    ci: 'pending', summonedReviewId: 42,
  });
  assert.equal(retried.state, 'ai:fixing', 'retry immediately dispatches on the unrelated standing blocking result');
  assert.equal(retried.summonedDuringFix, 42, 'must survive — the dispatched round is for an unrelated finding, not this one');

  // That round concludes by pushing — the summoned review is now stale by commit_id, and
  // having never been passed to the fixer, it must hand off rather than vanish.
  const { next, effects } = reduce({
    ...base, prev: retried, pr: { ...pr, headSha: 'sha2' }, codexResult: null, ci: 'pending', summonedReviewId: null,
  });
  assert.equal(next.state, 'ai:needs-human', 'the summoned finding must not vanish just because retry dispatched an unrelated round');
  assert.equal(next.handoff.reason, 'summoned-review-during-fix');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
});

test('#115: latch survives an intermediate unrelated ai:needs-human between the round and the eventual push', () => {
  // A recognized-reviewer blocking result dispatches a fix round.
  const fixing = reduce({
    ...base, prev: null,
    codexResult: {
      blocking: true, sha: 'sha1', id: 5, findings: [{ id: 1 }], openThreadBlock: true,
    },
  }).next;
  assert.equal(fixing.state, 'ai:fixing');

  // While that round is in flight, a body-only summoned review (id 42) is detected — the
  // SAME event also reports the round's outcome as 'disputed' over an UNRELATED open
  // thread, so this routes to `agents-disagree`, not to the summoned review at all.
  const disputed = reduce({
    ...base, prev: fixing, codexResult: null, fixResult: { outcome: 'disputed' },
    openThreads: [{ path: 'a.js', comments: [{ author: 'normandy-garrus[bot]', body: 'still open' }] }],
    summonedReviewId: 42, summonedReviewHasThread: false,
  }).next;
  assert.equal(disputed.state, 'ai:needs-human');
  assert.equal(disputed.handoff.reason, 'agents-disagree', 'handed off for the unrelated dispute, not the summoned review');
  assert.equal(disputed.summonedDuringFix, 42, 'must survive the unrelated handoff — the summoned finding was never shown to a human');

  // The human pushes a fix for the unrelated dispute — nothing to do with the summoned
  // review, which is now stale by commit_id.
  const { next: pushed, effects } = reduce({
    ...base, prev: disputed, pr: { ...pr, headSha: 'sha2' }, pushedByHuman: true,
    codexResult: null, ci: 'pending', summonedReviewId: null,
  });
  assert.equal(pushed.state, 'ai:needs-human', 'the summoned finding must hand off, not vanish, once its review goes stale unaddressed');
  assert.equal(pushed.handoff.reason, 'summoned-review-during-fix');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);

  // A later clean scan + green CI on the new head must NOT reach ai:ready — the summoned
  // finding was never shown to a human and is unrecoverable (stale, no thread).
  const { next: afterClean } = reduce({
    ...base, prev: pushed, pr: { ...pr, headSha: 'sha2' },
    codexResult: {
      blocking: false, sha: 'sha2', id: 6, findings: [],
    },
    ci: 'success', summonedReviewId: null,
  });
  assert.notEqual(afterClean.state, 'ai:ready', 'must not silently promote — the summoned finding was never surfaced to a human');
});

test('#115: /ai fix from an unrelated handoff (agents-disagree) does not drop a still-standing summoned-review latch', () => {
  const fixing = reduce({
    ...base, prev: null,
    codexResult: {
      blocking: true, sha: 'sha1', id: 5, findings: [{ id: 1 }], openThreadBlock: true,
    },
  }).next;
  const disputed = reduce({
    ...base, prev: fixing, codexResult: null, fixResult: { outcome: 'disputed' },
    openThreads: [{ path: 'a.js', comments: [{ author: 'normandy-garrus[bot]', body: 'still open' }] }],
    summonedReviewId: 42, summonedReviewHasThread: false,
  }).next;
  assert.equal(disputed.handoff.reason, 'agents-disagree');
  assert.equal(disputed.summonedDuringFix, 42);

  // A human, responding to the UNRELATED dispute, issues /ai fix — the review at 42 is
  // still standing (not dismissed), so this must not be read as the human addressing it.
  const { next: fixingAgain } = reduce({
    ...base, prev: disputed, humanCommand: { type: 'fix', id: 1 }, summonedReviewId: 42,
  });
  assert.equal(fixingAgain.state, 'ai:fixing');
  assert.equal(fixingAgain.summonedDuringFix, 42, 'an /ai fix for an unrelated handoff must not silently clear a still-standing summoned review');

  // That round pushes — the summoned review is now stale by commit_id and never addressed.
  const { next, effects } = reduce({
    ...base, prev: fixingAgain, pr: { ...pr, headSha: 'sha2' }, codexResult: null, ci: 'pending', summonedReviewId: null,
  });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'summoned-review-during-fix');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
});

test('P1 finding on #119 round 4: /ai fix from an unrelated handoff must not clear the latch on a plain summonedReviewId == null without confirmed dismissal', () => {
  // Same reclassification gap as /ai retry and /ai refresh: `summonedReviewId` going null
  // is not on its own proof the review was dismissed — a base-policy edit can reclassify
  // its author out of the summoned-actor set instead. An `/ai fix` for an UNRELATED
  // handoff must require `summonedDuringFixDismissed` before treating that as release,
  // same as the other two commands, or it silently drops a still-standing finding the
  // human never actually addressed.
  const fixing = reduce({
    ...base, prev: null,
    codexResult: {
      blocking: true, sha: 'sha1', id: 5, findings: [{ id: 1 }], openThreadBlock: true,
    },
  }).next;
  const disputed = reduce({
    ...base, prev: fixing, codexResult: null, fixResult: { outcome: 'disputed' },
    openThreads: [{ path: 'a.js', comments: [{ author: 'normandy-garrus[bot]', body: 'still open' }] }],
    summonedReviewId: 42, summonedReviewHasThread: false,
  }).next;
  assert.equal(disputed.summonedDuringFix, 42);

  // A human, responding to the UNRELATED dispute, issues /ai fix while the summoned
  // review's author has just been reclassified out of the summoned-actor set (not
  // dismissed) — `summonedReviewId` reports null this event, `summonedDuringFixDismissed`
  // stays false.
  const { next: fixingAgain } = reduce({
    ...base, prev: disputed, humanCommand: { type: 'fix', id: 1 },
    summonedReviewId: null, summonedDuringFixDismissed: false,
  });
  assert.equal(fixingAgain.state, 'ai:fixing');
  assert.equal(fixingAgain.summonedDuringFix, 42, 'a reclassification is not a dismissal — the latch must survive');
});

test('#115: latch survives the fixer-failed branch too (no openThreads involved at all)', () => {
  const fixing = reduce({
    ...base, prev: null,
    codexResult: {
      blocking: true, sha: 'sha1', id: 5, findings: [{ id: 1 }], openThreadBlock: true,
    },
  }).next;
  const failed = reduce({
    ...base, prev: fixing, codexResult: null, fixResult: { outcome: 'failed', runUrl: 'https://x/run/1' },
    summonedReviewId: 42, summonedReviewHasThread: false,
  }).next;
  assert.equal(failed.handoff.reason, 'fixer-failed');
  assert.equal(failed.summonedDuringFix, 42, 'must survive the fixer-failed handoff too');

  const { next, effects } = reduce({
    ...base, prev: failed, pr: { ...pr, headSha: 'sha2' }, pushedByHuman: true, codexResult: null, ci: 'pending', summonedReviewId: null,
  });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'summoned-review-during-fix');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
});

test('P1 finding on #119: a dismissal that lands in the same event as the push must not force a false handoff', () => {
  // A body-only summoned review (id 42) is latched during a round already in flight.
  const fixing = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const latched = reduce({
    ...base, prev: fixing, codexResult: null, ci: 'pending', summonedReviewId: 42,
  }).next;
  assert.equal(latched.summonedDuringFix, 42);

  // The human dismisses review 42 AND pushes a fix before another synchronization runs —
  // a single event reports both the new head and (via orchestrate.js's own dismissal
  // check on review id 42, independent of headSha) the dismissal. Plain `summonedReviewId
  // == null` here is uninformative on its own: it would read the same way for an ordinary
  // ignored-then-pushed round, since the OLD review goes stale by commit_id regardless.
  const { next, effects } = reduce({
    ...base, prev: latched, pr: { ...pr, headSha: 'sha2' }, pushedByHuman: true,
    codexResult: null, ci: 'pending', summonedReviewId: null, summonedDuringFixDismissed: true,
  });
  assert.notEqual(next.state, 'ai:needs-human', 'the already-dismissed review must not force a handoff on push');
  assert.equal(next.summonedDuringFix, null);
  assert.ok(!types(effects).includes('request-human-review'));
});

test('P1 finding on #119: an un-dismissed latch still hands off when the dismissal flag is absent (default false)', () => {
  // Same setup as above, but the caller confirms nothing was dismissed (the default) —
  // the ordinary ignored-then-pushed handoff must still fire.
  const fixing = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1 };
  const latched = reduce({
    ...base, prev: fixing, codexResult: null, ci: 'pending', summonedReviewId: 42,
  }).next;
  assert.equal(latched.summonedDuringFix, 42);

  const { next, effects } = reduce({
    ...base, prev: latched, pr: { ...pr, headSha: 'sha2' }, pushedByHuman: true,
    codexResult: null, ci: 'pending', summonedReviewId: null,
  });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'summoned-review-during-fix');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
});

test('summoned review release: a no-op round with threads resolved (no push) lifts the block for a later clean codexResult', () => {
  // Codex review round 4 gap: `resolveReviewThread` touches neither `review.state` nor
  // the REST inline comments, so `summonedReviewId` keeps re-deriving the same id from
  // GitHub forever unless something records the resolution. `summoned_floor` is that
  // record — bumped by the same no-op-round-threads-resolved branch #73 already exercises.
  const prev = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:fixing', round: 1, roundOrigin: 'auto',
    codex: {
      requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'blocking',
      human_review_id: null, review_floor: 42, summoned_floor: 0,
    },
  };
  const openThreadBlockResult = { blocking: true, sha: 'sha1', id: 50, findings: [], openThreadBlock: true };
  const { next: resolved } = reduce({
    ...base, prev, codexResult: openThreadBlockResult, fixResult: { outcome: 'disputed' }, openThreads: [],
    summonedReviewId: 42, summonedReviewHasThread: true,
  });
  assert.equal(resolved.state, 'ai:reviewing', 're-queued for a fresh review of the same head');
  assert.equal(resolved.codex.summoned_floor, 42, 'the summoned review is now recorded as released');

  // A later event: the recognized reviewer posts fresh clean, and the summoned review
  // (id 42, never dismissed, no push) is STILL re-derived from GitHub as-is — must now
  // be consumed and promote to ai:ready, not discarded forever.
  const freshClean = { blocking: false, sha: 'sha1', findings: [], id: 60 };
  const { next, effects } = reduce({
    ...base, prev: resolved, codexResult: freshClean, ci: 'success', summonedReviewId: 42,
  });
  assert.equal(next.state, 'ai:ready', 'the released summoned review no longer blocks promotion');
  assert.deepEqual(notifyKinds(effects), ['ready']);
});

test('summoned review release: a body-only summoned review is NOT released by an unrelated no-op round', () => {
  // #105 round-2 finding: `openThreads.length === 0` only proves ITS thread resolved
  // when the summoned review actually opened one. A body-only `CHANGES_REQUESTED`
  // summoned review never opens a thread, so an unrelated open-thread-block round
  // finishing (its own, different threads resolved) must not look like this review
  // having been addressed — `summonedReviewHasThread: false` (the default) keeps
  // `summoned_floor` from advancing past it.
  const prev = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:fixing', round: 1, roundOrigin: 'auto',
    codex: {
      requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'blocking',
      human_review_id: null, review_floor: 42, summoned_floor: 0,
    },
  };
  const openThreadBlockResult = { blocking: true, sha: 'sha1', id: 50, findings: [], openThreadBlock: true };
  const { next: resolved } = reduce({
    ...base, prev, codexResult: openThreadBlockResult, fixResult: { outcome: 'disputed' }, openThreads: [],
    summonedReviewId: 42, summonedReviewHasThread: false,
  });
  assert.equal(resolved.state, 'ai:reviewing', 're-queued for a fresh review of the same head');
  assert.equal(resolved.codex.summoned_floor, 0, 'a body-only summoned review is not released by unrelated thread resolution');

  // A later event: the recognized reviewer posts fresh clean — the body-only summoned
  // review (id 42, never dismissed, no push) still stands and must keep blocking it. With
  // no thread for anything to ever resolve automatically, this now escalates to a human
  // rather than cycling ai:reviewing silently forever (#105 follow-up finding).
  const freshClean = { blocking: false, sha: 'sha1', findings: [], id: 60 };
  const { next, effects } = reduce({
    ...base, prev: resolved, codexResult: freshClean, ci: 'success', summonedReviewId: 42,
  });
  assert.equal(next.state, 'ai:needs-human', 'the unaddressed body-only finding still blocks ai:ready, now loudly');
  assert.equal(next.handoff.reason, 'summoned-review-no-thread');
  assert.deepEqual(notifyKinds(effects), ['needs-human']);
});

test('dry-run preview does not latch dedupe fields; activation replays the real effects', () => {
  const dryPolicy = parsePolicy('version: 1\nmode: dry-run\nauthors: ["tali[bot]"]\nhumans: [oleh]\n');
  const dryBase = { ...base, policy: dryPolicy };
  const requested = reduce({ ...dryBase, prev: null }).next;
  assert.equal(requested.codex.requested_sha, null, 'dry-run must not mark the request as sent');
  const stillPreviewing = reduce({ ...dryBase, prev: requested }).next;
  assert.deepEqual(types(reduce({ ...dryBase, prev: stillPreviewing }).effects), ['request-codex'], 'keeps re-narrating, never dedupes in dry-run');

  const activePolicy = parsePolicy('version: 1\nmode: active\nauthors: ["tali[bot]"]\nhumans: [oleh]\n');
  const { next: activated, effects } = reduce({ ...dryBase, policy: activePolicy, prev: stillPreviewing });
  assert.equal(activated.codex.requested_sha, 'sha1', 'activation fires the real request');
  assert.deepEqual(types(effects), ['request-codex']);
});

test('ai:ready reached during dry-run replays the notify once activated, then never again', () => {
  const dryPolicy = parsePolicy('version: 1\nmode: dry-run\nauthors: ["tali[bot]"]\nhumans: [oleh]\n');
  const dryBase = { ...base, policy: dryPolicy };
  const codexResult = { blocking: false, sha: 'sha1', findings: [] };
  const previewed = reduce({ ...dryBase, prev: null, codexResult, ci: 'success' }).next;
  assert.equal(previewed.state, 'ai:ready');
  assert.equal(previewed.readyNotified, false, 'dry-run must not mark the ping as sent');

  const activePolicy = parsePolicy('version: 1\nmode: active\nauthors: ["tali[bot]"]\nhumans: [oleh]\n');
  const { next: activated, effects } = reduce({ ...dryBase, policy: activePolicy, prev: previewed, codexResult, ci: 'success' });
  assert.equal(activated.readyNotified, true);
  assert.deepEqual(types(effects), ['notify']);
  assert.deepEqual(notifyKinds(effects), ['ready'], 'activation must retroactively send the missed ready ping');

  const replay = reduce({ ...base, prev: activated, codexResult, ci: 'success' });
  assert.deepEqual(types(replay.effects), [], 'already-notified ready state must not re-ping');
});

test('needs-human reached during dry-run replays both effects once activated, then never again', () => {
  const dryPolicy = parsePolicy('version: 1\nmode: dry-run\nauthors: ["tali[bot]"]\nhumans: [oleh]\n');
  const dryBase = { ...base, policy: dryPolicy };
  let s = reduce({ ...dryBase, prev: null }).next;
  s.round = policy.maxRounds;
  const codexResult = { blocking: true, sha: 'sha1', findings: [] };
  const previewed = reduce({ ...dryBase, prev: s, codexResult }).next;
  assert.equal(previewed.state, 'ai:needs-human');
  assert.equal(previewed.handoff.done, false, 'dry-run must not mark the request as sent');
  assert.equal(previewed.handoff.notified, false, 'dry-run must not mark the ping as sent');

  const { next: activated, effects } = reduce({ ...base, prev: previewed, codexResult });
  assert.equal(activated.handoff.done, true);
  assert.equal(activated.handoff.notified, true);
  assert.deepEqual(types(effects), ['request-human-review', 'notify'], 'activation replays the missed request + ping together');

  const replay = reduce({ ...base, prev: activated, codexResult });
  assert.deepEqual(types(replay.effects), [], 'already-handled needs-human state must not replay again');
});

test('needs-human: a failed/disabled Telegram send retries only the notify, not the review request', () => {
  // Simulates orchestrate.js's failed-delivery rollback: the review request already
  // succeeded (`done`), but Telegram delivery failed or is disabled, so only `notified`
  // was rolled back to false.
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human',
    handoff: { done: true, notified: false, reason: 'fixer-failed', runUrl: 'https://github.com/o/r/actions/runs/123' },
  };
  const { next, effects } = reduce({ ...base, prev: stuck, codexResult: null });
  assert.deepEqual(types(effects), ['notify'], 'must not re-issue request-human-review once it has already gone out');
  const notify = effects.find((e) => e.type === 'notify');
  assert.equal(notify.runUrl, 'https://github.com/o/r/actions/runs/123', 'the retried ping must still carry the run link');
  assert.equal(next.handoff.notified, true);
  assert.equal(next.handoff.done, true);
});

test('needs-human: a failed request-human-review retries only the request, not the notify (codex review round 2 finding on #1)', () => {
  // Mirror of the Telegram case above: orchestrate.js's rollback for a failed
  // requested_reviewers call resets only `done`, leaving an already-delivered
  // `notified: true` untouched. The replay block must not re-fire notify just because
  // `done` is false — that used to be an else-if chain assuming done/notified only ever
  // diverge the other way (Telegram-failed), so this combination re-sent the ping.
  const stuck = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human',
    handoff: { done: false, notified: true, reason: 'ci-failing' },
  };
  const { next, effects } = reduce({ ...base, prev: stuck, codexResult: null });
  assert.deepEqual(types(effects), ['request-human-review'], 'must not re-send an already-delivered ping');
  assert.equal(next.handoff.done, true);
  assert.equal(next.handoff.notified, true);
});

// --- Thread authority: contested/awaitingHuman handoffs, and the classifier's
// unanswered-threads relaxation at adjudicate/reviewer (docs/adr/0005) ---

const adjudicatePolicy = parsePolicy(
  'version: 1\nmode: active\nauthors: ["tali[bot]"]\nhumans: [oleh]\n'
  + 'backends: { reviewer: [local-agent], fixer: [claude-code-action] }\n'
  + 'reviewers:\n  actors: ["a", "b"]\n  vendors: { claude: ["a"], codex: ["b"] }\n  thread_authority: adjudicate\n',
);
const reviewerPolicy = { ...adjudicatePolicy, threadAuthority: 'reviewer' };
const adjBase = { ...base, policy: adjudicatePolicy };

test('contested review → reviewer-sustained handoff, no fix round dispatched', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [], contested: true };
  const { next, effects } = reduce({ ...base, prev, codexResult });
  assert.equal(next.state, 'ai:needs-human');
  // Distinct from agents-disagree (ADR-0009, #133/#137): that prose describes a no-push
  // round with a thread still open, neither of which is what happened here — the
  // reviewer re-adjudicated a push-back and sustained it.
  assert.equal(next.handoff.reason, 'reviewer-sustained');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
});

test('awaitingHuman review → awaiting-human-resolution handoff, no fix round dispatched', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [], awaitingHuman: true };
  const { next, effects } = reduce({ ...base, prev, codexResult });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'awaiting-human-resolution');
  assert.deepEqual(types(effects), ['request-human-review', 'notify']);
});

test('contested wins over awaitingHuman when both are set on the same review', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: false, sha: 'sha1', findings: [], contested: true, awaitingHuman: true };
  const { next } = reduce({ ...base, prev, codexResult });
  assert.equal(next.handoff.reason, 'reviewer-sustained');
});

test('contested/awaitingHuman still take priority over a blocking verdict from the same review', () => {
  const prev = reduce({ ...base, prev: null }).next;
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }], contested: true };
  const { next, effects } = reduce({ ...base, prev, codexResult });
  assert.equal(next.handoff.reason, 'reviewer-sustained');
  assert.deepEqual(types(effects), ['request-human-review', 'notify'], 'no dispatch-fixer — the dispute is handled first');
  assert.equal(next.round, 0, 'no fix round burned');
});

test('#133/#137 (ADR-0009): /ai retry on a standing blocking+contested review re-scans instead of re-deriving the same handoff', () => {
  // Same shape as the previous test (a genuine dispute: blocking review, sustained by
  // adjudication) — but this time a human has already typed /ai retry, distrusting the
  // latch. Must NOT bounce straight back to ai:needs-human within the same event.
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:needs-human', handoff: { done: true, notified: true, reason: 'reviewer-sustained' } };
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }], contested: true, id: 200 };
  const { next, effects } = reduce({
    ...base, prev, codexResult, humanCommand: { type: 'retry', id: 'c1' },
  });
  assert.equal(next.state, 'ai:reviewing', 'retry re-queues for a fresh review, not a re-derived handoff');
  assert.equal(next.handoff.reason, null);
  assert.deepEqual(types(effects), ['request-codex'], 'no request-human-review, no notify — the premature re-ping is what #133/#137 reported');
});

test('#137 (ADR-0009): /ai retry on a standing blocking+awaitingHuman review also re-scans', () => {
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:needs-human', handoff: { done: true, notified: true, reason: 'awaiting-human-resolution' } };
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }], awaitingHuman: true, id: 200 };
  const { next, effects } = reduce({
    ...base, prev, codexResult, humanCommand: { type: 'retry', id: 'c1' },
  });
  assert.equal(next.state, 'ai:reviewing');
  assert.equal(next.handoff.reason, null);
  assert.deepEqual(types(effects), ['request-codex']);
});

test('ADR-0009 scope: /ai retry on a plain (non-latched) blocking review still dispatches a fixer immediately', () => {
  // Pins that skipStaleCleanOnRetry's widening didn't overreach past the two latches —
  // a live, ordinary blocking finding is still trusted immediately on retry, unchanged.
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:needs-human', handoff: { done: true, notified: true, reason: 'round-limit' } };
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }], id: 200 };
  const { next, effects } = reduce({
    ...base, prev, codexResult, humanCommand: { type: 'retry', id: 'c1' },
  });
  assert.equal(next.state, 'ai:fixing');
  assert.deepEqual(types(effects), ['dispatch-fixer']);
});

test('#188: /ai retry off an agents-disagree handoff re-scans instead of re-dispatching the fixer on the same findings', () => {
  // Unlike the contested/awaitingHuman latches above, the review behind an
  // agents-disagree handoff is plain `blocking: true` with none of
  // escalate/contested/awaitingHuman set — it's the FIXER's own no-push dispute report,
  // reachable at the default `thread_authority: fixer` policy. Before this fix,
  // skipStaleCleanOnRetry had no exemption for it, so retry re-consumed the exact same
  // review and re-dispatched a fixer round against the exact same findings that already
  // produced the dispute — `/ai retry` did nothing.
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:needs-human', handoff: { done: true, notified: true, reason: 'agents-disagree' } };
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }], id: 200 };
  const { next, effects } = reduce({
    ...base, prev, codexResult, humanCommand: { type: 'retry', id: 'c1' },
  });
  assert.equal(next.state, 'ai:reviewing', 'retry re-queues for a fresh review, not a re-dispatched fixer round');
  assert.equal(next.handoff.reason, null);
  assert.deepEqual(types(effects), ['request-codex']);
});

test('#188: /ai retry off an agents-may-disagree handoff also re-scans instead of re-dispatching', () => {
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:needs-human', handoff: { done: true, notified: true, reason: 'agents-may-disagree' } };
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }], id: 200 };
  const { next, effects } = reduce({
    ...base, prev, codexResult, humanCommand: { type: 'retry', id: 'c1' },
  });
  assert.equal(next.state, 'ai:reviewing');
  assert.equal(next.handoff.reason, null);
  assert.deepEqual(types(effects), ['request-codex']);
});

test('#188: /ai retry off agents-disagree still dispatches on the SAME standing human review that produced the dispute', () => {
  // Same as the plain #188 case above, but the disputed round was dispatched by
  // consuming a human REQUEST_CHANGES review (agents-disagree isn't bot-review-only —
  // the fixer can dispute a human's findings too). The still-standing review is that
  // same human review (`reviewId` matches what's already recorded), so it must still be
  // treated as stale evidence and re-scanned, exactly like the bot-review case.
  const prev = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human',
    handoff: { done: true, notified: true, reason: 'agents-disagree' },
    codex: { requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'blocking', human_review_id: 100, review_floor: 0, summoned_floor: 0 },
  };
  const codexResult = { blocking: true, sha: 'sha1', source: 'human', reviewId: 100, id: 100, findings: [{ id: 1 }] };
  const { next, effects } = reduce({
    ...base, prev, codexResult, humanCommand: { type: 'retry', id: 'c1' },
  });
  assert.equal(next.state, 'ai:reviewing', 'the same disputed human review re-scans rather than re-dispatching');
  assert.deepEqual(types(effects), ['request-codex']);
});

test('#188 regression guard: /ai retry off agents-disagree still dispatches on a DIFFERENT, never-yet-consumed human review', () => {
  // The dispute-reason exemption must not swallow genuinely fresh human-actionable
  // evidence that happens to surface in the same event as the retry (e.g. a human
  // review whose own webhook was lost while the PR sat latched, first seen by this
  // retry's fresh GitHub fetch) — that review is not the one that produced the
  // standing dispute, and dropping it would be a silent loss.
  const prev = {
    ...reduce({ ...base, prev: null }).next,
    state: 'ai:needs-human',
    handoff: { done: true, notified: true, reason: 'agents-disagree' },
    codex: { requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'blocking', human_review_id: 100, review_floor: 0, summoned_floor: 0 },
  };
  const codexResult = { blocking: true, sha: 'sha1', source: 'human', reviewId: 300, id: 300, findings: [{ id: 1 }] };
  const { next, effects } = reduce({
    ...base, prev, codexResult, humanCommand: { type: 'retry', id: 'c1' },
  });
  assert.equal(next.state, 'ai:fixing', 'a genuinely different human review must still dispatch, not get floored as stale');
  assert.deepEqual(types(effects), ['dispatch-fixer']);
});

test('drift review on #1 round 4: /ai retry off a dispute, then an unrelated push, does not re-dispatch the same standing human review', () => {
  // Full 5-step sequence from the round-4 drift review: (1) human REQUEST_CHANGES
  // dispatches once, (2) the round disputes with no push, (3) /ai retry re-scans
  // instead of re-dispatching (the existing #188 guard just above), (4) an unrelated
  // push follows with the SAME review still standing (never dismissed) — this must not
  // re-derive as fresh and burn a second, uncapped dispatch. Before this fix, the retry
  // branch nulled `human_review_id` unconditionally even though it skipped consuming
  // the review this event, and the head-change block's `review_floor` reset (needed for
  // the summoned-review mechanism) offered no second guard — so step 4 re-consumed the
  // identical review and dispatched again.
  const dispatched = reduce({
    ...base, prev: null,
    codexResult: {
      blocking: true, sha: 'sha1', source: 'human', reviewId: 9, id: 9, findings: [{ id: 1 }],
    },
  }).next;
  assert.equal(dispatched.state, 'ai:fixing');
  assert.equal(dispatched.round, 1);
  assert.equal(dispatched.codex.human_review_id, 9);

  const disputed = reduce({
    ...base,
    prev: { ...dispatched, roundOrigin: 'auto' },
    codexResult: {
      blocking: true, sha: 'sha1', source: 'human', reviewId: 9, id: 9, findings: [{ id: 1 }],
    },
    fixResult: { outcome: 'disputed' },
    openThreads: [],
  }).next;
  assert.equal(disputed.state, 'ai:needs-human');
  assert.equal(disputed.handoff.reason, 'agents-may-disagree');

  const stillStandingAtRetry = {
    blocking: true, sha: 'sha1', source: 'human', reviewId: 9, id: 9, findings: [{ id: 1 }],
  };
  const retried = reduce({
    ...base, prev: disputed, codexResult: stillStandingAtRetry, humanCommand: { type: 'retry', id: 'c1' },
  }).next;
  assert.equal(retried.state, 'ai:reviewing', 'retry re-scans instead of re-dispatching on the same review');
  assert.equal(retried.round, 0);
  // The guard round 4 relies on: `human_review_id` survives the retry that skipped
  // consuming it, so it's still there to compare against on the next event.
  assert.equal(retried.codex.human_review_id, 9);

  const pushed = reduce({
    ...base, prev: retried, pr: { ...pr, headSha: 'sha2' }, codexResult: stillStandingAtRetry,
  }).next;
  assert.notEqual(pushed.state, 'ai:fixing', 'the same still-standing, never-dismissed review does not burn a second round');
  assert.equal(pushed.round, 0, 'no second dispatch means no second round increment');
});

test('classifier at fixer tier is byte-identical: a real-finding no-push round with zero open threads still hands off (agents-may-disagree), never re-queues', () => {
  const prev = { ...reduce({ ...base, prev: null }).next, state: 'ai:fixing', round: 1, roundOrigin: 'auto' };
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }] }; // no openThreadBlock
  const { next } = reduce({ ...base, prev, codexResult, fixResult: { outcome: 'disputed' }, openThreads: [] });
  assert.equal(next.state, 'ai:needs-human', 'fixer tier never re-queues a round the fixer wasn\'t dispatched to resolve threads for');
  assert.equal(next.handoff.reason, 'agents-may-disagree');
});

test('adjudicate tier: a real-finding push-back round with zero UNANSWERED threads re-queues for the reviewer\'s own adjudication', () => {
  const prev = { ...reduce({ ...adjBase, prev: null }).next, state: 'ai:fixing', round: 1, roundOrigin: 'auto' };
  const codexResult = { blocking: true, sha: 'sha1', id: 7, findings: [{ id: 1 }] }; // real finding, not an open-thread-block
  const { next, effects } = reduce({ ...adjBase, prev, codexResult, fixResult: { outcome: 'disputed' }, openThreads: [] });
  assert.equal(next.state, 'ai:reviewing', 're-queued instead of an immediate handoff — the fixer replied, adjudication gets the next look');
  assert.equal(next.handoff.done, false);
  assert.equal(next.fixer.outcome, 'no-change');
});

test('adjudicate tier: a thread the fixer has NOT replied to (still unanswered) still hands off immediately', () => {
  const prev = { ...reduce({ ...adjBase, prev: null }).next, state: 'ai:fixing', round: 1, roundOrigin: 'auto' };
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }] };
  // unansweredThreads' shape: last comment author is a reviewer/human voice, not the fixer.
  const openThreads = [{ path: 'a.js', comments: [{ author: 'b', body: 'still not fixed' }] }];
  const { next } = reduce({ ...adjBase, prev, codexResult, fixResult: { outcome: 'disputed' }, openThreads });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'agents-disagree');
});

test('adjudicate tier: a thread where a human spoke last (unanswered) still hands off immediately', () => {
  const prev = { ...reduce({ ...adjBase, prev: null }).next, state: 'ai:fixing', round: 1, roundOrigin: 'auto' };
  const codexResult = { blocking: true, sha: 'sha1', findings: [{ id: 1 }] };
  const openThreads = [{ path: 'a.js', comments: [{ author: 'oleh', body: 'pin the node engine' }] }];
  const { next } = reduce({ ...adjBase, prev, codexResult, fixResult: { outcome: 'disputed' }, openThreads });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'agents-disagree');
});

test('adjudicate/reviewer tier: an explicit /ai fix round still always hands off on no-push, never silently re-queues', () => {
  let s = { ...reduce({ ...adjBase, prev: null }).next, state: 'ai:ready', round: 0 };
  s = reduce({ ...adjBase, prev: s, humanCommand: { type: 'fix', id: 1 } }).next;
  assert.equal(s.roundOrigin, 'human');
  const codexResult = { blocking: true, sha: 'sha1', id: 42, findings: [{ id: 1 }] };
  const { next } = reduce({ ...adjBase, prev: s, codexResult, fixResult: { outcome: 'disputed' }, openThreads: [] });
  assert.equal(next.state, 'ai:needs-human', 'a human-dispatched round always reports back, at any tier');
  assert.equal(next.handoff.reason, 'agents-may-disagree');
});

test('reviewer tier: same relaxed classifier behavior as adjudicate (the field only changes who resolves, not the classifier)', () => {
  const prev = { ...reduce({ ...base, prev: null, policy: reviewerPolicy }).next, state: 'ai:fixing', round: 1, roundOrigin: 'auto' };
  const codexResult = { blocking: true, sha: 'sha1', id: 7, findings: [{ id: 1 }] };
  const { next } = reduce({ ...base, policy: reviewerPolicy, prev, codexResult, fixResult: { outcome: 'disputed' }, openThreads: [] });
  assert.equal(next.state, 'ai:reviewing');
});

test('#73 regression replayed at adjudicate tier: open-thread block resolved with nothing left open still re-queues, not a handoff', () => {
  const prev = {
    ...reduce({ ...adjBase, prev: null }).next, state: 'ai:fixing', round: 2, roundOrigin: 'auto',
    codex: { requested_sha: 'sha1', reviewed_sha: 'sha1', result: 'blocking', human_review_id: null, review_floor: 0 },
  };
  const codexResult = { blocking: true, sha: 'sha1', id: 4809124951, findings: [], openThreadBlock: true };
  const { next } = reduce({ ...adjBase, prev, codexResult, fixResult: { outcome: 'disputed' }, openThreads: [] });
  assert.equal(next.state, 'ai:reviewing', 'still not a dispute at this tier either');
  assert.equal(next.handoff.done, false);
});

// Loop-bound: a push-back round re-queues once; the tick after that must reach a
// terminal state (contested handoff, or resolved) rather than re-queueing forever. This
// is what the adjudication pass (the companion's review sweep) exists to guarantee — modeled here at
// the state-machine level by feeding the classifier a still-unanswered thread on the
// SECOND round, simulating "adjudication ran and sustained" rather than looping blind.
test('loop bound: adjudicate tier does not re-queue indefinitely — a still-unanswered thread on the next round hands off', () => {
  let s = { ...reduce({ ...adjBase, prev: null }).next, state: 'ai:fixing', round: 1, roundOrigin: 'auto' };
  const round1Result = { blocking: true, sha: 'sha1', id: 1, findings: [{ id: 1 }] };
  const afterRound1 = reduce({ ...adjBase, prev: s, codexResult: round1Result, fixResult: { outcome: 'disputed' }, openThreads: [] }).next;
  assert.equal(afterRound1.state, 'ai:reviewing', 'round 1 re-queues');

  // Adjudication ran (sustain) and the review is now contested — reduce() must hand off
  // here, not loop back into another re-queue.
  const adjudicationResult = { blocking: false, sha: 'sha1', findings: [], contested: true };
  const { next } = reduce({ ...adjBase, prev: afterRound1, codexResult: adjudicationResult });
  assert.equal(next.state, 'ai:needs-human');
  assert.equal(next.handoff.reason, 'reviewer-sustained');
});

test('describeHandoff: round-limit and agents-disagree list open threads', () => {
  const s = { round: 2, ci: { conclusion: 'success' }, handoff: { reason: 'round-limit' } };
  const threads = [{ path: 'a.js', comments: [{ author: 'codex', body: 'x'.repeat(250) }] }];
  const body = describeHandoff(s, threads);
  assert.match(body, /Open review threads \(1\)/);
  assert.match(body, /a\.js/);
  assert.match(body, /…"$/m); // truncated snippet ends with an ellipsis
  assert.equal(describeHandoff({ ...s, handoff: { reason: 'agents-disagree' } }, threads).includes('Open review threads'), true);
});

test('describeHandoff: a path carrying a backtick/newline cannot break out of its code span (round 4 finding on #1)', () => {
  const s = { round: 1, ci: { conclusion: 'success' }, handoff: { reason: 'round-limit' } };
  const threads = [{ path: 'src/x`\n## Approved', comments: [{ author: 'codex', body: 'x' }] }];
  const body = describeHandoff(s, threads);
  assert.doesNotMatch(body, /^## Approved/m, 'the forged heading never lands as its own top-level line');
  assert.doesNotMatch(body, /`\n/, 'no raw backtick immediately followed by a newline survives into the rendered path');
});

test('describeHandoff: shows total rounds alongside the episode count, falling back to round when rounds_total is absent', () => {
  const withTotal = describeHandoff({ round: 2, rounds_total: 11, ci: { conclusion: 'success' }, handoff: { reason: 'round-limit' } }, []);
  assert.match(withTotal, /\*\*Rounds attempted:\*\* 2 \(11 total on this PR\)/);
  const legacy = describeHandoff({ round: 2, ci: { conclusion: 'success' }, handoff: { reason: 'round-limit' } }, []);
  assert.match(legacy, /\*\*Rounds attempted:\*\* 2 \(2 total on this PR\)/);
  // #110's own motivating example (PR #105): the episode counter alone reads as if
  // nothing happened, while the total shows the real churn.
  assert.match(describeHandoff({ round: 1, rounds_total: 11, ci: { conclusion: 'success' }, handoff: { reason: 'round-limit' } }, []),
    /\*\*Rounds attempted:\*\* 1 \(11 total on this PR\)/);
});

test('describeHandoff: round-limit names the round-cap escape hatch', () => {
  const body = describeHandoff({ round: 2, rounds_total: 2, ci: { conclusion: 'success' }, handoff: { reason: 'round-limit' } }, []);
  assert.match(body, /\/ai round-cap N/);
});

test('renderComment: Round/Rounds total rows, with and without an effective cap', () => {
  const capped = { ...newState(5, 'sha1', 'active'), round: 2, rounds_total: 10, effective_cap: 4, cap: 4 };
  const cappedBody = renderComment(capped);
  assert.match(cappedBody, /\| Round \| 2 of 4 \(override\) \|/);
  assert.match(cappedBody, /\| Rounds total \| 10 \|/);

  // effective_cap present but no per-PR override (policy's own default) — no "(override)".
  const uncapped = { ...newState(5, 'sha1', 'active'), round: 1, rounds_total: 1, effective_cap: 2 };
  assert.match(renderComment(uncapped), /\| Round \| 1 of 2 \|/);
  assert.doesNotMatch(renderComment(uncapped), /override/);

  // No effective_cap: a raw state built without going through reduce() (e.g. newState()
  // directly, as many tests here do) — must still render, falling back to a bare count.
  const raw = newState(5, 'sha1', 'active');
  const rawBody = renderComment(raw);
  assert.match(rawBody, /\| Round \| 0 \|/);
  assert.match(rawBody, /\| Rounds total \| 0 \|/);
  assert.doesNotMatch(rawBody, /override/);
});

// #144/#203 (ADR 0012): "(human required)" would sit next to a gate reporting `success`
// once risk stopped gating `ai:ready` — reworded so it can't be read as a bug.
test('renderComment: humanRequired risk row reads as a display note, not "(human required)"', () => {
  const s = { ...newState(5, 'sha1', 'active'), state: 'ai:ready', risk: highRisk };
  const body = renderComment(s);
  assert.match(body, /\| Risk \| `high` \(policy flags this for human review\) \|/);
  assert.doesNotMatch(body, /\(human required\)/);
});

test('renderComment stays under GitHub\'s comment limit for a 3,000-file PR, and the state marker still parses (#224)', () => {
  const bigPolicy = parsePolicy('version: 1\nmode: active\nauthors: [a]\nhumans: [h]\nrisk:\n  human_required_paths: ["big/**"]\n');
  const files = Array.from({ length: 3000 }, (_, i) => ({ filename: `big/file-${i}.txt`, additions: 1, deletions: 0 }));
  const risk = classifyRisk(files, bigPolicy);

  const s = { ...newState(5, 'sha1', 'active'), risk };
  const body = renderComment(s);
  assert.ok(body.length <= 65536, `body is ${body.length} chars, over GitHub's limit`);
  assert.deepEqual(parseStateComment(body), s, 'the hidden state marker survives degrading the human-readable sections');
});

// #278: the policySanityWarnings dual cap (orchestrate.js's truncateWarnings) bounds
// that one field to ~60,000 chars on its own, but says nothing about the rest of the
// comment. A maxed policyWarnings block stacked on a maxed-out risk/history state can
// still clear 65,536 combined even though each piece is separately capped — this is
// what closes that gap: policyWarnings must be the last thing dropped, after risk
// reasons and history, not baked into the un-droppable `core`.
test('renderComment drops policy sanity warnings as a last resort when they combine with a maxed risk/history state to exceed the limit (#278)', () => {
  const s = {
    ...newState(5, 'sha1', 'active'),
    risk: {
      level: 'high',
      humanRequired: true,
      reasons: [
        `protected orchestration paths changed: ${'x'.repeat(1500)}`,
        `human-required paths changed: ${'y'.repeat(1500)}`,
        `dependency manifests changed (policy: human): ${'z'.repeat(1500)}`,
        'files changed 500 > max 100',
      ],
      causes: ['protected-path', 'configured-path', 'deps', 'size'],
    },
    history: Array.from({ length: 40 }, () => ({ t: '2026-01-01T00:00:00Z', event: 'transition', from: 'ai:queued', to: 'ai:reviewing' })),
  };
  // Just under orchestrate.js's 60,000-char policyWarnings cap on its own.
  const policyWarnings = Array.from({ length: 19 }, (_, i) => `glob \`nope-${i}/${'a'.repeat(3100)}/**\` matches no tracked files`);

  const body = renderComment(s, { policyWarnings });
  assert.ok(body.length <= 65536, `body is ${body.length} chars, over GitHub's limit`);
  assert.doesNotMatch(body, /Policy sanity/, 'policy warnings are the last-resort drop, not present once the combined body would otherwise exceed the limit');
  assert.deepEqual(parseStateComment(body), s, 'the hidden state marker survives dropping the policy sanity block');
});

test('describeHandoff: risk-requires-human states nothing is blocking', () => {
  const s = { round: 0, ci: { conclusion: 'success' }, handoff: { reason: 'risk-requires-human' } };
  const body = describeHandoff(s, []);
  assert.match(body, /No agent finding is open/);
  assert.doesNotMatch(body, /Open review threads/);
});

test('describeHandoff: fixer-failed shows the run link only when present', () => {
  const withUrl = describeHandoff({ round: 1, ci: { conclusion: null }, handoff: { reason: 'fixer-failed', runUrl: 'https://x/run/1' } }, []);
  assert.match(withUrl, /\*\*Failed run:\*\* https:\/\/x\/run\/1/);
  const withoutUrl = describeHandoff({ round: 1, ci: { conclusion: null }, handoff: { reason: 'fixer-failed' } }, []);
  assert.doesNotMatch(withoutUrl, /Failed run/);
});
