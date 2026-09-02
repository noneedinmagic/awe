export const REASONS = {
  'round-limit': {
    why: 'The automatic fix/re-review round limit was reached and Codex still reports blocking findings.',
    scope: 'Review the still-open threads below and decide: fix manually, raise this PR\'s budget with `/ai round-cap N` and resume, override, or close.',
  },
  'agents-disagree': {
    why: 'The fixer changed no code and at least one review thread it was dispatched for is still open — a definite dispute.',
    scope: 'Read the inline threads below: each has a Codex finding and a Claude rebuttal with evidence. Arbitrate.',
  },
  'agents-may-disagree': {
    why: 'The fixer changed no code and left no open threads. It may have addressed the findings in replies, or disputed them — the record cannot tell which.',
    scope: 'Read the fixer\'s replies and the review body findings, then decide.',
  },
  'reviewer-sustained': {
    why: 'The reviewer re-adjudicated the fixer\'s push-back against current code and sustained its finding (ADR-0005).',
    scope: 'You are overruling a judgement the reviewer already re-verified, not just re-litigating an old one — read the thread and rule, or `/ai fix` to hand it back with new instructions.',
  },
  'fixer-failed': {
    why: 'The Claude fix job failed or timed out.',
    scope: 'Check the failed workflow run below, then re-trigger by pushing or re-running the job.',
  },
  'fixer-skipped': {
    why: 'The fix job was skipped without running: claude-code-action refuses to run when the PR changes the workflow file the run itself came from, so no fix was attempted.',
    scope: 'Comment `/ai retry` — a comment-triggered run uses the default branch\'s workflow file and is not affected — or fix manually.',
  },
  'ci-failing': {
    why: 'CI has failed repeatedly (threshold reached).',
    scope: 'Inspect the failing checks; the loop will not resume until a new push goes green.',
  },
  // #144/#203: no longer emitted (risk stopped gating `ai:ready` — see state.js's
  // promotion logic). Kept so a PR already latched on this reason from before that
  // change still renders its sticky comment/handoff text correctly.
  'risk-requires-human': {
    why: 'No agent finding is open — Codex review is clean and CI is green. This handoff exists purely because the change is classified medium/high risk (or touches human-required paths) by policy.',
    scope: 'Normal human review of the diff, then merge; risk reasons are listed above. Nothing further is blocking.',
  },
  'unparseable-review': {
    why: 'A Codex review arrived but could not be interpreted; refusing to guess "clean".',
    scope: 'Read the Codex review directly and decide manually.',
  },
  'local-reviewer-escalation': {
    why: 'The local-agent reviewer CLI failed repeatedly on this head (crashed or produced unparseable output); there are no findings for the fixer to act on.',
    scope: 'Check the local-agent sweep log on its host for the underlying CLI failure, then re-trigger by pushing.',
  },
  'awaiting-human-resolution': {
    why: 'The reviewer withdrew a finding or could not determine your intent on a thread you commented in, and thread_authority does not let it resolve or re-raise that thread without you.',
    scope: 'Read the reviewer\'s reply on the flagged thread(s) below and resolve them yourself once satisfied.',
  },
  'summoned-review-during-fix': {
    why: 'A human-summoned `@codex review` / `@claude review` arrived while a fix round was already in flight. The round was not interrupted, and it then pushed — the review is now stale for automation (a new head) with no thread to recover it, so its finding was never addressed.',
    scope: 'Check the PR\'s review history for a summoned review submitted during the last fix round and decide whether it still applies to the current diff; re-summon the reviewer if so.',
  },
  'summoned-review-no-thread': {
    why: 'A human-summoned `@codex review` / `@claude review` left a body-only `CHANGES_REQUESTED` finding (a general comment, not anchored to a line) that automation has no path to resolve on its own: with no inline comment, there is no thread to convert into blocking evidence for a fix round, so the PR would otherwise sit silently re-requesting review forever.',
    scope: 'Read the standing review linked below. If it applies, push a fix; if not, dismiss the review on GitHub. Either releases the block.',
  },
};

const SNIPPET_LEN = 200;

function formatThread(t) {
  const first = t.comments?.[0];
  const author = first?.author ? `@${first.author}` : '(unknown)';
  const snippet = (first?.body ?? '').slice(0, SNIPPET_LEN).replace(/\s+/g, ' ').trim();
  const extra = t.comments.length - 1;
  // A later reply in the thread (e.g. a human's own agreeing reply) is easy to miss —
  // name the latest replier so it isn't sitting there unused, unseen (incident #40).
  const repliesNote = extra > 0
    ? ` (+${extra} repl${extra === 1 ? 'y' : 'ies'}, latest @${t.comments.at(-1)?.author ?? 'unknown'})`
    : '';
  return `- \`${t.path ?? '(unknown path)'}\` — ${author}: "${snippet}${(first?.body ?? '').length > SNIPPET_LEN ? '…' : ''}"${repliesNote}`;
}

/** Human handoff block rendered inside the sticky comment. */
export function describeHandoff(state, threads = []) {
  const info = REASONS[state.handoff.reason] ?? { why: state.handoff.reason, scope: 'See history above.' };
  const lines = [
    '### 🙋 Human decision needed',
    '',
    `**Why automation stopped:** ${info.why}`,
    `**Rounds attempted:** ${state.round} (${state.rounds_total ?? state.round} total on this PR)`,
    `**CI:** ${state.ci.conclusion ?? 'unknown'}`,
    `**Recommended scope:** ${info.scope}`,
  ];
  if (state.handoff.runUrl) {
    // `runUrl` triples as the failed/skipped workflow run link (fixer-failed,
    // fixer-skipped) and the standing review link (agents-may-disagree, whose thread
    // list below is empty by construction — see REASONS above — so this is the only
    // thing to click).
    const label = state.handoff.reason === 'fixer-failed' ? 'Failed run'
      : state.handoff.reason === 'fixer-skipped' ? 'Skipped run' : 'Standing review';
    lines.push(`**${label}:** ${state.handoff.runUrl}`);
  }
  if (threads.length) {
    lines.push('', `**Open review threads (${threads.length}):**`, '', ...threads.map(formatThread));
  }
  return lines.join('\n');
}
