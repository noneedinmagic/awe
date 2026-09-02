export const GATE_NAME = 'AI Policy Gate';

/**
 * Deterministic gate: maps durable state to a check-run payload. Agents never
 * set this — they only produce the evidence recorded in `state`.
 * @returns {{status: 'completed'|'in_progress', conclusion?: string, title: string, summary: string}}
 */
export function evaluateGate(state, policy) {
  // Uses state.effective_cap (the resolved per-PR override / AI_ORCH_MAX_ROUNDS / policy
  // value reduce() stamps every call) rather than policy.maxRounds directly — the
  // ai:needs-human summary below (round-limit's own gate text) never calls
  // inProgressDetail, so this is the only place that reason would otherwise show a bare
  // round count with no cap to compare it against.
  const base = `state \`${state.state}\`, risk \`${state.risk?.level ?? '?'}\`, head \`${state.head_sha.slice(0, 12)}\`, round ${state.round} of ${state.effective_cap ?? policy.maxRounds}`;

  if (policy.mode === 'dry-run') {
    return { status: 'completed', conclusion: 'neutral', title: 'Dry run — not enforcing', summary: `Would report: ${base}` };
  }
  if (policy.mode === 'disabled') {
    return { status: 'completed', conclusion: 'neutral', title: 'Disabled by policy', summary: base };
  }
  switch (state.state) {
    case 'ai:ready':
      // #144/#203: title dropped "low risk" — `ai:ready` is the AI axis only now (clean
      // review, green CI); risk no longer gates it. `base` already states the risk level
      // for whoever reads the Checks tab.
      return {
        status: 'completed', conclusion: 'success', title: 'Ready — clean review, green CI',
        summary: `${base}. Auto-merge is ${policy.merge.autoMerge ? 'enabled' : 'disabled'}; human merge required.`,
      };
    case 'ai:needs-human':
      return {
        status: 'completed', conclusion: 'action_required', title: `Human decision needed (${state.handoff.reason})`,
        summary: base,
      };
    case 'ai:failed':
      return { status: 'completed', conclusion: 'failure', title: 'Orchestrator failed', summary: base };
    default:
      return { status: 'in_progress', title: `In progress — ${state.state}`, summary: `${base}. ${inProgressDetail(state, policy)}` };
  }
}

// This check has no underlying job/runner/logs — it's an API-created status, so this
// summary text is the ONLY place a human glancing at the Checks tab learns what's
// actually happening and roughly how long to expect it to take.
function inProgressDetail(state, policy) {
  if (state.state === 'ai:queued') return 'About to request a review for this head.';
  if (state.state === 'ai:reviewing') {
    if (state.codex.result === 'clean') return 'Review is clean — waiting on CI to go green before marking ready.';
    if (state.codex.requested_sha === state.head_sha) {
      return 'Waiting on a review for this head — the local-agent sweep checks roughly every 2 minutes; a cloud-mentioned reviewer (if configured) may take longer.';
    }
    return 'Re-evaluating after the latest event.';
  }
  if (state.state === 'ai:fixing') {
    return `Claude is implementing round ${state.round} of ${state.effective_cap ?? policy.maxRounds} — usually a few minutes once dispatched, up to the job's 30-minute timeout.`;
  }
  return 'Orchestrator is processing this event.';
}
