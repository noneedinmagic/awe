import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate } from '../scripts/lib/gate.js';
import { newState } from '../scripts/lib/state.js';

const policy = (mode) => ({ mode, merge: { autoMerge: false }, maxRounds: 2 });
const state = (s, over = {}) => ({
  ...newState(1, 'abcdef1234567890', 'active'), state: s,
  handoff: { done: s === 'ai:needs-human', reason: 'round-limit' }, ...over,
});

test('dry-run is always neutral — never enforces', () => {
  for (const s of ['ai:queued', 'ai:ready', 'ai:needs-human', 'ai:failed']) {
    const g = evaluateGate(state(s), policy('dry-run'));
    assert.deepEqual([g.status, g.conclusion], ['completed', 'neutral']);
  }
});

test('ready → success, but summary states human merge still required', () => {
  const g = evaluateGate(state('ai:ready'), policy('active'));
  assert.equal(g.conclusion, 'success');
  assert.match(g.summary, /human merge required/);
});

// #144/#203 (ADR 0012): `ai:ready` is the AI axis only — a medium/high-risk PR still
// concludes `success` once it reaches this state, and the title no longer claims "low
// risk". The summary's `base` line still states whatever risk level the PR carries.
test('ready → success regardless of risk level; title drops "low risk"', () => {
  const g = evaluateGate(state('ai:ready', { risk: { level: 'high', humanRequired: true, reasons: ['auth touched'] } }), policy('active'));
  assert.equal(g.conclusion, 'success');
  assert.doesNotMatch(g.title, /low risk/);
  assert.match(g.summary, /risk `high`/);
});

test('needs-human → action_required with reason in title', () => {
  const g = evaluateGate(state('ai:needs-human'), policy('active'));
  assert.equal(g.conclusion, 'action_required');
  assert.match(g.title, /round-limit/);
});

test('failed → failure; in-flight states → in_progress with no conclusion', () => {
  assert.equal(evaluateGate(state('ai:failed'), policy('active')).conclusion, 'failure');
  const g = evaluateGate(state('ai:reviewing'), policy('active'));
  assert.equal(g.status, 'in_progress');
  assert.equal(g.conclusion, undefined);
});

test('in-progress summaries explain what is happening and roughly how long — this check has no logs, so this text is the only visibility', () => {
  const queued = evaluateGate(state('ai:queued'), policy('active'));
  assert.match(queued.summary, /About to request a review/);

  const waiting = evaluateGate(
    state('ai:reviewing', { codex: { requested_sha: 'abcdef1234567890', reviewed_sha: null, result: null } }),
    policy('active'),
  );
  assert.match(waiting.summary, /every 2 minutes/);

  const cleanPendingCi = evaluateGate(
    state('ai:reviewing', { codex: { requested_sha: 'abcdef1234567890', reviewed_sha: 'abcdef1234567890', result: 'clean' } }),
    policy('active'),
  );
  assert.match(cleanPendingCi.summary, /waiting on CI/);

  const fixing = evaluateGate(state('ai:fixing', { round: 1 }), policy('active'));
  assert.match(fixing.summary, /round 1 of 2/);
  assert.match(fixing.summary, /30-minute timeout/);
});
